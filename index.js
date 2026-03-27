import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/database.js'; // Заменено с supabase.js
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const PID = process.pid;
let SYSTEM_PROMPT = null;

const bot = new Telegraf(config.telegram.token);
const app = express();
const PORT = process.env.PORT || 3000;

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
    
    if (!newPrompt) {
        return ctx.reply('❌ Ошибка: system_prompt не найден в БД');
    }
    
    SYSTEM_PROMPT = newPrompt;
    ctx.reply(`✅ Промпт обновлён! Новая длина: ${SYSTEM_PROMPT.length} симв.`);
});

/**
 * Команда /start: Инициализация пользователя и топика
 */
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[PID:${PID}] 🚀 Принудительное приветствие /start для ${userId}`);

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
        
        await ctx.reply('Здравствуйте! Вас приветствует Dokki Business. 🍅 Рады, что вы обратились к нам! Расскажите подробнее о вашем проекте: что именно вас интересует? Нам можно писать текстом или наговаривать голосовые сообщения — как удобнее.');
        
    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка в команде /start:`, e.message);
    }
});

// --- ОСНОВНОЙ ОБРАБОТЧИК ---

bot.on('message', async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    // Если пишет админ в админ-группе
    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let messageText = ctx.message?.text || null;

    // --- 1. ПЕРЕХВАТ ФАЙЛОВ И ПОДПИСЕЙ ---
    if (ctx.message?.document || ctx.message?.photo || ctx.message?.video || ctx.message?.audio) {
        try {
            const topic = await db.getTopic(userId);
            const topicId = topic ? topic.topic_id : config.telegram.alertsTopicId;

            await ctx.forwardMessage(adminGroupId, {
                message_thread_id: topicId
            });

            if (ctx.message.caption) {
                messageText = ctx.message.caption;
                await ctx.reply('Файл получили и передали менеджеру. Отвечаю на ваш вопрос:');
            } else {
                await ctx.reply('Получили ваш файл и передали менеджеру. Он свяжется с вами в ближайшее время.');
                return;
            }
        } catch (error) {
            console.error(`[PID:${PID}] ❌ Ошибка при пересылке файла:`, error.message);
            if (!ctx.message.caption) return;
        }
    }

    // --- 2. ОБРАБОТКА ГОЛОСОВЫХ ---
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

        // Дублируем сообщение клиента в топик админа
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
            } else {
                throw e;
            }
        }

        // --- 3. ПРОВЕРКА ADMIN OVERRIDE (ПАУЗА AI) ---
        const OVERRIDE_TIMEOUT_MS = 10 * 60 * 1000;
        const overrideExpired = userTopic.admin_override_at && 
            (Date.now() - new Date(userTopic.admin_override_at).getTime()) > OVERRIDE_TIMEOUT_MS;

        if (userTopic.admin_override && !overrideExpired) return;

        // --- 4. ЗАПРОС К AI ---
        const history = await db.getHistory(userId);
        const model = llm.selectModel(messageText, history.length / 2, history);
        const aiResult = await llm.ask(model, SYSTEM_PROMPT, history, messageText);
        
        const replyText = aiResult.text;

        // --- 5. ОЧИСТКА MARKDOWN ПЕРЕД ОТПРАВКОЙ ---
        const cleanText = replyText
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/^[-•]\s/gm, '')
            .replace(/^#{1,6}/gm, '')
            .replace(/#{1,6}\s/g, '')
            .replace(/`(.*?)`/g, '$1');
        
        await ctx.reply(cleanText);

        // --- 6. ПРОВЕРКА ТРИГГЕРОВ НА МЕНЕДЖЕРА ---
        const managerTriggers = ['переда', 'менеджер', 'свяжет', 'специалист', 'заявк', 'подключит', 'перезвон'];
        const lowerCaseReply = cleanText.toLowerCase();
        const needsManager = managerTriggers.some(t => lowerCaseReply.includes(t));

        if (needsManager) {
            try {
                const clientName = ctx.from?.first_name || 'Клиент';
                const clientUsername = ctx.from?.username ? `@${ctx.from.username}` : 'Без юзернейма';
                const questionSnippet = messageText.slice(0, 100);

                const cleanGroupId = String(config.telegram.adminGroupId).replace('-100', '');
                const clientTopicLink = `https://t.me/c/${cleanGroupId}/${userTopic.topic_id}`;

                const alertHTML = `🔔 <b>ТРЕБУЕТСЯ МЕНЕДЖЕР</b>\n\n` +
                                  `👤 <b>Клиент:</b> ${clientName} (${clientUsername})\n` +
                                  `❓ <b>Вопрос:</b> ${questionSnippet}${messageText.length > 100 ? '...' : ''}\n\n` +
                                  `🔗 <a href="${clientTopicLink}">Перейти к диалогу</a>`;

                await ctx.telegram.sendMessage(config.telegram.adminGroupId, alertHTML, {
                    message_thread_id: config.telegram.alertsTopicId,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } catch (err) {
                console.error(`[PID:${PID}] ❌ Ошибка алерта:`, err.message);
            }
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
        console.error(`[PID:${PID}] ❌ Ошибка обработчика:`, e.message);
        await ctx.reply('Извините, техническая ошибка.');
    }
});

const startBot = async () => {
    try {
        // Инициализация схем Postgres при запуске
        await db.init();

        SYSTEM_PROMPT = await db.getConfig('system_prompt');
        if (!SYSTEM_PROMPT) throw new Error('SYSTEM_PROMPT не найден!');
        
        const WEBHOOK_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
        if (WEBHOOK_DOMAIN) {
            await bot.telegram.setWebhook(`https://${WEBHOOK_DOMAIN}/webhook`);
            console.log(`[PID:${PID}] ✅ Бот запущен на ${WEBHOOK_DOMAIN}`);
        } else {
            console.log(`[PID:${PID}] ⚠️ RAILWAY_PUBLIC_DOMAIN не найден, запуск в режиме polling...`);
            await bot.launch();
        }
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка запуска:`, err.message);
        process.exit(1);
    }
};

startBot();