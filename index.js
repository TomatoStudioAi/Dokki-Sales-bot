import { Telegraf } from 'telegraf';
import fs from 'fs';
import https from 'https';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';

const bot = new Telegraf(config.telegram.token);

// Манифест Алексея (2026 Edition)
const SYSTEM_PROMPT = `
You are Alexey, Senior Manager at I.T.C Solutions FZE (TomatoStudio).
Your style: professional, concise, expert. 
IMPORTANT: Respond in the SAME LANGUAGE as the client (RU/EN/AR).
If client asks for pricing -> suggest a meeting.
Goal: Qualify the lead and close for a call.
`;

/**
 * Вспомогательная функция для скачивания файлов
 */
async function downloadVoice(fileLink, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(fileLink, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            reject(err);
        });
    });
}

function detectLanguage(text) {
    if (/[а-яА-ЯёЁ]/.test(text)) return 'ru';
    if (/[\u0600-\u06FF]/.test(text)) return 'ar';
    return 'en';
}

/**
 * 1. ОБРАБОТКА ВХОДЯЩИХ ЧЕРЕЗ TELEGRAM BUSINESS (Личный аккаунт)
 */
bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage;
    const userId = msg.from.id;
    const connectionId = ctx.businessConnectionId;
    
    let text = msg.text || msg.caption || '';
    const isVoice = !!msg.voice;

    try {
        // Если пришел голос — расшифровываем
        if (isVoice) {
            await ctx.sendChatAction('typing');
            const fileLink = await ctx.telegram.getFileLink(msg.voice.file_id);
            const filePath = `./voice_${msg.voice.file_id}.oga`;
            
            await downloadVoice(fileLink, filePath);
            text = await llm.transcribe(filePath);
            
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        if (!text && !isVoice) return; // Игнорируем пустые медиа без текста
        const lang = detectLanguage(text);

        // Поиск/Создание топика
        let userTopic = await db.getTopic(userId);
        if (!userTopic) {
            const topicId = await topics.create(ctx, msg.from.first_name, msg.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: msg.from.username || 'n/a',
                first_name: msg.from.first_name
            });
        }

        // Пересылаем в админ-группу
        const label = isVoice ? '🎤 <b>[Голос] Клиент:</b>' : '<b>Клиент:</b>';
        await ctx.telegram.sendMessage(config.telegram.adminGroupId, `${label} ${text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // Если включен ручной режим — бот не отвечает
        if (userTopic.admin_override) return;

        // Работа ИИ
        const history = await db.getHistory(userId);
        const model = llm.selectModel(text, history.length / 2, history);

        await ctx.sendChatAction('typing');
        const aiResponse = await llm.ask(model, SYSTEM_PROMPT, history, text);

        // Ответ клиенту через бизнес-канал
        await ctx.telegram.sendMessage(msg.chat.id, aiResponse.text, {
            business_connection_id: connectionId
        });

        // Дубликат ответа ИИ в группу
        await ctx.telegram.sendMessage(config.telegram.adminGroupId, `🤖 <b>Алексей (ИИ):</b> ${aiResponse.text}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // Лог в базу
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

    } catch (error) {
        console.error('❌ Ошибка Business Message:', error);
    }
});

/**
 * 2. ОБРАБОТКА ОТВЕТОВ ИЗ АДМИН-ГРУППЫ
 */
bot.on('message', async (ctx) => {
    // Если сообщение из админ-группы — передаем в хендлер
    if (ctx.chat.id.toString() === config.telegram.adminGroupId.toString()) {
        await handleAdminReply(ctx);
    }
});

// Запуск
bot.launch().then(() => {
    console.log('🚀 Бот "Алексей" успешно запущен!');
    console.log('📡 Режим: Telegram Business + Supergroup Topics');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));