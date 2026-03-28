import { Telegraf } from 'telegraf';
import express from 'express';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

// Универсальный логгер
const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

// Конфигурация из переменных окружения
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;

// Railway автоматически предоставляет один из этих доменов
const webhookDomain = process.env.WEBHOOK_DOMAIN || 
                     process.env.RAILWAY_PUBLIC_DOMAIN || 
                     process.env.RAILWAY_STATIC_URL;

if (!token) {
    log('❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не найден!');
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

// --- НЕЙТРАЛЬНЫЕ ШАБЛОНЫ (White Label) ---
const DEFAULT_FALLBACK_NAME = 'нашей компании';
const DEFAULT_WELCOME_TEMPLATE = `Здравствуйте! 👋 Я AI-консультант компании {{business_name}}. Чем могу помочь?`;

// Middleware
app.use(express.json());

// API для Flutter
app.use('/api/config', configRoutes);
app.use('/api/prices', pricesRoutes);

/**
 * Health check
 */
app.get('/', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ 
            status: 'ok', 
            mode: webhookDomain ? 'webhook' : 'polling',
            database: 'connected'
        });
    } catch (e) {
        res.status(500).json({ status: 'error' });
    }
});

/**
 * Обработка /start с динамической идентификацией
 */
bot.start(async (ctx) => {
    try {
        const rawUsername = ctx.botInfo?.username;
        if (!rawUsername) return ctx.reply('Здравствуйте! Чем могу помочь?');

        const botUsername = rawUsername.startsWith('@') 
            ? rawUsername.toLowerCase() 
            : `@${rawUsername.toLowerCase()}`;

        const res = await db.query(
            `SELECT business_name, welcome_message 
             FROM bots 
             WHERE LOWER(TRIM(telegram_username)) = LOWER(TRIM($1))`,
            [botUsername]
        );
        
        const botData = res[0];
        if (!botData) {
            log(`⚠️ Бот ${botUsername} не найден в БД при /start`);
            return ctx.reply('Здравствуйте! Бот находится в процессе настройки. Пожалуйста, попробуйте позже.');
        }

        const name = botData.business_name || DEFAULT_FALLBACK_NAME;
        const text = botData.welcome_message || DEFAULT_WELCOME_TEMPLATE.replace('{{business_name}}', name);
        
        return ctx.reply(text);
    } catch (e) {
        log(`❌ Ошибка /start: ${e.message}`);
        return ctx.reply('Здравствуйте! Чем могу помочь?');
    }
});

// Основной обработчик сообщений
bot.on(['text', 'voice'], handleMessage);

/**
 * Запуск инфраструктуры
 */
async function startApp() {
    try {
        // 1. Инициализация БД
        await db.init();
        log('✅ База данных инициализирована');
        
        if (webhookDomain) {
            // --- РЕЖИМ WEBHOOK (Production) ---
            // Секретный путь для защиты от прямого спама на сервер
            const webhookPath = `/telegram-webhook/${token}`;
            const webhookUrl = `https://${webhookDomain}${webhookPath}`;
            
            // Очищаем старые хуки и конфликты polling
            await bot.telegram.deleteWebhook();
            
            // Устанавливаем новый webhook
            await bot.telegram.setWebhook(webhookUrl);
            
            // Подключаем Telegraf как middleware к Express
            app.use(bot.webhookCallback(webhookPath));
            
            log(`✅ Webhook установлен: ${webhookUrl}`);
            
            const botInfo = await bot.telegram.getMe();
            log(`✅ Бот @${botInfo.username} запущен в режиме WEBHOOK`);
            
        } else {
            // --- РЕЖИМ POLLING (Dev/Local) ---
            await bot.telegram.deleteWebhook();
            bot.launch();
            
            const botInfo = await bot.telegram.getMe();
            log(`✅ Бот @${botInfo.username} запущен в режиме POLLING (dev)`);
        }
        
        // 2. Запуск сервера (общий для API и Webhook)
        app.listen(port, () => {
            log(`✅ API сервер запущен на порту ${port}`);
        });
        
    } catch (error) {
        log(`❌ Ошибка запуска: ${error.message}`);
        process.exit(1);
    }
}

startApp();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));