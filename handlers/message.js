import { llm } from '../services/llm.js';
import { db } from '../services/database.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [MSG_HANDLER] ${msg}`);

// Используем ID группы менеджеров из переменных окружения
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;

/**
 * Получение или создание персонального топика в группе менеджеров
 */
async function getOrCreateClientTopic(ctx, botId) {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || `User_${userId}`;
    
    try {
        const sql = `SELECT topic_id FROM user_topics WHERE bot_id = $1 AND user_id = $2`;
        const result = await db.query(sql, [botId, userId]);
        
        if (result[0]?.topic_id) {
            return result[0].topic_id;
        }

        if (!ADMIN_GROUP_ID) {
            log('⚠️ TELEGRAM_ADMIN_GROUP_ID не задан в окружении');
            return null;
        }

        // Создаем новый топик в супергруппе (Forum mode)
        const topic = await ctx.telegram.createForumTopic(ADMIN_GROUP_ID, `💬 ${username}`);
        const topicId = topic.message_thread_id;
        
        await db.query(`
            INSERT INTO user_topics (bot_id, user_id, topic_id, username, first_name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (bot_id, user_id) DO UPDATE SET topic_id = EXCLUDED.topic_id
        `, [botId, userId, topicId, ctx.from.username, ctx.from.first_name]);
        
        log(`✅ Создан топик ${topicId} для клиента ${userId} (Бот #${botId})`);
        return topicId;
    } catch (error) {
        log(`❌ Ошибка создания топика: ${error.message}`);
        return null;
    }
}

/**
 * Проверка, перехвачен ли чат менеджером
 */
async function checkAdminOverride(botId, userId) {
    try {
        const sql = `
            SELECT admin_override, admin_override_at 
            FROM user_topics 
            WHERE bot_id = $1 AND user_id = $2
        `;
        const result = await db.query(sql, [botId, userId]);
        
        if (!result[0] || !result[0].admin_override) return false;

        const now = new Date();
        const overrideAt = new Date(result[0].admin_override_at);
        const hoursPassed = (now - overrideAt) / (1000 * 60 * 60);

        // Перехват действует 2 часа
        if (hoursPassed < 2) {
            return true;
        }

        await db.query(`
            UPDATE user_topics SET admin_override = FALSE 
            WHERE bot_id = $1 AND user_id = $2
        `, [botId, userId]);
        
        log(`[Override] Срок истек для юзера ${userId}. Управление возвращено ИИ.`);
        return false;
    } catch (error) {
        log(`❌ Ошибка проверки override: ${error.message}`);
        return false;
    }
}

/**
 * Отправка уведомления менеджеру о "Лиде"
 */
async function sendManagerAlert(ctx, botConfig) {
    if (!ADMIN_GROUP_ID) return;

    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${userId}`;
    
    const clientTopicId = await getOrCreateClientTopic(ctx, botConfig.id);
    if (!clientTopicId) return;

    const cleanGroupId = Math.abs(ADMIN_GROUP_ID).toString().replace(/^100/, '');
    const clientTopicLink = `https://t.me/c/${cleanGroupId}/${clientTopicId}`;

    const alertText = `🔔 *КЛИЕНТ ГОТОВ К ПОКУПКЕ*\n\n` +
                      `👤 Клиент: ${username}\n` +
                      `💬 Сообщение: "${ctx.message.text || '[Медиа]'}"\n\n` +
                      `👉 [Перейти в диалог](${clientTopicLink})`;

    try {
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, alertText, {
            parse_mode: 'Markdown',
            message_thread_id: botConfig.alerts_topic_id || null 
        });
        log(`🚀 Алерт отправлен для бота #${botConfig.id} (@${botConfig.telegram_username})`);
    } catch (error) {
        log(`❌ Ошибка отправки алерта: ${error.message}`);
    }
}

/**
 * ГЛАВНЫЙ ОБРАБОТЧИК (White Label SaaS)
 */
export async function handleMessage(ctx) {
    if (!ctx.message?.text && !ctx.message?.voice) return;
    
    const userId = ctx.from.id;
    const userMessage = ctx.message.text || '[Голосовое сообщение]';
    
    // ДИНАМИЧЕСКОЕ ОПРЕДЕЛЕНИЕ БОТА (Уход от ID=1)
    const botUsername = `@${ctx.botInfo.username}`;

    try {
        // 1. Загружаем конфиг по telegram_username
        const botData = await db.query(
            'SELECT * FROM bots WHERE telegram_username = $1', 
            [botUsername]
        );
        const botConfig = botData[0];

        if (!botConfig) {
            log(`⚠️ Ошибка: Бот ${botUsername} не зарегистрирован в базе данных.`);
            return; // Не отвечаем, если бот не в системе
        }

        if (!botConfig.openai_key) {
            log(`⚠️ Ошибка: У бота ${botUsername} не настроен OpenAI Key.`);
            return await ctx.reply('Бот временно недоступен. Пожалуйста, настройте API ключ.');
        }

        // 2. Проверяем режим "Менеджер в чате"
        if (await checkAdminOverride(botConfig.id, userId)) return;

        // 3. Обработка голоса
        if (ctx.message.voice) {
            return await ctx.reply("Я пока лучше понимаю текст. Пожалуйста, напишите ваше сообщение текстом.");
        }

        // 4. Загружаем историю из нормализованной таблицы messages (используем botConfig.id)
        const history = await db.getChatHistory(botConfig.id, userId, 15);

        // 5. Запрос к ИИ (используем BYOK внутри llm.ask)
        const result = await llm.ask(botConfig, history, userMessage);

        // 6. Атомарное сохранение логов и статистики (User message)
        await db.logInteraction(
            botConfig.id, 
            userId, 
            { role: 'user', content: userMessage },
            { model: result.model, input: result.tokens.input, output: 0 }
        );

        // 7. Сохранение ответа ИИ (Assistant message)
        await db.logInteraction(
            botConfig.id, 
            userId, 
            { role: 'assistant', content: result.text },
            { model: result.model, input: 0, output: result.tokens.output }
        );

        // 8. Проверка на готовность к продаже (Алерты)
        if (llm.isReadyForManager(userMessage, result.text)) {
            await sendManagerAlert(ctx, botConfig);
        }

        // 9. Ответ пользователю
        await ctx.reply(result.text);

    } catch (error) {
        log(`❌ Ошибка обработки @${ctx.botInfo.username}: ${error.message}`);
        
        const errorMessage = error.message.includes('API ключ') 
            ? error.message 
            : 'Извините, возникла техническая проблема. Попробуйте позже.';
        
        await ctx.reply(errorMessage);
    }
}