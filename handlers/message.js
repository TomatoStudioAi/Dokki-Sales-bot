import { llm } from '../services/llm.js';
import { db } from '../services/database.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function loadBotConfig() {
    try {
        const sql = `SELECT id, openai_key, business_name, system_prompt, alerts_topic_id FROM bot_config LIMIT 1`;
        const result = await db.query(sql);
        return result[0] || null;
    } catch (error) {
        log(`❌ Ошибка загрузки bot_config: ${error.message}`);
        throw new Error('database_error');
    }
}

async function loadConversationHistory(userId) {
    try {
        const sql = `SELECT messages FROM conversations WHERE user_id = $1`;
        const result = await db.query(sql, [userId]);
        if (!result[0] || !result[0].messages) return [];
        return result[0].messages
            .map(msg => ({ role: msg.role, content: msg.content }))
            .slice(-20);
    } catch (error) {
        log(`❌ Ошибка истории: ${error.message}`);
        return [];
    }
}

async function saveMessage(userId, role, content) {
    const messageObj = JSON.stringify({ role, content, timestamp: new Date().toISOString() });
    try {
        const updateSql = `
            UPDATE conversations 
            SET messages = messages || $1::jsonb, updated_at = NOW() 
            WHERE user_id = $2 RETURNING id
        `;
        const result = await db.query(updateSql, [messageObj, userId]);
        if (result.length === 0) {
            const insertSql = `INSERT INTO conversations (user_id, messages) VALUES ($1, ARRAY[$2::jsonb])`;
            await db.query(insertSql, [userId, messageObj]);
        }
    } catch (error) {
        log(`❌ Ошибка сохранения: ${error.message}`);
    }
}

async function getOrCreateClientTopic(ctx, botConfig) {
    const userId = ctx.from.id;
    const username = ctx.from.username || `User_${userId}`;
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    try {
        const checkSql = `SELECT client_topic_id FROM conversations WHERE user_id = $1`;
        const result = await db.query(checkSql, [userId]);
        if (result[0]?.client_topic_id) return result[0].client_topic_id;
        const topic = await ctx.telegram.createForumTopic(adminGroupId, `💬 ${username}`);
        const topicId = topic.message_thread_id;
        await db.query(`UPDATE conversations SET client_topic_id = $1 WHERE user_id = $2`, [topicId, userId]);
        log(`✅ Создан топик ${topicId} для клиента ${userId}`);
        return topicId;
    } catch (error) {
        log(`❌ Ошибка топика: ${error.message}`);
        return null;
    }
}

async function checkAdminOverride(userId) {
    try {
        const sql = `
            SELECT (admin_override AND override_expires_at > NOW()) as is_active
            FROM conversations 
            WHERE user_id = $1
        `;
        const result = await db.query(sql, [userId]);
        if (!result[0] || !result[0].is_active) {
            await db.query(
                `UPDATE conversations SET admin_override = FALSE 
                 WHERE user_id = $1 AND admin_override = TRUE`, 
                [userId]
            );
            return false;
        }
        return true;
    } catch (error) {
        log(`❌ Ошибка override: ${error.message}`);
        return false;
    }
}

async function sendManagerAlert(ctx, botConfig) {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${userId}`;
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    const clientTopicId = await getOrCreateClientTopic(ctx, botConfig);
    if (!clientTopicId) return;
    const cleanGroupId = Math.abs(adminGroupId).toString().replace(/^100/, '');
    const clientTopicLink = `https://t.me/c/${cleanGroupId}/${clientTopicId}`;
    const alertText = `🔔 *КЛИЕНТ ГОТОВ К ПОКУПКЕ*\n\n` +
                      `👤 Клиент: ${username}\n` +
                      `💬 Сообщение: "${ctx.message.text || '[Медиа]'}"\n\n` +
                      `👉 [Перейти в диалог](${clientTopicLink})`;
    try {
        await ctx.telegram.sendMessage(adminGroupId, alertText, {
            parse_mode: 'Markdown',
            message_thread_id: botConfig.alerts_topic_id
        });
        log(`🚀 Алерт отправлен для ${userId}`);
    } catch (error) {
        log(`❌ Ошибка алерта: ${error.message}`);
    }
}

async function incrementMessageCount(botId) {
    try {
        await db.query(`UPDATE usage_stats SET messages_this_month = messages_this_month + 1 WHERE bot_id = $1`, [botId]);
    } catch (error) {
        log(`❌ Ошибка биллинга: ${error.message}`);
    }
}

export async function handleMessage(ctx) {
    if (!ctx.message.text && !ctx.message.voice) return;
    const userId = ctx.from.id;
    const userMessage = ctx.message.text;
    try {
        const botConfig = await loadBotConfig();
        if (!botConfig || !botConfig.openai_key) {
            log(`⚠️ Бот для ${userId} не настроен`);
            return await ctx.reply('Бот временно недоступен. Пожалуйста, обратитесь к администратору.');
        }
        if (await checkAdminOverride(userId)) return;
        if (ctx.message.voice) {
            return await ctx.reply("Я пока лучше понимаю текст. Пожалуйста, напишите ваше сообщение.");
        }
        const history = await loadConversationHistory(userId);
        await saveMessage(userId, 'user', userMessage);
        const result = await llm.ask(botConfig, history, userMessage);
        await saveMessage(userId, 'assistant', result.text);
        if (llm.isReadyForManager(userMessage, result.text)) {
            await sendManagerAlert(ctx, botConfig);
        }
        await incrementMessageCount(botConfig.id);
        await ctx.reply(result.text);
    } catch (error) {
        log(`❌ Ошибка обработки: ${error.message}`);
        let errorMessage = 'Извините, возникла техническая проблема. Попробуйте ещё раз позже.';
        if (error.message.includes('Ошибка:')) {
            errorMessage = error.message; 
        } else if (error.message === 'database_error' || error.message.includes('query')) {
            errorMessage = 'Временные неполадки с базой данных. Мы уже чиним!';
        }
        await ctx.reply(errorMessage);
    }
}
