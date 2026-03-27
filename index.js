import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/database.js'; 
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const PID = process.pid;
let SYSTEM_PROMPT = "Ты — AI-ассистент Dokki Business. Помогай клиентам профессионально."; // Дефолт на случай сбоя

const bot = new Telegraf(config.telegram.token);
const app = express();
const PORT = process.env.PORT || 3000;

// Настройка Express для Railway
app.get('/', (req, res) => res.send(`Bot PID ${PID} is running`));
app.get('/health', (req, res) => res.json({ status: 'ok', pid: PID, uptime: process.uptime() }));

app.use(bot.webhookCallback('/webhook'));

const server = app.listen(PORT, () => {
    console.log(`[PID:${PID}] ✅ HTTP server listening on port ${PORT}`);
});

bot.catch((err, ctx) => {
    console.error(`[PID:${PID}] 🚨 Глобальная ошибка Telegraf:`, err.message);
});

// --- КОМАНДЫ ---

bot.command('reload', async (ctx) => {
    const adminGroupId = Number(config.telegram.adminGroupId);
    if (Number(ctx.chat.id) !== adminGroupId) return;
    
    console.log(`[PID:${PID}] 🔄 Запрос на обновление промпта...`);
    const newPrompt = await db.getConfig('system_prompt');
    
    if (newPrompt) {
        SYSTEM_PROMPT = newPrompt;
        ctx.reply(`✅ Промпт обновлён! Новая длина: ${SYSTEM_PROMPT.length} симв.`);
    } else {
        ctx.reply('❌ Ошибка: промпт не найден в БД.');
    }
});

bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[PID:${PID}] 🚀 Инициализация /start для ${userId}`);

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
        
        await ctx.reply('Здравствуйте! Вас приветствует Dokki Business. 🍅 Рады, что вы обратились к нам! Расскажите подробнее о вашем проекте: что именно вас интересует?');
        
    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка в команде /start:`, e.message);
    }
});

// --- ОСНОВНОЙ ОБРАБОТЧИК ---

bot.on('message', async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let messageText = ctx.message?.text || null;

    // 1. ПЕРЕХВАТ ФАЙЛОВ
    if (ctx.message?.document || ctx.message?.photo || ctx.message?.video || ctx.message?.audio) {
        try {
            const topic = await db.getTopic(userId);
            const topicId = topic ? topic.topic_id : config.telegram.alertsTopicId;

            await ctx.forwardMessage(adminGroupId, { message_thread_id: topicId });

            if (ctx.message.caption) {
                messageText = ctx.message.caption;
                await ctx.reply('Файл получили. Отвечаю на ваш вопрос:');
            } else {
                await ctx.reply('Получили ваш файл, менеджер скоро свяжется с вами.');
                return;
            }
        } catch (error) {
            console.error(`[PID:${PID}] ❌ Ошибка пересылки:`, error.message);
        }
    }

    // 2. ГОЛОСОВЫЕ
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
            return await ctx.reply('Не удалось распознать голос.');
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

        // Пересылка админу
        try {
            await ctx.telegram.sendMessage(adminGroupId, `👤 <b>${ctx.from.first_name}:</b> ${messageText}`, {
                message_thread_id: userTopic.topic_id,
                parse_mode: 'HTML'
            });
        } catch (e) {
            if (e.message.includes('message thread not found')) {
                const newTopicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
                await db.updateTopicId(userId, newTopicId);
                userTopic.topic_id = newTopicId;
                await ctx.telegram.sendMessage(adminGroupId, `👤 <b>${ctx.from.first_name}:</b> ${messageText}`, {
                    message_thread_id: userTopic.topic_id,
                    parse_mode: 'HTML'
                });
            }
        }

        // 3. ПАУЗА AI (ADMIN OVERRIDE)
        const OVERRIDE_TIMEOUT_MS = 10 * 60 * 1000;
        const overrideExpired = userTopic.admin_override_at && 
            (Date.now() - new Date(userTopic.admin_override_at).getTime()) > OVERRIDE_TIMEOUT_MS;

        if (userTopic.admin_override && !overrideExpired) return;

        // 4. ЗАПРОС К AI
        const history = await db.getHistory(userId);
        const model = llm.selectModel(messageText, history.length / 2, history);
        const aiResult = await llm.ask(model, SYSTEM_PROMPT, history, messageText);
        
        // 5. ОЧИСТКА ТЕКСТА
        const cleanText = aiResult.text
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/^[-•]\s/gm, '')
            .replace(/^#{1,6}/gm, '')
            .replace(/`(.*?)`/g, '$1');
        
        await ctx.reply(cleanText);

        // 6. ТРИГГЕР НА МЕНЕДЖЕРА
        const managerTriggers = ['переда', 'менеджер', 'свяжет', 'специалист', 'заявк', 'подключит'];
        if (managerTriggers.some(t => cleanText.toLowerCase().includes(t))) {
            const cleanGroupId = String(config.telegram.adminGroupId).replace('-100', '');
            const clientTopicLink = `https://t.me/c/${cleanGroupId}/${userTopic.topic_id}`;
            
            await ctx.telegram.sendMessage(config.telegram.adminGroupId, 
                `🔔 <b>ТРЕБУЕТСЯ МЕНЕДЖЕР</b>\n👤 ${ctx.from.first_name}\n🔗 <a href="${clientTopicLink}">Перейти</a>`, 
                {
                    message_thread_id: config.telegram.alertsTopicId,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }
            );
        }

        // Логирование
        await ctx.telegram.sendMessage(adminGroupId, `🤖 <b>AI [${aiResult.model}]:</b> ${cleanText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        await db.logMessage({
            user_id: userId,
            message_text: messageText,
            bot_response: cleanText,
            model_used: aiResult.model,
            cost_usd: aiResult.cost
        });

    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка:`, e.message);
        await ctx.reply('Извините, техническая ошибка.');
    }
});

// --- ЗАПУСК ---

const startBot = async () => {
    try {
        // Сначала готовим БД (таблицы + дефолтный промпт)
        await db.init();

        // Теперь загружаем промпт (он точно там будет после db.init)
        const savedPrompt = await db.getConfig('system_prompt');
        if (savedPrompt) {
            SYSTEM_PROMPT = savedPrompt;
            console.log(`[PID:${PID}] ✅ Промпт загружен: ${SYSTEM_PROMPT.length} симв.`);
        }

        const WEBHOOK_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
        if (WEBHOOK_DOMAIN) {
            await bot.telegram.setWebhook(`https://${WEBHOOK_DOMAIN}/webhook`);
            console.log(`[PID:${PID}] ✅ Webhook установлен: ${WEBHOOK_DOMAIN}`);
        } else {
            console.log(`[PID:${PID}] ⚠️ Polling mode...`);
            await bot.launch();
        }
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка запуска:`, err.message);
        process.exit(1);
    }
};

startBot();