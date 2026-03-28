import { Telegraf } from 'telegraf';
import express from 'express';
import cors from 'cors';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

// Универсальный логгер с меткой времени
const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;

// Railway домен (авто-определение)
const webhookDomain = process.env.WEBHOOK_DOMAIN || 
                     process.env.RAILWAY_PUBLIC_DOMAIN || 
                     process.env.RAILWAY_STATIC_URL;

if (!token) {
    log('❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не найден в переменных окружения!');
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

// --- 1. MIDDLEWARE ---

// Разрешаем запросы из Flutter-приложения (CORS)
app.use(cors());

// Парсинг JSON для API (нужен для /api/config и /api/prices)
app.use(express.json());

// Логирование всех входящих API-запросов (кроме вебхуков Телеграма)
app.use((req, res, next) => {
    if (!req.path.includes('/telegram-webhook/')) {
        log(`${req.method} ${req.path}`);
    }
    next();
});

// --- 2. API МАРШРУТЫ ---
app.use('/api/config', configRoutes);
app.use('/api/prices', pricesRoutes);

/**
 * Health check — проверка работоспособности системы
 */
app.get('/', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ 
            status: 'ok', 
            mode: webhookDomain ? 'webhook' : 'polling',
            database: 'connected',
            server_time: new Date().toISOString()
        });
    } catch (e) {
        log(`❌ Health check failed: ${e.message}`);
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// --- 3. ЛОГИКА ТЕЛЕГРАМ-БОТА ---

/**
 * Обработка команды /start
 * Динамически подгружает настройки бренда из БД
 */
bot.start(async (ctx) => {
    try {
        const rawUsername = ctx.botInfo?.username;
        if (!rawUsername) return ctx.reply('Здравствуйте! Чем могу помочь?');

        // Используем наш новый метод из Database.js
        const botData = await db.getBotConfig(rawUsername);
        
        if (!botData) {
            log(`⚠️ Бот @${rawUsername} не найден в БД при /start`);
            return ctx.reply('Здравствуйте! Бот находится в процессе настройки. Пожалуйста, сохраните настройки в приложении Dokki.');
        }

        const businessName = botData.business_name || 'нашей компании';
        const welcomeText = botData.welcome_message || 
            `Здравствуйте! 👋 Я AI-консультант компании ${businessName}. Чем могу помочь?`;
        
        return ctx.reply(welcomeText);
    } catch (e) {
        log(`❌ Ошибка /start: ${e.message}`);
        return ctx.reply('Здравствуйте! Я готов к работе. Задайте свой вопрос.');
    }
});

// Основной обработчик (Текст, Голос, ИИ)
bot.on(['text', 'voice'], handleMessage);

// --- 4. ЗАПУСК ИНФРАСТРУКТУРЫ ---

async function startApp() {
    try {
        // 1. Инициализация структуры базы данных
        await db.init();
        
        if (webhookDomain) {
            // РЕЖИМ PRODUCTION (WEBHOOK)
            const webhookPath = `/telegram-webhook/${token}`;
            const webhookUrl = `https://${webhookDomain}${webhookPath}`;
            
            // Устанавливаем вебхук с очисткой старых обновлений
            await bot.telegram.setWebhook(webhookUrl, {
                drop_pending_updates: true,
                allowed_updates: ['message', 'callback_query']
            });
            
            // Подключаем обработчик вебхука к Express
            app.use(bot.webhookCallback(webhookPath));
            
            log(`✅ Webhook активен: ${webhookUrl}`);
        } else {
            // РЕЖИМ DEVELOPMENT (POLLING)
            await bot.telegram.deleteWebhook();
            bot.launch();
            log('🚀 Бот запущен в режиме POLLING (Local/Dev)');
        }
        
        // Запуск общего HTTP сервера
        app.listen(port, () => {
            log(`✅ Сервер (API + Webhook) запущен на порту ${port}`);
        });
        
    } catch (error) {
        log(`❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА: ${error.message}`);
        process.exit(1);
    }
}

startApp();

// Корректное завершение работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));