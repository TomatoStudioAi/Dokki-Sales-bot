import { llm } from '../services/llm.js';
import { db } from '../services/database.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [MSG_HANDLER] ${msg}`);

// Используем точное имя переменной из твоего Railway
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;

/**
 * Загрузка конфигурации бота
 */
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

/**
 * Загрузка истории последних 20 сообщений
 */
async function loadConversationHistory(userId) {
    try {
        const sql = `SELECT messages FROM conversations WHERE user_id = $1`;
        const result = await db.query(sql, [userId]);
        if (!result[0] || !result[0].messages) return [];
        
        // Мапим сообщения в формат OpenAI и берем последние 20
        return result[0].messages
            .map(msg => ({ role: msg.role, content: msg.content }))
            .slice(-20);
    } catch (error) {
        log(`❌ Ошибка истории: ${error.message}`);
        return [];
    }
}

/**
 * Сохранение сообщения в JSONB массив
 */
async function saveMessage(userId, role, content) {
    const messageObj = { role, content, timestamp: new Date().toISOString() };
    try {
        // Пробуем обновить существующую запись
        const updateSql = `
            UPDATE conversations 
            SET messages = messages || $1::jsonb, updated_at = NOW() 
            WHERE user_id = $2 RETURNING id
        `;
        const result = await db.query(updateSql, [JSON.stringify(messageObj), userId]);
        
        // Если записи нет — создаем новую
        if (result.length === 0) {
            const insertSql = `INSERT INTO conversations (user_id, messages) VALUES ($1, ARRAY[$2::jsonb])`;
            await db.query(insertSql, [userId, JSON.stringify(messageObj)]);
        }
    } catch (error) {
        log(`❌ Ошибка сохранения сообщения: ${error.message}`);
    }
}

/**
 * Получение или создание персонального топика в группе менеджеров
 */
async function getOrCreateClientTopic(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || `User_${userId}`;
    
    try {
        const checkSql = `SELECT client_topic_id FROM conversations WHERE user_id = $1`;
        const result = await db.query(checkSql, [userId]);
        
        if (result[0]?.client_topic_id) {
            return result[0].client_topic_id;
        }

        if (!ADMIN_GROUP_ID) {
            log('⚠️ TELEGRAM_ADMIN_GROUP_ID не задан');
            return null;
        }

        // Создаем новый топик в супергруппе
        const topic = await ctx.telegram.createForumTopic(ADMIN_GROUP_ID, `💬 ${username}`);
        const topicId = topic.message_thread_id;
        
        await db.query(`UPDATE conversations SET client_topic_id = $1 WHERE user_id = $2`, [topicId, userId]);
        log(`✅ Создан топик ${topicId} для клиента ${userId}`);
        
        return topicId;
    } catch (error) {
        log(`❌ Ошибка при работе с топиком: ${error.message}`);
        return null;
    }
}

/**
 * Проверка, перехвачен ли чат менеджером
 */
async function checkAdminOverride(userId) {
    try {
        const sql = `
            SELECT admin_override, override_expires_at 
            FROM conversations 
            WHERE user_id = $1
        `;
        const result = await db.query(sql, [userId]);
        
        if (!result[0] || !result[0].admin_override) return false;

        const now = new Date();
        const expiresAt = new Date(result[0].override_expires_at);

        if (now < expiresAt) {
            log(`[Override] Активен для ${userId}. Бот молчит.`);
            return true;
        }

        // Срок истек — сбрасываем флаг
        await db.query(`UPDATE conversations SET admin_override = FALSE WHERE user_id = $1`, [userId]);
        log(`[Override] Срок истек для ${userId}. Бот снова в деле.`);
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
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${userId}`;
    
    const clientTopicId = await getOrCreateClientTopic(ctx);
    if (!clientTopicId) return;

    // Формируем ссылку на топик для быстрого перехода
    // Удаляем -100 из ID для корректной ссылки t.me/c/
    const cleanGroupId = Math.abs(ADMIN_GROUP_ID).toString().replace(/^100/, '');
    const clientTopicLink = `https://t.me/c/${cleanGroupId}/${clientTopicId}`;

    const alertText = `🔔 *КЛИЕНТ ГОТОВ К ПОКУПКЕ*\n\n` +
                      `👤 Клиент: ${username}\n` +
                      `💬 Сообщение: "${ctx.message.text || '[Медиа]'}"\n\n` +
                      `👉 [Перейти в диалог в топике](${clientTopicLink})`;

    try {
        await ctx.telegram.sendMessage(ADMIN_GROUP_ID, alertText, {
            parse_mode: 'Markdown',
            message_thread_id: botConfig.alerts_topic_id // Отправляем в спец. топик для алертов
        });
        log(`🚀 Алерт отправлен для клиента ${userId}`);
    } catch (error) {
        log(`❌ Ошибка отправки алерта: ${error.message}`);
    }
}

/**
 * Инкремент счетчика сообщений (Биллинг)
 */
async function incrementMessageCount(botId) {
    try {
        await db.query(`UPDATE usage_stats SET messages_this_month = messages_this_month + 1 WHERE bot_id = $1`, [botId]);
    } catch (error) {
        log(`❌ Ошибка биллинга: ${error.message}`);
    }
}

/**
 * ГЛАВНЫЙ ОБРАБОТЧИК
 */
export async function handleMessage(ctx) {
    // Реагируем только на текст и голос
    if (!ctx.message.text && !ctx.message.voice) return;
    
    const userId = ctx.from.id;
    const userMessage = ctx.message.text || '';

    try {
        // 1. Загружаем конфиг
        const botConfig = await loadBotConfig();
        if (!botConfig || !botConfig.openai_key) {
            log(`⚠️ Бот для ${userId} не настроен (нет API ключа)`);
            return await ctx.reply('Бот временно недоступен. Настройте API ключ в приложении.');
        }

        // 2. Проверяем режим "Менеджер в чате"
        if (await checkAdminOverride(userId)) return;

        // 3. Обработка голоса (заглушка)
        if (ctx.message.voice) {
            return await ctx.reply("Я пока лучше понимаю текст. Пожалуйста, напишите ваше сообщение текстом.");
        }

        // 4. Загружаем историю и сохраняем текущее сообщение
        const history = await loadConversationHistory(userId);
        await saveMessage(userId, 'user', userMessage);

        // 5. Запрос к ИИ
        const result = await llm.ask(botConfig, history, userMessage);

        // 6. Сохраняем ответ ИИ в базу
        await saveMessage(userId, 'assistant', result.text);

        // 7. Проверка: не пора ли звать менеджера?
        if (llm.isReadyForManager(userMessage, result.text)) {
            await sendManagerAlert(ctx, botConfig);
        }

        // 8. Обновляем статистику
        await incrementMessageCount(botConfig.id);

        // 9. Отвечаем пользователю
        await ctx.reply(result.text);

    } catch (error) {
        log(`❌ Ошибка обработки: ${error.message}`);
        
        let errorMessage = 'Извините, возникла техническая проблема. Мы уже исправляем её.';
        
        if (error.message === 'database_error') {
            errorMessage = 'Проблемы со связью с базой данных. Попробуйте через минуту.';
        }
        
        await ctx.reply(errorMessage);
    }
}