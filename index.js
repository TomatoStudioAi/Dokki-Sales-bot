import { Telegraf } from 'telegraf';
import express from 'express';
import cors from 'cors';
import { db } from './services/database.js';
import { handleMessage } from './handlers/message.js';
import configRoutes from './routes/config.js';
import pricesRoutes from './routes/prices.js';

// Универсальный логгер с меткой времени
const log = (msg) => console.log(`[${new Date().toISOString()}] [SYSTEM] ${msg}`);

const port = process.env.PORT || 3000;

// Railway/Fly.io домен
const webhookDomain = process.env.WEBHOOK_DOMAIN || 
                     process.env.RAILWAY_PUBLIC_DOMAIN || 
                     process.env.RAILWAY_STATIC_URL;

const app = express();

// --- 1. MIDDLEWARE ---
app.use(cors());
app.use(express.json());

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
 * НОВЫЙ ЭНДПОИНТ: Обновление системного промпта
 * Вызывается из Flutter-приложения
 */
app.post('/api/update-prompt', async (req, res) => {
    try {
        const { telegram_username, system_prompt } = req.body;

        if (!telegram_username) {
            return res.status(400).json({ error: 'telegram_username обязательно' });
        }

        // Очищаем username от символа @ для поиска в БД
        const cleanUsername = telegram_username.startsWith('@') 
            ? telegram_username.substring(1) 
            : telegram_username;

        log(`[API] Обновление промпта для @${cleanUsername}`);

        // Сохраняем в базу данных
        await db.updateBotPrompt(cleanUsername, system_prompt);

        res.json({ success: true, message: 'Промпт успешно обновлен' });
    } catch (e) {
        log(`❌ Ошибка API /update-prompt: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Health check
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

// --- 3. ЗАПУСК ИНФРАСТРУКТУРЫ И БОТА ---

async function startApp() {
    try {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            throw new Error('TELEGRAM_BOT_TOKEN не найден!');
        }

        await db.init();
        log('✅ База данных инициализирована');

        const bot = new Telegraf(token);

        // Обработка /start
        bot.start(async (ctx) => {
            try {
                const rawUsername = ctx.botInfo?.username;
                if (!rawUsername) return ctx.reply('Здравствуйте!');

                const botData = await db.getBotConfig(rawUsername);
                
                if (!botData) {
                    log(`⚠️ Бот @${rawUsername} не найден в БД`);
                    return ctx.reply('Бот настраивается. Сохраните настройки в приложении.');
                }

                const businessName = botData.business_name || 'нашей компании';
                const welcomeText = botData.welcome_message || 
                    `Здравствуйте! 👋 Я AI-консультант компании ${businessName}. Чем могу помочь?`;
                
                return ctx.reply(welcomeText);
            } catch (e) {
                log(`❌ Ошибка /start: ${e.message}`);
                return ctx.reply('Здравствуйте! Я готов к работе.');
            }
        });

        bot.on(['text', 'voice'], handleMessage);

        if (webhookDomain) {
            const webhookPath = `/telegram-webhook/${token}`;
            const webhookUrl = `https://${webhookDomain}${webhookPath}`;
            
            await bot.telegram.setWebhook(webhookUrl, {
                drop_pending_updates: true,
                allowed_updates: ['message', 'callback_query']
            });
            
            app.use(bot.webhookCallback(webhookPath));
            log(`✅ Webhook активен: ${webhookUrl}`);
        } else {
            await bot.telegram.deleteWebhook();
            bot.launch();
            log('🚀 Режим POLLING');
        }
        
        app.listen(port, () => {
            log(`✅ Сервер запущен на порту ${port}`);
        });

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
    } catch (error) {
        log(`❌ КРИТИЧЕСКАЯ ОШИБКА: ${error.message}`);
        process.exit(1);
    }
}

startApp();