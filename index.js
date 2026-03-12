import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';

const bot = new Telegraf(config.telegram.token);

// Системный промпт (Манифест Алексея)
const SYSTEM_PROMPT = `
You are Alexey, Senior Manager at I.T.C Solutions FZE (TomatoStudio).
Your style: professional, concise, expert. 
IMPORTANT: Respond in the SAME LANGUAGE as the client (RU/EN/AR).
If client asks for pricing -> suggest a meeting.
Goal: Qualify the lead and close for a call.
`;

// Помощник для определения языка
function detectLanguage(text) {
    if (/[а-яА-ЯёЁ]/.test(text)) return 'ru';
    if (/[\u0600-\u06FF]/.test(text)) return 'ar';
    return 'en';
}

/**
 * ОБРАБОТКА СООБЩЕНИЙ ОТ КЛИЕНТОВ
 */
bot.on('message', async (ctx) => {
    // Игнорируем сообщения в админ-группе (они обрабатываются отдельно)
    if (ctx.chat.id.toString() === config.telegram.adminGroupId.toString()) {
        return handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    const text = ctx.message.text || "[Медиа-сообщение]";
    const lang = detectLanguage(text);

    try {
        // 1. Ищем или создаем топик в БД
        let userTopic = await db.getTopic(userId);
        
        if (!userTopic) {
            const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: ctx.from.username,
                first_name: ctx.from.first_name
            });
            console.log(`✅ Новый клиент: ${ctx.from.first_name} (ID: ${userId})`);
        }

        // 2. Пересылаем сообщение клиента в админ-группу (в нужный топик)
        await ctx.telegram.sendMessage(config.telegram.adminGroupId, `<b>Клиент:</b> ${text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // 3. Если админ перехватил диалог (override), бот молчит
        if (userTopic.admin_override) return;

        // 4. Получаем историю и выбираем модель
        const history = await db.getHistory(userId);
        const model = llm.selectModel(text, history.length / 2, history);

        // Имитация печатания
        await ctx.sendChatAction('typing');

        // 5. Запрос к ИИ
        const aiResponse = await llm.ask(model, SYSTEM_PROMPT, history, text);

        // 6. Отвечаем клиенту
        await ctx.reply(aiResponse.text);

        // 7. Дублируем ответ бота в админ-топик
        await ctx.telegram.sendMessage(config.telegram.adminGroupId, `<b>Алексей (ИИ):</b> ${aiResponse.text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // 8. Логируем в Supabase
        await db.logMessage({
            user_id: userId,
            message_text: text,
            bot_response: aiResponse.text,
            model_used: aiResponse.model,
            tokens_input: aiResponse.tokens.input_tokens,
            tokens_output: aiResponse.tokens.output_tokens,
            cost_usd: aiResponse.cost,
            language: lang
        });

        console.log(`🤖 Ответ (${aiResponse.model}): $${aiResponse.cost}`);

    } catch (error) {
        console.error('❌ Ошибка в обработчике клиента:', error);
    }
});

/**
 * ОБРАБОТКА ОТВЕТОВ ИЗ АДМИН-ГРУППЫ
 */
async function handleAdminReply(ctx) {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return; // Игнорируем General чат

    try {
        // Находим клиента по topic_id
        const { data: userTopic, error } = await db.supabase
            .from('user_topics')
            .select('*')
            .eq('topic_id', topicId)
            .single();

        if (userTopic) {
            // Пересылаем ответ админа клиенту
            await ctx.telegram.sendMessage(userTopic.user_id, ctx.message.text);
            
            // Включаем режим перехвата (бот перестает отвечать сам)
            await db.setOverride(userTopic.user_id, true);
            console.log(`💬 Админ взял управление в топике #${topicId}`);
        }
    } catch (e) {
        console.error('❌ Ошибка реплая админа:', e);
    }
}

// Запуск
bot.launch().then(() => console.log('🚀 Бот "Алексей" запущен и готов к работе!'));

// Остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));