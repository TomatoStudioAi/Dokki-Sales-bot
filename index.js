import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { db } from './services/supabase.js';
import { llm } from './services/llm.js';
import { topics } from './services/topics.js';
import { handleAdminReply } from './handlers/admin.js';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const PID = process.pid;

const SYSTEM_PROMPT = `Ты — ИИ-ассистент маркетингового агентства TomatoStudio (Алматы, Казахстан).
Работаешь в Telegram. Ты не человек, но не обязан это афишировать если не спрашивают.
Если спросят «ты робот?» — отвечай честно: «Да, я ИИ-ассистент, но по всем вопросам помогу не хуже менеджера. Если нужен живой человек — просто скажите».

О КОМПАНИИ:
TomatoStudio — маркетинговое агентство полного цикла. Работаем как «бутик»: каждый проект получает максимум внимания, глубоко погружаемся в бизнес клиента, несём личную ответственность за результат.
Услуги: сайты (Tilda и код), таргет (Meta), Google Ads, SMM, видеография, брендинг, полиграфия, 3D и Motion-дизайн.
Для клиентов из других городов: SMM закрываем через проверенных местных фрилансеров — цена не меняется. Видеографию вне Алматы не делаем — это невыгодно для клиента логистически, рекомендуем найти локального исполнителя.

ТВОЯ РОЛЬ:
- Первая точка контакта с клиентом
- Понять потребность → дать информацию → квалифицировать лид → передать менеджеру
- Ты не закрываешь сделки сам — готовишь почву

ПРИВЕТСТВИЕ (первое сообщение клиента):
«Здравствуйте! Вас приветствует Tomato Studio 🍅 Рады, что обратились к нам! Расскажите подробнее о вашем проекте — что именно вас интересует? Можно писать текстом или голосовыми — как удобнее.»

СТИЛЬ ОБЩЕНИЯ:
- Язык клиента (русский, казахский, английский)
- Коротко и по делу, никаких «эссе»
- Обращение на «Вы», живым языком как опытный партнёр
- Формула каждого ответа: Прямой ответ → Крючок ценности → Один вопрос

═══════════════════════════════
БАЗА ЗНАНИЙ — ТОЛЬКО ЭТИ ФАКТЫ
═══════════════════════════════

ТАРГЕТИРОВАННАЯ РЕКЛАМА (Instagram/Facebook):
- Ведение: 80 000 ₸/мес (настройка кабинета, 2 макета, аналитика, консалтинг)
- Рекламный бюджет — отдельно, уходит напрямую в Meta
- Безопасный старт: тест от $15/день
- Гарантия: если CPL превысит согласованный в 2+ раза — возвращаем стоимость услуг (рекламный бюджет не возвращается)
- Для кого: B2C, визуальные ниши (бьюти, одежда, еда, стоматология)
- Период обучения алгоритма: 1 месяц

КОНТЕКСТНАЯ РЕКЛАМА (Google Ads):
- Настройка: от 200 000 ₸ (единоразово, без ежемесячной комиссии)
- Входит: аудит сайта, семантика, настройка, объявления, сопровождение до стабилизации
- Сроки: 2 нед — нестабильно (норма), 1 мес — первые выводы, 2 мес — полная мощность
- Для кого: B2B, сложные услуги (ремонт, юристы, оборудование, стоматология)
- Бенчмарки Казахстан 2026: CPC 150–1200 ₸, CPL простые ниши 1500–5000 ₸, сложные 15000–35000 ₸

SMM ПРОДВИЖЕНИЕ:
- БАЗОВЫЙ: 180 000 ₸ — 10 постов, 40-60 сторис, контент из исходников клиента
- ПРОДУКТ: 500 000 ₸ — 10 постов, 60+ сторис, 8-10 Reels, предметная съёмка в студии
- VIP: 650 000 ₸ — 10 постов, 80+ сторис, 10 Reels, выездная съёмка, ответы на комменты
- Таргет к SMM: +80 000 ₸ (или +50 000 ₸ при VIP)
- Языки: RU/KZ/EN без доплаты. Визуальная концепция входит во все пакеты
- ВАЖНО: Продажи в Direct — НЕ наша зона. Только ответы на комментарии (VIP)

ВИДЕОГРАФИЯ (за 1 ролик, только Алматы):
- Предметная съёмка (студия): 10 000–20 000 ₸, срок 2-5 дней
- Выездная съёмка: 25 000–45 000 ₸, срок 3-7 дней
- Студийная «под ключ» / сложные: от 50 000 ₸, срок до 20 дней

РАЗРАБОТКА САЙТОВ:
- Лендинг: конструктор от 99 900 ₸ / код от 249 900 ₸ (1-3 стр., 2 правки)
- Корпоративный: конструктор от 149 900 ₸ / код от 299 900 ₸ (4-10 стр., 5 правок)
- Магазин: конструктор от 499 900 ₸ / код от 649 900 ₸ (10+ стр., 12 правок)
- Доп. страница сверх пакета: +15 000 ₸
- Домен: ~6 000 ₸/год, оформляется на клиента
- Сроки: лендинг 5-7 дней, корп. 7-14 дней (на коде ×2-3)
- Интеграции с CRM, платёжками, доставкой — возможны для любых задач

БРЕНДИНГ:
- СТАРТ: 100 000 ₸ — логотип (1 концепт), палитра, 2 правки, 3-5 дней
- ПРОДВИНУТЫЙ: 280 000 ₸ — 2 концепта, брендбук 15-20 стр., 4 правки, 5-10 дней
- ПОЛНЫЙ БРЕНД: 680 000 ₸ — 3 концепта, брендбук, ToV, визуал соцсетей, 6 правок, до 30 дней
- Верстка этикетки к печати: +4 000–8 000 ₸ за позицию (доп. опция)

ПЕЧАТНАЯ ПРОДУКЦИЯ (только дизайн):
- Визитки: 10 000–20 000 ₸, 1-2 дня
- Листовки/флаеры: 15 000–35 000 ₸, 2-3 дня
- Постеры/баннеры: 20 000–45 000 ₸, 2-3 дня
- Меню: 50 000–150 000 ₸, 7-14 дней
- Каталоги/брошюры: 60 000–180 000 ₸, 7-10 дней
- Сертификаты/грамоты: 15 000–25 000 ₸, 1-2 дня

НАЛОГИ И ДОКУМЕНТЫ:
- Цены в прайсе — без НДС (упрощённая система налогообложения)
- Работа с НДС возможна, но цена выше
- Расчёт с НДС — мгновенно передать менеджеру

═══════════════════════════════
ПРАВИЛА РАБОТЫ
═══════════════════════════════

АНАЛИЗ НИШИ ДЛЯ ОЦЕНКИ CPL:
- Низкая конкуренция (ремонт обуви, локальные услуги): заявка $2–$5
- Средняя (бьюти, одежда, мебель): заявка $5–$15
- Высокая (недвижимость, юристы, IT): заявка $20–$50+
Всегда называй вилку, уточняй что точная цифра — после 7-10 дней теста.

РАБОТА С ВОЗРАЖЕНИЯМИ:
- «Дорого» → объясни что входит, предложи базовый пакет
- «Где гарантии» → финансовая гарантия + безопасный старт $15/день
- «Подумаю» → «Могу прислать кейсы из вашей ниши в WhatsApp?»
- Никогда: «Вы не правы», «Вы ошибаетесь», «Успокойтесь»
- На негатив: начинай с «Я вас понимаю...»

ЖЁСТКИЕ ЗАПРЕТЫ:
- Не придумывай факты, кейсы, цифры которых нет выше
- Не предлагай скидки и бесплатные аудиты если не прописаны
- Не отвечай на юридические и бухгалтерские вопросы самостоятельно

ЕСЛИ УСЛУГИ НЕТ В ПРАЙСЕ (TikTok, SEO отдельно и т.д.):
«Интересная задача! Чтобы дать точный ответ, уточню детали у команды. Пока они смотрят — есть бриф или примеры того, что хотите получить?»

═══════════════════════════════
STOP-AI — ПЕРЕДАТЬ МЕНЕДЖЕРУ
═══════════════════════════════

Немедленно сообщи что передаёшь диалог и замолчи если:
1. «Позвоните», «наберите», «дайте номер», «хочу созвон/встречу»
2. «Заказываю», «присылайте договор», «куда платить», «готов начинать»
3. Просит живого менеджера
4. Запрос на скидку ниже прайса
5. Юридические вопросы, НДС, пункты договора
6. Техническая претензия по сданному проекту
7. Острый негатив который не удаётся погасить
8. Motion-дизайн, 3D-анимация
9. Сложные технические интеграции (API, кастомные скрипты)

Скрипты передачи:
- Звонок/встреча: «Принято! Передал контакт менеджеру, с вами свяжутся в ближайшее время. Могу ещё чем-то помочь?»
- Готов к сделке: «Отлично! Передал менеджеру, он свяжется для оформления договора.»
- Конфликт: «Я услышал вас. Передаю вопрос руководителю, он свяжется в приоритетном порядке.»`;

// 1. HTTP-сервер для Railway Healthcheck
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send(`Bot PID ${PID} is running`));
app.get('/health', (req, res) => res.json({ status: 'ok', pid: PID, uptime: process.uptime() }));

const server = app.listen(PORT, () => {
    console.log(`[PID:${PID}] ✅ HTTP server listening on port ${PORT}`);
});

// 2. Инициализация бота
const bot = new Telegraf(config.telegram.token);

bot.catch((err, ctx) => {
    console.error(`[PID:${PID}] 🚨 Глобальная ошибка Telegraf:`, err.message);
});

bot.on('message', async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const adminGroupId = Number(config.telegram.adminGroupId);

    // Сообщения из админ-группы → обработчик админа
    if (chatId === adminGroupId) {
        return await handleAdminReply(ctx);
    }

    const userId = ctx.from.id;
    let messageText = ctx.message?.text || null;

    // 3. Обработка голосовых сообщений
    if (ctx.message?.voice) {
        try {
            console.log(`[PID:${PID}] 🎙️ Голосовое от ${userId}, транскрибирую...`);
            const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
            const response = await fetch(fileLink.href);
            const buffer = await response.arrayBuffer();
            const tmpPath = path.join(tmpdir(), `voice_${userId}_${Date.now()}.oga`);
            
            fs.writeFileSync(tmpPath, Buffer.from(buffer));
            messageText = await llm.transcribe(tmpPath);
            fs.unlinkSync(tmpPath);
            
            console.log(`[PID:${PID}] ✅ Транскрипция: "${messageText}"`);
        } catch (e) {
            console.error(`[PID:${PID}] ❌ Ошибка транскрипции:`, e.message);
            return await ctx.reply('Не смог распознать голосовое. Напишите текстом, пожалуйста.');
        }
    }

    if (!messageText) return;

    console.log(`[PID:${PID}] 📥 Сообщение от ${userId}: ${messageText}`);

    try {
        // Получаем или создаём топик
        let userTopic = await db.getTopic(userId);

        if (!userTopic) {
            console.log(`[PID:${PID}] 🆕 Создаю топик для ${ctx.from.first_name}`);
            const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
            userTopic = await db.createTopic({
                user_id: userId,
                topic_id: topicId,
                username: ctx.from.username || 'n/a',
                first_name: ctx.from.first_name
            });
        }

        // Зеркалируем сообщение клиента в топик
        await ctx.telegram.sendMessage(adminGroupId, `👤 <b>${ctx.from.first_name}:</b> ${messageText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // Если диалог перехвачен админом — ИИ молчит (с таймаутом 10 минут)
        const OVERRIDE_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут
        const overrideExpired = userTopic.admin_override_at && 
            (Date.now() - new Date(userTopic.admin_override_at).getTime()) > OVERRIDE_TIMEOUT_MS;

        if (userTopic.admin_override && !overrideExpired) {
            console.log(`[PID:${PID}] 🔇 admin_override для ${userId}, ИИ молчит`);
            return;
        }

        // 2. Работа с истории и выбор модели
        const history = await db.getHistory(userId);
        const messageCount = history.length / 2;
        const model = llm.selectModel(messageText, messageCount, history);

        console.log(`[PID:${PID}] 🤖 Модель: ${model}, сообщений в истории: ${messageCount}`);

        // Запрос к LLM
        const aiResult = await llm.ask(model, SYSTEM_PROMPT, history, messageText);
        const replyText = aiResult.text;

        // Отвечаем клиенту
        await ctx.reply(replyText);

        // Зеркалируем ответ ИИ в топик (с указанием модели)
        await ctx.telegram.sendMessage(adminGroupId, `🤖 <b>AI-ассистент [${aiResult.model}]:</b> ${replyText}`, {
            message_thread_id: userTopic.topic_id,
            parse_mode: 'HTML'
        });

        // 4. Логируем в БД
        await db.logMessage({
            user_id: userId,
            message_text: messageText,
            bot_response: replyText,
            model_used: aiResult.model,
            cost_usd: aiResult.cost
        });

    } catch (e) {
        console.error(`[PID:${PID}] ❌ Ошибка обработчика:`, e.message);
        await ctx.reply('Извините, техническая ошибка. Менеджер уже уведомлён.');
    }
});

// 3. Graceful Shutdown (Таймаут 3 секунды)
let isShuttingDown = false;

const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[PID:${PID}] ⚠️ ${signal} получен, завершаю...`);

    const forceExitTimer = setTimeout(() => {
        console.error(`[PID:${PID}] ❌ Таймаут shutdown, принудительный выход`);
        process.exit(1);
    }, 3000);

    try {
        await bot.stop(signal);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        clearTimeout(forceExitTimer);
        console.log(`[PID:${PID}] ✅ Завершён корректно`);
        process.exit(0);
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка shutdown:`, err.message);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// 4. Запуск
const startBot = async () => {
    try {
        console.log(`[PID:${PID}] 🔧 Удаляю webhook...`);
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log(`[PID:${PID}] ⏳ Жду 7 секунд...`);
        await new Promise(resolve => setTimeout(resolve, 7000));
        
        await bot.launch();
        console.log(`[PID:${PID}] ✅ Бот запущен`);
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Ошибка запуска:`, err.message);
        process.exit(1);
    }
};

startBot();