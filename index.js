import { Telegraf } from 'telegraf';
import express from 'express';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

// Конфигурация из переменных окружения Railway
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;

if (!token) {
    log('❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не найден!');
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

const DEFAULT_WELCOME = `Здравствуйте! 👋\nЯ AI-консультант. Чем могу вам помочь?`;

// --- MIDDLEWARE & ROUTES ---
app.use(express.json());

// API для настроек и прайса
app.use('/api/config', configRoutes);
app.use('/api/prices', pricesRoutes);

/**
 * Health check: проверяет статус бота и доступность БД
 */
app.get('/', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ 
            status: 'ok', 
            bot: 'online', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        log(`[HEALTH CHECK ERROR] ${error.message}`);
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

/**
 * Обработка /start: берем данные из таблицы bots (Multi-bot logic)
 */
bot.start(async (ctx) => {
    try {
        const botUsername = ctx.botInfo.username;
        
        // Ищем настройки конкретно для этого бота
        const botData = await db.query(
            'SELECT business_name, welcome_message FROM bots WHERE telegram_username = $1 OR id = 1 LIMIT 1',
            [botUsername]
        );

        if (!botData[0]) {
            log(`⚠️ Бот @${botUsername} не найден в таблице bots`);
            return ctx.reply(DEFAULT_WELCOME);
        }

        const { welcome_message, business_name } = botData[0];
        const text = welcome_message || DEFAULT_WELCOME.replace('AI-консультант', `AI-консультант компании ${business_name}`);
        
        return ctx.reply(text);
    } catch (error) {
        log(`❌ Ошибка /start: ${error.message}`);
        return ctx.reply(DEFAULT_WELCOME);
    }
});

/**
 * Основной хендлер сообщений
 */
bot.on(['text', 'voice'], handleMessage);

/**
 * ЗАПУСК ПРИЛОЖЕНИЯ
 */
async function startApp() {
    try {
        log('⏳ Инициализация базы данных...');
        // Создает все таблицы (bots, products, messages, usage_logs) автоматически
        await db.init();
        log('✅ Структура БД проверена и готова');

        // Запуск Telegram бота
        const botInfo = await bot.telegram.getMe();
        bot.launch();
        log(`✅ Бот @${botInfo.username} запущен`);

        // Запуск Express сервера для API (Flutter/Postman)
        app.listen(port, () => {
            log(`✅ Express сервер слушает порт ${port}`);
        });

    } catch (error) {
        log(`❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА: ${error.message}`);
        process.exit(1);
    }
}

startApp();

// Graceful shutdown (корректное завершение)
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    log('Process SIGINT: Бот остановлен');
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    log('Process SIGTERM: Бот остановлен');
});