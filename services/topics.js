import { config } from '../config/env.js';

export const topics = {
    async create(ctx, firstName, username) {
        const adminGroupId = Number(config.telegram.adminGroupId);
        const userId = ctx.from.id;
        const cleanName = (firstName || 'Клиент').replace(/[<>]/g, '');
        const cleanUsername = username ? `@${username}` : 'без_юзернейма';
        
        // Формат: Имя | @username | ID
        const topicName = `${cleanName} | ${cleanUsername} | ${userId}`.slice(0, 128);

        const forumTopic = await ctx.telegram.createForumTopic(adminGroupId, topicName);
        return forumTopic.message_thread_id;
    }
};