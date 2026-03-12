import { config } from '../config/env.js';

export const topics = {
    /**
     * Создать новый топик в группе
     */
    async create(ctx, firstName, username) {
        try {
            const title = `${firstName}${username ? ` (@${username})` : ''}`;
            const chat = await ctx.telegram.createForumTopic(
                config.telegram.adminGroupId,
                title
            );
            
            console.log(`📝 Создан новый топик: ${title} (ID: ${chat.message_thread_id})`);
            return chat.message_thread_id;
        } catch (error) {
            console.error('❌ Ошибка создания топика:', error.message);
            // Если форум не включен в группе, это выдаст ошибку
            throw new Error('Убедитесь, что в группе включены "Темы" (Topics)');
        }
    }
};