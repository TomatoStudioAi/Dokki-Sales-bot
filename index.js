import { Telegraf } from 'telegraf';
import express from 'express';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

// Универсальный логгер с временной меткой
const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

// Конфигурация из среды (Railway)
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;

if (!token) {
    log('❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не найден в переменных окружения!');
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

// --- НЕЙТРАЛЬНЫЕ ШАБЛОНЫ (White Label Fallback) ---
const DEFAULT_FALLBACK_NAME = 'нашей компании';
const DEFAULT_WELCOME_TEMPLATE = `Здравствуйте! 👋 Я AI-консультант компании {{business_name}}. Чем могу помочь?`;

// Middleware
app.use(express.json());

// API эндпоинты для Flutter-приложения
app.use('/api/config', configRoutes);
app.use('/api/prices', pricesRoutes);

/**
 * Health check — мониторинг работоспособности сервера и БД
 */
app.get('/', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ 
            status: 'ok', 
            database: 'connected',
            timestamp: new Date().toISOString(),
            service: 'White Label Bot Engine'
        });
    } catch (e) {
        log(`❌ Health check failed: ${e.message}`);
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

/**
 * Обработка команды /start
 * Реализует динамическую идентификацию клиента с защитой от ошибок регистра
 */
bot.start(async (ctx) => {
    try {
        const rawUsername = ctx.botInfo?.username;
        if (!rawUsername) {
            log('⚠️ Не удалось получить username бота через ctx.botInfo');
            return ctx.reply('Здравствуйте! Чем я могу вам помочь?');
        }

        // НОРМАЛИЗАЦИЯ: приводим к нижнему регистру и добавляем @, если её нет
        const botUsername = rawUsername.startsWith('@') 
            ? rawUsername.toLowerCase() 
            : `@${rawUsername.toLowerCase()}`;

        log(`[START] Бот ${botUsername} обрабатывает команду /start для пользователя ${ctx.from.id}`);

        // БРОНЕБОЙНЫЙ ПОИСК: игнорируем регистр и пробелы в базе данных
        const res = await db.query(
            `SELECT business_name, welcome_message 
             FROM bots 
             WHERE LOWER(TRIM(telegram_username)) = LOWER(TRIM($1))`,
            [botUsername]
        );
        
        const botData = res[0];

        // Если бот не найден в базе
        if (!botData) {
            log(`⚠️ Бот ${botUsername} не найден в БД. Используется fallback-заглушка.`);
            return ctx.reply('Здравствуйте! Бот находится в процессе настройки. Пожалуйста, попробуйте позже.');
        }

        const { business_name, welcome_message } = botData;
        const name = business_name || DEFAULT_FALLBACK_NAME;

        // Приоритет: 1. Кастомное приветствие -> 2. Нейтральный шаблон
        const text = welcome_message || DEFAULT_WELCOME_TEMPLATE.replace('{{business_name}}', name);
        
        return ctx.reply(text);
    } catch (e) {
        log(`❌ Ошибка /start для @${ctx.botInfo?.username}: ${e.message}`);
        return ctx.reply('Здравствуйте! Чем я могу вам помочь?');
    }
});

/**
 * Передача всех текстовых и голосовых сообщений в основной хендлер
 */
bot.on(['text', 'voice'], handleMessage);

/**
 * Запуск инфраструктуры (Корректный порядок асинхронных операций)
 */
async function startApp() {
    try {
        // 1. Инициализируем таблицы БД
        await db.init();
        log('✅ База данных инициализирована (Production Schema)');

        // 2. Запускаем Telegram-движок (polling)
        await bot.launch();
        
        // 3. Явно получаем данные о боте через API, чтобы избежать @unknown
        const botInfo = await bot.telegram.getMe();
        log(`✅ Telegraf бот @${botInfo.username} успешно запущен`);

        // 4. Запускаем API-сервер для Flutter
        app.listen(port, () => {
            log(`✅ API сервер запущен на порту ${port}`);
        });
    } catch (error) {
        log(`❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА: ${error.message}`);
        process.exit(1);
    }
}

startApp();

// Корректное завершение при остановке контейнера на Railway
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    log('Бот остановлен (SIGINT)');
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    log('Бот остановлен (SIGTERM)');
});