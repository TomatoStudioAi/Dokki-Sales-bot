import { db } from '../services/supabase.js';

export const handleAdminReply = async (ctx) => {
    try {
        const topicId = ctx.message.message_thread_id;
        if (!topicId) return;

        const userId = await db.getUserIdByTopic(topicId);
        if (!userId) return;

        // Включаем ручной режим (ИИ замолкает)
        await db.setOverride(userId, true);
        
        // Отправляем текст клиенту
        await ctx.telegram.sendMessage(userId, ctx.message.text);
        
        console.log(`💬 Админ перехватил диалог в топике #${topicId}`);
    } catch (err) {
        console.error('❌ Ошибка в ответах админа:', err.message);
    }
};