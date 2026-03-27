import { db } from '../services/database.js';

/**
 * Обработчик ответов админа из форума (группы)
 * Если админ пишет в топике клиента, AI отключается на 10 минут
 */
export const handleAdminReply = async (ctx) => {
    try {
        const topicId = ctx.message?.message_thread_id;
        
        // 1. Игнорируем сообщения вне топиков
        if (!topicId) return;
        
        // 2. Игнорируем сообщения от самого бота (эхо-зеркало) и не-текст
        if (ctx.message.from?.is_bot) return;
        if (!ctx.message.text) return;

        // 3. Поиск userId клиента, привязанного к этому топику в Postgres
        const userId = await db.getUserIdByTopic(topicId);
        if (!userId) {
            console.log(`⚠️ Не найден пользователь для топика #${topicId}`);
            return;
        }

        // 4. Включаем режим перехвата (админ взял управление на себя)
        // Это обновит поле admin_override_at, ставя AI на паузу
        await db.setOverride(userId, true);
        
        // 5. Дублируем ответ админа напрямую в чат клиенту
        await ctx.telegram.sendMessage(userId, ctx.message.text);
        
        console.log(`💬 Админ перехватил диалог (User: ${userId}, Topic: ${topicId})`);
    } catch (err) {
        console.error('❌ Ошибка в handlers/admin.js:', err.message);
    }
};