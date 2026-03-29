import { llm } from '../services/llm.js';
import { db } from '../services/database.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [MSG_HANDLER] ${msg}`);

// ID основной группы менеджеров
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;

/**
 * Получение или создание персонального топика в группе менеджеров
 */
async function getOrCreateClientTopic(ctx, botId) {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Клиент';
    const username = ctx.from.username;
    
    // Формируем красивое имя для топика (White Label Style)
    const displayName = username ? `@${username}` : `${firstName} (ID: ${userId})`;
    const topicName = `💬 ${displayName}`;

    try {
        // Проверяем, есть ли уже топик для этого связки Бот + Юзер
        const sql = `SELECT topic_id FROM user_topics WHERE bot_id = $1 AND user_id = $2`;
        const result = await db.query(sql, [botId, userId]);
        
        if (result[0]?.topic_id) {
            return result[0].topic_id;
        }

        if (!ADMIN_GROUP_ID) {
            log('⚠️ TELEGRAM_ADMIN_GROUP_ID не задан в окружении');
            return null;
        }

        // Создаем новый топик в супергруппе
        log(`[TOPIC] Создаю новый топик "${topicName}" в группе ${ADMIN_GROUP_ID}`);
        const topic = await ctx.telegram.createForumTopic(ADMIN_GROUP_ID, topicName);
        const topicId = topic.message_thread_id;
        
        // Сохраняем связь в базу
        await db.query(`
            INSERT INTO user_topics (bot_id, user_id, topic_id, username, first_name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (bot_id, user_id) DO UPDATE SET topic_id = EXCLUDED.topic_id
        `, [botId, userId, topicId, username, firstName]);
        
        log(`✅ Топик ${topicId} создан для ${displayName}`);
        return topicId;
    } catch (error) {
        log(`❌ Ошибка создания топика: ${error.message}`);
        return null;
    }
}

/**
 * Проверка, перехвачен ли чат менеджером (Override)
 */
async function checkAdminOverride(botId, userId) {
    try {
        const sql = `SELECT admin_override, admin_override_at FROM user_topics WHERE bot_id = $1 AND user_id = $2`;
        const result = await db.query(sql, [botId, userId]);
        
        if (!result[0] || !result[0].admin_override) return false;

        const hoursPassed = (new Date() - new Date(result[0].admin_override_at)) / (1000 * 60 * 60);
        if (hoursPassed < 2) return true; // Режим менеджера активен 2 часа

        await db.query(`UPDATE user_topics SET admin_override = FALSE WHERE bot_id = $1 AND user_id = $2`, [botId, userId]);
        log(`[Override] Время истекло для юзера ${userId}. ИИ снова в деле.`);
        return false;
    } catch (error) {
        return false;
    }
}

/**
 * Отправка уведомления менеджеру о "Горячем лиде"
 */
async function sendManagerAlert(ctx, botConfig) {
    if (!ADMIN_GROUP_ID) return;

    const userId = ctx.from.id;
    const displayName = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.first_name || 'Клиент'} (ID: ${userId})`;
    
    // Получаем (или создаем) топик клиента, чтобы дать прямую ссылку
    const clientTopicId = await getOrCreateClientTopic(ctx, botConfig.id);
    const cleanGroupId = Math.abs(ADMIN_GROUP_ID).toString().replace(/^100/, '');
    const clientLink = clientTopicId ? `https://t.me/c/${cleanGroupId}/${clientTopicId}` : 'ссылка недоступна';

    const alertText = `🔥 *ГОРЯЧИЙ КЛИЕНТ*\n\n` +
                      `👤 Клиент: ${displayName}\n` +
                      `💬 Запрос: "${ctx.message.text || '[Голос]'}"\n` +
                      `🤖 Бот: @${botConfig.telegram_username}\n\n` +
                      `👉 [ОТКРЫТЬ ЧАТ С КЛИЕНТОМ](${clientLink})`;

    try {
        // Шлем алерт строго в alerts_topic_id (тот самый №6)
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, alertText, {
            parse_mode: 'Markdown',
            message_thread_id: botConfig.alerts_topic_id || null 
        });
        log(`🚀 Алерт отправлен в топик #${botConfig.alerts_topic_id}`);
    } catch (error) {
        log(`❌ Ошибка отправки алерта: ${error.message}`);
    }
}

/**
 * ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
 */
export async function handleMessage(ctx) {
    if (!ctx.message?.text && !ctx.message?.voice) return;
    
    const userId = ctx.from.id;
    const userText = ctx.message.text || '[Голосовое]';
    
    // 1. Идентификация бота (Нормализация для White Label)
    const rawUsername = ctx.botInfo?.username;
    if (!rawUsername) return;

    const botUsername = rawUsername.startsWith('@') ? rawUsername.toLowerCase() : `@${rawUsername.toLowerCase()}`;

    try {
        // 2. Поиск конфига в БД
        const config = await db.getBotConfig(botUsername);
        if (!config) {
            log(`⚠️ Бот ${botUsername} не найден в БД. Игнорируем.`);
            return; 
        }

        // 3. Если сейчас отвечает менеджер — ИИ молчит
        if (await checkAdminOverride(config.id, userId)) {
            log(`[Override] Менеджер перехватил чат с ${userId}`);
            return;
        }

        // 4. Логика ИИ
        const history = await db.getChatHistory(config.id, userId, 15);
        const aiResult = await llm.ask(config, history, userText);

        // 5. Логируем переписку
        await db.logInteraction(config.id, userId, 
            { role: 'user', content: userText },
            { model: aiResult.model, input: aiResult.tokens.input, output: 0 }
        );

        await db.logInteraction(config.id, userId,
            { role: 'assistant', content: aiResult.text },
            { model: aiResult.model, input: 0, output: aiResult.tokens.output }
        );

        // 6. Проверка на "Лид" и отправка алерта
        if (llm.isReadyForManager(userText, aiResult.text)) {
            await sendManagerAlert(ctx, config);
        }

        // 7. Ответ пользователю
        await ctx.reply(aiResult.text);

        // 8. Дублируем сообщение в персональный топик менеджеров (для прозрачности)
        const clientTopicId = await getOrCreateClientTopic(ctx, config.id);
        if (clientTopicId) {
            await ctx.telegram.sendMessage(ADMIN_GROUP_ID, `🤖 Бот ответил:\n${aiResult.text}`, {
                message_thread_id: clientTopicId
            });
        }

    } catch (error) {
        log(`❌ Ошибка обработки: ${error.message}`);
        await ctx.reply('Извините, возникла техническая пауза. Скоро буду в строю!');
    }
}