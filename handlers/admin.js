import { db } from '../services/supabase.js';

export const handleAdminReply = async (ctx) => {
    try {
        const topicId = ctx.message?.message_thread_id;
        if (!topicId) return;
        
        // 1. Игнорируем сообщения от самого бота (эхо-сообщения зеркала)
        if (ctx.message.from?.is_bot) return;
        
        // 2. Игнорируем сообщения без текста (сервисные сообщения или медиа без подписи)
        if (!ctx.message.text) return;

        // 3. Пытаемся найти пользователя, привязанного к этому топику
        const userId = await db.getUserIdByTopic(topicId);
        if (!userId) return;

        // 4. Включаем режим перехвата (админ взял управление на себя)
        await db.setOverride(userId, true);
        
        // 5. Пересылаем ответ админа клиенту
        await ctx.telegram.sendMessage(userId, ctx.message.text);
        
        console.log(`💬 Админ перехватил диалог в топике #${topicId}`);
    } catch (err) {
        console.error('❌ Ошибка в ответах админа:', err.message);
    }
};