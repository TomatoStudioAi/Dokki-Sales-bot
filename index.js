import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';

const bot = new Telegraf(config.telegram.token);

// Принудительный сброс вебхука перед стартом
console.log('🔧 Deleting webhook...');
await bot.telegram.deleteWebhook({ drop_pending_updates: true });
console.log('✅ Webhook deleted');

bot.on(['message', 'voice'], async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    // Логика ответов админа в топиках
    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    const text = ctx.message.text || 'Голосовое сообщение или медиа';

    try {
        // 1. Работа с топиком в БД и Telegram
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

        // 2. Проброс сообщения в админ-группу
        await ctx.telegram.sendMessage(adminGroupId, `<b>Клиент:</b> ${text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // 3. Если админ "перехватил" диалог, ИИ молчит
        if (userTopic.admin_override) return;

        // 4. Запрос к ИИ и обработка ответа (FIX undefined)
        const aiResponse = await llm.ask('gpt-4o', 'You are Alexey...', [], text);
        
        // Проверяем, что пришло: строка или объект
        const replyText = typeof aiResponse === 'string' 
            ? aiResponse 
            : (aiResponse.text || aiResponse.response || 'Ошибка: ИИ вернул пустой ответ');

        await ctx.reply(replyText);

    } catch (e) { 
        console.error('❌ Ошибка в обработчике:', e.message);
        // Если база всё еще кэширует старую схему, мы увидим это здесь
    }
});

// Корректное завершение работы
const shutdown = () => {
    console.log('⚠️ Stopping bot...');
    bot.stop();
    process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Запуск
bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('✅ Бот запущен и готов к работе'))
    .catch(err => {
        console.error('❌ Ошибка запуска:', err);
        process.exit(1);
    });