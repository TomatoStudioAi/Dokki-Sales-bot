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
    const userText = ctx.message.text || '[Голосовое сообщение]';
    
    // 1. ДИНАМИЧЕСКАЯ ИДЕНТИФИКАЦИЯ И НОРМАЛИЗАЦИЯ
    const rawUsername = ctx.botInfo?.username;
    
    if (!rawUsername) {
        log(`❌ Критично: ctx.botInfo.username отсутствует`);
        return;
    }

    // Принудительно к нижнему регистру и добавляем @ для поиска
    const botUsername = rawUsername.startsWith('@') 
        ? rawUsername.toLowerCase() 
        : `@${rawUsername.toLowerCase()}`;

    log(`[SEARCH] Бот "${botUsername}" ищет настройки в БД...`);

    try {
        // 2. БРОНЕБОЙНЫЙ ПОИСК (Игнорируем регистр и пробелы в базе)
        const config = (await db.query(
            `SELECT * FROM bots 
             WHERE LOWER(TRIM(telegram_username)) = LOWER(TRIM($1))`,
            [botUsername]
        ))[0];

        if (!config) {
            log(`⚠️ Бот ${botUsername} НЕ НАЙДЕН в БД. Проверь таблицу 'bots'.`);
            // Не отвечаем ничего, чтобы не спамить, если бот не зарегистрирован
            return; 
        }

        log(`✅ Найден конфиг для бота #${config.id} (${config.business_name})`);

        if (!config.openai_key || config.openai_key === 'sk-placeholder') {
            log(`⚠️ Ошибка: У бота ${botUsername} не настроен OpenAI Key.`);
            return await ctx.reply('Бот временно недоступен. Пожалуйста, настройте API ключ.');
        }

        // 3. Режим "Менеджер в чате"
        if (await checkAdminOverride(config.id, userId)) return;

        // 4. Обработка голоса
        if (ctx.message.voice) {
            return await ctx.reply("Я пока лучше понимаю текст. Пожалуйста, напишите ваше сообщение текстом.");
        }

        // 5. История и ИИ
        const history = await db.getChatHistory(config.id, userId, 15);
        const aiResult = await llm.ask(config, history, userText);

        // 6. Атомарное логирование
        await db.logInteraction(config.id, userId, 
            { role: 'user', content: userText },
            { model: aiResult.model, input: aiResult.tokens.input, output: 0 }
        );

        await db.logInteraction(config.id, userId,
            { role: 'assistant', content: aiResult.text },
            { model: aiResult.model, input: 0, output: aiResult.tokens.output }
        );

        // 7. Проверка на Лид
        if (llm.isReadyForManager(userText, aiResult.text)) {
            await sendManagerAlert(ctx, config);
        }

        await ctx.reply(aiResult.text);

    } catch (error) {
        log(`❌ Ошибка обработки для @${rawUsername}: ${error.message}`);
        
        const errorMessage = error.message.includes('API ключ') 
            ? error.message 
            : 'Извините, возникла техническая сложность. Попробуйте позже.';
        
        await ctx.reply(errorMessage);
    }
}