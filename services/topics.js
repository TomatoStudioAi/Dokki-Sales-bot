import { config } from '../config/env.js';

export const topics = {
    /**
     * Создает новый топик в админ-группе для клиента
     */
    async create(ctx, firstName, username) {
        try {
            const title = username ? `${firstName} (@${username})` : firstName;
            
            // Создаем топик. adminGroupId уже преобразован в Number в конфиге
            const forum = await ctx.telegram.createForumTopic(
                config.telegram.adminGroupId,
                title
            );
            
            return forum.message_thread_id;
        } catch (error) {
            console.error('❌ Ошибка при создании топика в Telegram:', error.message);
            throw error;
        }
    }
};