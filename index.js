import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';

// 1. HTTP-сервер для Railway Healthcheck
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const server = app.listen(PORT, () => {
    console.log(`✅ HTTP server listening on port ${PORT}`);
});

// 2. Инициализация бота
const bot = new Telegraf(config.telegram.token);

bot.on(['message', 'voice'], async (ctx) => {
    const text = ctx.message?.text || 'Голосовое сообщение или медиа';
    console.log(`📥 Получено сообщение от ${ctx.from.id}:`, text); // Маячок

    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;

    try {
        let userTopic = await db.getTopic(userId);
        
        if (!userTopic) {
            console.log(`🆕 Создаю новый топик для ${ctx.from.first_name}`);
            const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: ctx.from.username || 'n/a',
                first_name: ctx.from.first_name
            });
        }

        await ctx.telegram.sendMessage(adminGroupId, `<b>Клиент:</b> ${text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        if (userTopic.admin_override) return;

        const aiResponse = await llm.ask('gpt-4o', 'You are Alexey...', [], text);
        
        const replyText = typeof aiResponse === 'string' 
            ? aiResponse 
            : (aiResponse.text || aiResponse.response || 'Ошибка: ИИ вернул пустой ответ');

        await ctx.reply(replyText);

    } catch (e) { 
        console.error('❌ Ошибка в обработчике:', e.message);
    }
});

// 3. Graceful Shutdown
const shutdown = () => {
    console.log('⚠️ Stopping server and bot...');
    server.close();
    bot.stop();
    process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// 4. Запуск 
const startBot = async () => {
    try {
        console.log('🔧 Deleting webhook...');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('✅ Webhook deleted');

        console.log('⏳ Waiting 5 seconds for Telegram to release connection...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('✅ Wait complete');

        // УБРАЛИ dropPendingUpdates: true, чтобы предотвратить зависание
        await bot.launch(); 
        console.log('✅ Бот запущен (polling mode)');
    } catch (err) {
        console.error('❌ Launch failed:', err.message);
        process.exit(1);
    }
};

startBot();