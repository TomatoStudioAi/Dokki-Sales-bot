import { Telegraf } from 'telegraf';
import express from 'express';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

// Универсальный логгер
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

// --- НЕЙТРАЛЬНЫЕ ШАБЛОНЫ (White Label) ---
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
 * Реализует динамическую идентификацию клиента без хардкода ID
 */
bot.start(async (ctx) => {
    try {
        // Динамически получаем юзернейм текущего бота
        const botUsername = `@${ctx.botInfo.username}`;
        
        // Ищем настройки именно этого бота в базе
        const res = await db.query(
            'SELECT business_name, welcome_message FROM bots WHERE telegram_username = $1',
            [botUsername]
        );
        
        const botData = res[0];

        // Если бот не найден в базе (новый клиент еще не зарегистрировался через приложение)
        if (!botData) {
            log(`⚠️ Попытка старта незарегистрированного бота: ${botUsername}`);
            return ctx.reply('Здравствуйте! Бот находится в процессе настройки. Пожалуйста, попробуйте позже.');
        }

        const { business_name, welcome_message } = botData;
        const name = business_name || DEFAULT_FALLBACK_NAME;

        // Приоритет: 1. Кастомное приветствие клиента -> 2. Нейтральный шаблон с названием компании
        const text = welcome_message || DEFAULT_WELCOME_TEMPLATE.replace('{{business_name}}', name);
        
        return ctx.reply(text);
    } catch (e) {
        log(`❌ Ошибка выполнения /start для @${ctx.botInfo.username}: ${e.message}`);
        return ctx.reply('Здравствуйте! Чем я могу вам помочь?');
    }
});

/**
 * Передача всех текстовых и голосовых сообщений в основной хендлер
 */
bot.on(['text', 'voice'], handleMessage);

/**
 * Запуск инфраструктуры
 */
async function startApp() {
    try {
        // 1. Инициализируем таблицы БД (если их нет)
        await db.init();
        log('✅ База данных готова (Production Schema)');

        // 2. Запускаем Telegram-движок
        bot.launch();
        log(`✅ Бот @${bot.botInfo?.username || 'unknown'} успешно запущен`);

        // 3. Запускаем API-сервер для Flutter
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