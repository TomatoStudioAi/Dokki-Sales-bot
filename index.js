import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';

const bot = new Telegraf(config.telegram.token);

// КРИТИЧНО: Удаляем webhook перед запуском polling
console.log('🔧 Deleting webhook...');
await bot.telegram.deleteWebhook({ drop_pending_updates: true });
console.log('✅ Webhook deleted');

bot.on(['message', 'voice'], async (ctx) => {
    const chatId = Number(ctx.chat.id); // ← FIX: Number, не String
    const adminGroupId = Number(config.telegram.adminGroupId); // ← FIX

    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let text = ctx.message.text || '';

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

        await ctx.telegram.sendMessage(adminGroupId, `<b>Клиент:</b> ${text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        if (userTopic.admin_override) return;

        const aiResponse = await llm.ask('gpt-4o', 'You are Alexey...', [], text);
        await ctx.reply(aiResponse.text);
    } catch (e) { 
        console.error('❌ Handler error:', e);
    }
});

// Graceful shutdown
const shutdownHandler = () => {
    console.log('⚠️ Shutting down...');
    bot.stop();
    process.exit(0);
};

process.once('SIGINT', shutdownHandler);
process.once('SIGTERM', shutdownHandler);

// Запуск с проверкой
bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('✅ Бот запущен (polling mode)'))
    .catch(err => {
        console.error('❌ Launch failed:', err);
        process.exit(1);
    });