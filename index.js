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

// Переменная для хранения промпта в памяти
let SYSTEM_PROMPT = null;

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send(`Bot PID ${PID} is running`));
app.get('/health', (req, res) => res.json({ status: 'ok', pid: PID, uptime: process.uptime() }));

const server = app.listen(PORT, () => {
    console.log(`[PID:${PID}] ✅ HTTP server listening on port ${PORT}`);
});

const bot = new Telegraf(config.telegram.token);

bot.catch((err, ctx) => {
    console.error(`[PID:${PID}] 🚨 Глобальная ошибка Telegraf:`, err.message);
});

// --- Команда /reload ---
bot.command('reload', async (ctx) => {
    const adminGroupId = Number(config.telegram.adminGroupId);
    if (Number(ctx.chat.id) !== adminGroupId) return;
    
    console.log(`[PID:${PID}] 🔄 Запрос на обновление промпта...`);
    const newPrompt = await db.getConfig('system_prompt');
    
    if (!newPrompt) {
        return ctx.reply('❌ Ошибка: system_prompt не найден в БД');
    }
    
    SYSTEM_PROMPT = newPrompt;
    ctx.reply(`✅ Промпт обновлён! Новая длина: ${SYSTEM_PROMPT.length} симв.`);
});

bot.on('message', async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let messageText = ctx.message?.text || null;

    if (ctx.message?.voice) {
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
            const response = await fetch(fileLink.href);
            const buffer = await response.arrayBuffer();
            const tmpPath = path.join(tmpdir(), `voice_${userId}_${Date.now()}.oga`);
            
            fs.writeFileSync(tmpPath, Buffer.from(buffer));
            messageText = await llm.transcribe(tmpPath);
            fs.unlinkSync(tmpPath);
        } catch (e) {
            console.error(`[PID:${PID}] ❌ Ошибка транскрипции:`, e.message);
            return await ctx.reply('Не смог распознать голосовое.');
        }
    }

    if (!messageText) return;

    try {
        let userTopic = await db.getTopic(userId);

        if (!userTopic) {
            const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: ctx.from.username || 'n/a',
                first_name: ctx.from.first_name
            });
        }

        await ctx.telegram.sendMessage(adminGroupId, `👤 <b>${ctx.from.first_name}:</b> ${messageText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        if (messageText === '/start') return;

        const OVERRIDE_TIMEOUT_MS = 10 * 60 * 1000;
        const overrideExpired = userTopic.admin_override_at && 
            (Date.now() - new Date(userTopic.admin_override_at).getTime()) > OVERRIDE_TIMEOUT_MS;

        if (userTopic.admin_override && !overrideExpired) return;

        const fullHistory = await db.getHistory(userId);
        const history = fullHistory.slice(-6);

        const model = llm.selectModel(messageText, history.length / 2, history);
        const aiResult = await llm.ask(model, SYSTEM_PROMPT, history, messageText);
        
        const replyText = aiResult.text;
        
        // Лог для проверки типа и содержания ответа
        console.log(`[PID:${PID}] 🔍 replyText type: ${typeof replyText}, value: "${replyText}"`);
        
        await ctx.reply(replyText);

        await ctx.telegram.sendMessage(adminGroupId, `🤖 <b>AI [${aiResult.model}]:</b> ${replyText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        await db.logMessage({
            user_id: userId,
            message_text: messageText,
            bot_response: replyText,
            model_used: aiResult.model,
            cost_usd: aiResult.cost
        });

    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка обработчика:`, e.message);
        await ctx.reply('Извините, техническая ошибка.');
    }
});

const startBot = async () => {
    try {
        console.log(`[PID:${PID}] 📥 Загружаю SYSTEM_PROMPT из Supabase...`);
        SYSTEM_PROMPT = await db.getConfig('system_prompt');

        if (!SYSTEM_PROMPT) {
            throw new Error('Критическая ошибка: SYSTEM_PROMPT не найден!');
        }
        
        console.log(`[PID:${PID}] ✅ Конфиг загружен. Длина промпта: ${SYSTEM_PROMPT.length} симв.`);
        
        console.log(`[PID:${PID}] 🔄 Удаляю вебхук (таймаут 5с)...`);
        
        // Защита от бесконечного зависания deleteWebhook
        try {
            await Promise.race([
                bot.telegram.deleteWebhook({ drop_pending_updates: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('deleteWebhook timeout')), 5000))
            ]);
            console.log(`[PID:${PID}] ✅ Вебхук удалён.`);
        } catch (webhookError) {
            console.warn(`[PID:${PID}] ⚠️ Предупреждение по вебхуку: ${webhookError.message}. Идем дальше...`);
        }
        
        console.log(`[PID:${PID}] 🚀 Запускаю bot.launch()...`);
        
        // Fire-and-forget запуск без await, чтобы не блокировать процесс
        bot.launch().catch(err => {
            console.error(`[PID:${PID}] ❌ bot.launch() упал:`, err.message);
            process.exit(1);
        });
        
        console.log(`[PID:${PID}] ✅ Бот успешно запущен`);
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка запуска:`, err.message);
        process.exit(1);
    }
};

startBot();