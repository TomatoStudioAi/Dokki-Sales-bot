import { llm } from '../services/llm.js';
import { db } from '../services/database.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [MSG_HANDLER] ${msg}`);
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;

/**
 * Получение или создание топика с проверкой на валидность (Self-Healing)
 * ИСПРАВЛЕНО: Теперь проверяет именно топик через sendChatAction
 */
async function getOrCreateClientTopic(ctx, botId) {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Клиент';
    const username = ctx.from.username;
    const displayName = username ? `@${username}` : `${firstName} (ID: ${userId})`;
    const topicName = `💬 ${displayName}`;

    try {
        const sql = `SELECT topic_id FROM user_topics WHERE bot_id = $1 AND user_id = $2`;
        const result = await db.query(sql, [botId, userId]);
        let topicId = result[0]?.topic_id;

        if (topicId) {
            try {
                // ПРОВЕРКА: Пытаемся отправить действие "typing" именно в этот топик
                // Если топик удален, Telegram вернет ошибку 400 (message thread not found)
                await ctx.telegram.sendChatAction(ADMIN_GROUP_ID, 'typing', {
                    message_thread_id: topicId
                });
                return topicId;
            } catch (e) {
                log(`⚠️ Топик ${topicId} удален в Telegram. Очистка БД и пересоздание...`);
                await db.query('DELETE FROM user_topics WHERE bot_id = $1 AND user_id = $2', [botId, userId]);
                topicId = null; 
            }
        }

        // Создаем новый топик, если старого нет или он был удален
        log(`[TOPIC] Создание новой ветки для ${displayName}`);
        const topic = await ctx.telegram.createForumTopic(ADMIN_GROUP_ID, topicName);
        topicId = topic.message_thread_id;
        
        await db.query(`
            INSERT INTO user_topics (bot_id, user_id, topic_id, username, first_name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (bot_id, user_id) 
            DO UPDATE SET topic_id = EXCLUDED.topic_id, updated_at = NOW()
        `, [botId, userId, topicId, username, firstName]);
        
        log(`✅ Новый топик ${topicId} успешно привязан`);
        return topicId;
    } catch (error) {
        log(`❌ Ошибка управления топиками: ${error.message}`);
        return null;
    }
}

/**
 * Бронебойная отправка сообщения в топик (с авто-пересозданием)
 */
async function sendToClientTopic(ctx, botConfig, text, extra = {}) {
    let topicId = await getOrCreateClientTopic(ctx, botConfig.id);
    if (!topicId) return;

    try {
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, text, {
            ...extra,
            message_thread_id: topicId
        });
    } catch (error) {
        // Дополнительная проверка на случай, если топик удалили в секунду между проверкой и отправкой
        if (error.description?.includes('message thread not found')) {
            log(`🔄 Повторная очистка БД для ${topicId}...`);
            await db.query('DELETE FROM user_topics WHERE bot_id = $1 AND user_id = $2', [botConfig.id, ctx.from.id]);
            return sendToClientTopic(ctx, botConfig, text, extra);
        }
        log(`❌ Ошибка отправки в топик: ${error.message}`);
    }
}

/**
 * Отправка алертов (Fix: HTML Mode для защиты от спецсимволов)
 */
async function sendManagerAlert(ctx, botConfig, userText, aiAnswer) {
    if (!ADMIN_GROUP_ID) return;

    const userId = ctx.from.id;
    const displayName = ctx.from.username ? `@${ctx.from.username}` : `<b>${ctx.from.first_name || 'Клиент'}</b> (ID: ${userId})`;
    
    // Получаем ID топика для формирования ссылки
    const clientTopicId = await getOrCreateClientTopic(ctx, botConfig.id);
    const cleanGroupId = Math.abs(ADMIN_GROUP_ID).toString().replace(/^100/, '');
    const clientLink = `https://t.me/c/${cleanGroupId}/${clientTopicId}`;

    const alertText = `🔔 <b>ГОРЯЧИЙ КЛИЕНТ</b>\n\n` +
                      `👤 Клиент: ${displayName}\n` +
                      `💬 Запрос: <i>"${userText}"</i>\n` +
                      `🤖 Бот: @${ctx.botInfo.username}\n\n` +
                      `👉 <a href="${clientLink}">ОТКРЫТЬ ЧАТ С КЛИЕНТОМ</a>`;

    try {
        // Шлем алерт в специальный топик (если указан в конфиге) или в General
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, alertText, {
            parse_mode: 'HTML',
            message_thread_id: botConfig.alerts_topic_id || null 
        });
    } catch (error) {
        log(`⚠️ Ошибка отправки алерта: ${error.message}. Шлю в основной чат.`);
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, alertText, { parse_mode: 'HTML' });
    }
}

/**
 * Основной обработчик входящих сообщений
 */
export async function handleMessage(ctx) {
    if (!ctx.message?.text) return;
    
    const userId = ctx.from.id;
    const userText = ctx.message.text;
    const botUsername = `@${ctx.botInfo.username.toLowerCase()}`;

    try {
        // 1. Получаем конфиг бота
        const config = await db.getBotConfig(botUsername);
        if (!config) return;

        // 2. Работаем с ИИ
        const history = await db.getChatHistory(config.id, userId, 15);
        const aiResult = await llm.ask(config, history, userText);

        // 3. Логируем взаимодействие в БД
        await db.logInteraction(config.id, userId, { role: 'user', content: userText }, { model: aiResult.model, input: aiResult.tokens.input, output: 0 });
        await db.logInteraction(config.id, userId, { role: 'assistant', content: aiResult.text }, { model: aiResult.model, input: 0, output: aiResult.tokens.output });

        // 4. Отвечаем пользователю
        await ctx.reply(aiResult.text);

        // 5. Проверяем на Лид и отправляем алерт менеджеру
        if (llm.isReadyForManager(userText, aiResult.text)) {
            await sendManagerAlert(ctx, config, userText, aiResult.text);
        }

        // 6. Дублируем переписку в персональный топик админ-группы
        const mirrorText = `👤 <b>Клиент:</b> ${userText}\n\n🤖 <b>Бот:</b> ${aiResult.text}`;
        await sendToClientTopic(ctx, config, mirrorText, { parse_mode: 'HTML' });

    } catch (error) {
        log(`❌ Critical Error: ${error.message}`);
    }
}