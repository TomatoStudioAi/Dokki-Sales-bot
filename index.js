import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const PID = process.pid;

const SYSTEM_PROMPT = `Ты — AI-ассистент агентства TomatoStudio. Агентство специализируется на digital-рекламе: таргет, контекст, SMM, SEO, разработка сайтов. Работаем с бизнесом в Казахстане. Ты общаешься с потенциальными клиентами в Telegram. Твоя задача: выяснить потребности клиента, рассказать об услугах, квалифицировать лид и довести до созвона с командой. Отвечай на том языке, на котором пишет клиент. Будь дружелюбным и профессиональным. Без воды — только по делу. Цены обсуждай в тенге (₸).`;

// 1. HTTP-сервер для Railway Healthcheck
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send(`Bot PID ${PID} is running`));
app.get('/health', (req, res) => res.json({ status: 'ok', pid: PID, uptime: process.uptime() }));

const server = app.listen(PORT, () => {
    console.log(`[PID:${PID}] ✅ HTTP server listening on port ${PORT}`);
});

// 2. Инициализация бота
const bot = new Telegraf(config.telegram.token);

bot.catch((err, ctx) => {
    console.error(`[PID:${PID}] 🚨 Глобальная ошибка Telegraf:`, err.message);
});

bot.on('message', async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    // Сообщения из админ-группы → обработчик админа
    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let messageText = ctx.message?.text || null;

    // 3. Обработка голосовых сообщений
    if (ctx.message?.voice) {
        try {
            console.log(`[PID:${PID}] 🎙️ Голосовое от ${userId}, транскрибирую...`);
            const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
            const response = await fetch(fileLink.href);
            const buffer = await response.arrayBuffer();
            const tmpPath = path.join(tmpdir(), `voice_${userId}_${Date.now()}.oga`);
            
            fs.writeFileSync(tmpPath, Buffer.from(buffer));
            messageText = await llm.transcribe(tmpPath);
            fs.unlinkSync(tmpPath);
            
            console.log(`[PID:${PID}] ✅ Транскрипция: "${messageText}"`);
        } catch (e) {
            console.error(`[PID:${PID}] ❌ Ошибка транскрипции:`, e.message);
            return await ctx.reply('Не смог распознать голосовое. Напишите текстом, пожалуйста.');
        }
    }

    if (!messageText) return;

    console.log(`[PID:${PID}] 📥 Сообщение от ${userId}: ${messageText}`);

    try {
        // Получаем или создаём топик
        let userTopic = await db.getTopic(userId);

        if (!userTopic) {
            console.log(`[PID:${PID}] 🆕 Создаю топик для ${ctx.from.first_name}`);
            const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: ctx.from.username || 'n/a',
                first_name: ctx.from.first_name
            });
        }

        // Зеркалируем сообщение клиента в топик
        await ctx.telegram.sendMessage(adminGroupId, `👤 <b>${ctx.from.first_name}:</b> ${messageText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // Если диалог перехвачен админом — ИИ молчит (с таймаутом 10 минут)
        const OVERRIDE_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут
        const overrideExpired = userTopic.admin_override_at && 
            (Date.now() - new Date(userTopic.admin_override_at).getTime()) > OVERRIDE_TIMEOUT_MS;

        if (userTopic.admin_override && !overrideExpired) {
            console.log(`[PID:${PID}] 🔇 admin_override для ${userId}, ИИ молчит`);
            return;
        }

        // 2. Работа с истории и выбор модели
        const history = await db.getHistory(userId);
        const messageCount = history.length / 2;
        const model = llm.selectModel(messageText, messageCount, history);

        console.log(`[PID:${PID}] 🤖 Модель: ${model}, сообщений в истории: ${messageCount}`);

        // Запрос к LLM
        const aiResult = await llm.ask(model, SYSTEM_PROMPT, history, messageText);
        const replyText = aiResult.text;

        // Отвечаем клиенту
        await ctx.reply(replyText);

        // Зеркалируем ответ ИИ в топик (с указанием модели)
        await ctx.telegram.sendMessage(adminGroupId, `🤖 <b>AI-ассистент [${aiResult.model}]:</b> ${replyText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // 4. Логируем в БД
        await db.logMessage({
            user_id: userId,
            message_text: messageText,
            bot_response: replyText,
            model_used: aiResult.model,
            cost_usd: aiResult.cost
        });

    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка обработчика:`, e.message);
        await ctx.reply('Извините, техническая ошибка. Менеджер уже уведомлён.');
    }
});

// 3. Graceful Shutdown (Таймаут 3 секунды)
let isShuttingDown = false;

const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[PID:${PID}] ⚠️ ${signal} получен, завершаю...`);

    const forceExitTimer = setTimeout(() => {
        console.error(`[PID:${PID}] ❌ Таймаут shutdown, принудительный выход`);
        process.exit(1);
    }, 3000);

    try {
        await bot.stop(signal);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        clearTimeout(forceExitTimer);
        console.log(`[PID:${PID}] ✅ Завершён корректно`);
        process.exit(0);
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка shutdown:`, err.message);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// 4. Запуск
const startBot = async () => {
    try {
        console.log(`[PID:${PID}] 🔧 Удаляю webhook...`);
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log(`[PID:${PID}] ⏳ Жду 7 секунд...`);
        await new Promise(resolve => setTimeout(resolve, 7000));
        
        await bot.launch();
        console.log(`[PID:${PID}] ✅ Бот запущен`);
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка запуска:`, err.message);
        process.exit(1);
    }
};

startBot();