import OpenAI from 'openai';
import fs from 'fs';
import { db } from './database.js';
import { SALES_SERVICES_PROMPT } from '../prompts/sales-services.js';

// Хелпер для логирования с меткой времени
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

export const llm = {
    /**
     * Инициализация клиента OpenAI (BYOK)
     */
    _getClient(apiKey) {
        return new OpenAI({ apiKey });
    },

    /**
     * Расшифровка голосовых (Whisper)
     */
    async transcribe(filePath, apiKey) {
        const openai = this._getClient(apiKey);
        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: 'whisper-1',
            });
            return transcription.text;
        } catch (error) {
            log(`❌ Ошибка Whisper: ${error.message}`);
            throw new Error('Не удалось расшифровать аудио. Пожалуйста, напишите текстом.');
        }
    },

    /**
     * Поиск по прайсу через PostgreSQL FTS
     */
    async getRelevantKnowledge(userInput, language = 'russian') {
        try {
            const countResult = await db.query('SELECT COUNT(*) as total FROM prices');
            const total = countResult[0]?.total || 0;
            
            // Безопасная проверка количества позиций
            if (Number(total) === 0) {
                log('⚠️ [FTS] Прайс пустой');
                return "";
            }

            const searchTerms = userInput.trim();
            const sql = `
                SELECT name, description, price, category
                FROM prices
                WHERE fts_index @@ websearch_to_tsquery($1, $2)
                OR name ILIKE $3
                OR description ILIKE $3
                ORDER BY ts_rank(fts_index, websearch_to_tsquery($1, $2)) DESC
                LIMIT 10
            `;
            
            const data = await db.query(sql, [language, searchTerms, `%${searchTerms}%`]);

            if (!data || data.length === 0) {
                log(`⚠️ [FTS] Ничего не найдено для: "${searchTerms}"`);
                return "";
            }

            log(`✅ [FTS] Найдено позиций: ${data.length}`);

            return `\n\nАКТУАЛЬНЫЙ ПРАЙС-ЛИСТ И УСЛУГИ:\n` + data.map(item => 
                `Услуга: ${item.name}\nЦена: ${item.price}\nОписание: ${item.description}`
            ).join('\n\n---\n\n');
        } catch (err) {
            log(`⚠️ Ошибка FTS: ${err.message}`);
            return ""; 
        }
    },

    /**
     * Подготовка системного промпта с подстановкой переменных
     */
    _prepareSystemPrompt(template, businessName, knowledge) {
        const baseTemplate = template || SALES_SERVICES_PROMPT;
        const promptWithBusiness = baseTemplate.replace(/{{business_name}}/g, businessName);
        return `${promptWithBusiness}\n\n${knowledge}`;
    },

    /**
     * Логика выбора модели (Спецификация Dokki)
     */
    _needsAdvancedModel(userMessage, knowledge) {
        // Если база знаний выдала много данных или запрос сложный
        if (knowledge.length > 500) return true;
        
        const complexPatterns = [
            /что лучше|сравни|порекоменду|чем отличается/i,
            /подбери|помоги выбрать|какой вариант/i,
            /сколько будет стоить|рассчитай|составь смету/i,
            /анализ|преимущества|выгода/i
        ];
        
        return complexPatterns.some(pattern => pattern.test(userMessage));
    },

    /**
     * Определение готовности клиента к передаче менеджеру
     */
    isReadyForManager(userMessage, aiResponse) {
        const clientReadyPatterns = [
            /хочу купить|оформить заказ|давайте сделаем/i,
            /когда можете начать|готов обсудить|свяжитесь со мной/i,
            /напишите менеджер|позвоните|договор/i,
            /давайте встретимся|готов заказать/i,
            /как оплатить|где оплатить|реквизиты/i,
            /отправьте счет|выставьте счет/i,
            /хочу обсудить|нужна консультация менеджера/i
        ];

        const botHandoffPatterns = [
            /передам.*менеджер/i,
            /свяжется с вами/i,
            /обсудить детали/i,
            /менеджер ответит/i
        ];

        return clientReadyPatterns.some(p => p.test(userMessage)) ||
               botHandoffPatterns.some(p => p.test(aiResponse));
    },

    /**
     * Основной метод запроса
     */
    async ask(botConfig, history, userMessage) {
        const { openai_key, business_name, system_prompt } = botConfig;
        const openai = this._getClient(openai_key);

        const knowledge = await this.getRelevantKnowledge(userMessage);
        const fullSystemPrompt = this._prepareSystemPrompt(system_prompt, business_name, knowledge);

        // Роутинг моделей строго по ТЗ Dokki
        const model = this._needsAdvancedModel(userMessage, knowledge)
            ? "gpt-4.1-mini"  
            : "gpt-4o-mini";  

        log(`[LLM] Запрос для "${business_name}". Модель: ${model}`);

        try {
            const res = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: fullSystemPrompt },
                    ...history.slice(-10), // Лимит контекста для кэширования
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.7,
            });

            return {
                text: res.choices[0].message.content,
                model,
                tokens: {
                    input: res.usage.prompt_tokens,
                    output: res.usage.completion_tokens
                }
            };

        } catch (error) {
            log(`❌ Ошибка OpenAI (${model}): ${error.message}`);
            
            if (error.status === 401) throw new Error('Ошибка: Неверный API ключ в настройках бота.');
            if (error.status === 429) throw new Error('Ошибка: Лимит запросов исчерпан или недостаточно средств в OpenAI.');
            if (error.status === 500) throw new Error('Ошибка: Сервис OpenAI временно недоступен.');
            
            throw new Error('Извините, возникли технические сложности. Попробуйте написать позже.');
        }
    }
};