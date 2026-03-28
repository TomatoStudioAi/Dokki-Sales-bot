import { Telegraf } from 'telegraf';
import express from 'express';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';

// TODO: Импортировать после создания handlers/admin.js
// import { handleAdminOverride } from './handlers/admin.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;

if (!token) {
    log('❌ КРИТИЧЕСКАЯ ОШИБКА: BOT_TOKEN не найден в переменных окружения!');
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

const DEFAULT_WELCOME_TEMPLATE = `Здравствуйте! 👋

Я AI-консультант компании {{business_name}}.

Помогу вам:
✅ Подобрать подходящие услуги
✅ Рассчитать стоимость
✅ Ответить на вопросы

Чем могу помочь?`;

// Middleware
app.use(express.json());

// API Routes
app.use('/api/config', configRoutes);

/**
 * Health check с проверкой БД
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
 * Обработка команды /start
 */
bot.start(async (ctx) => {
    try {
        const sql = `SELECT welcome_message, business_name FROM bot_config LIMIT 1`;
        const result = await db.query(sql);
        
        if (!result[0]) {
            return ctx.reply('Здравствуйте! Чем могу помочь?');
        }
        
        const { welcome_message, business_name } = result[0];
        const name = business_name || 'нашей компании';
        
        let welcomeText;
        
        if (welcome_message && welcome_message.trim().length > 0) {
            welcomeText = welcome_message;
        } else {
            welcomeText = DEFAULT_WELCOME_TEMPLATE.replace(
                /{{business_name}}/g, 
                name
            );
        }
        
        return ctx.reply(welcomeText);
        
    } catch (error) {
        log(`❌ Ошибка /start: ${error.message}`);
        return ctx.reply('Здравствуйте! Чем могу помочь?');
    }
});

// Основные обработчики
bot.on(['text', 'voice'], handleMessage);

// Запуск приложения
async function startApp() {
    try {
        bot.launch();
        log('✅ Telegraf бот запущен');

        app.listen(port, () => {
            log(`✅ Express сервер слушает порт ${port}`);
        });
    } catch (error) {
        log(`❌ Ошибка запуска: ${error.message}`);
    }
}

startApp();

// Graceful shutdown
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    log('Бот остановлен (SIGINT)');
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    log('Бот остановлен (SIGTERM)');
});