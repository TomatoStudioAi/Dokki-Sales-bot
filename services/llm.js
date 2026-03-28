import OpenAI from 'openai';
import fs from 'fs';
import { db } from './database.js';
import { encrypt, decrypt } from './encryption.js';
import { SALES_SERVICES_PROMPT } from '../prompts/sales-services.js';

const log = (msg) => console.log(`[${new Date().toISOString()}] [LLM_SERVICE] ${msg}`);

class LLMService {
    /**
     * Инициализация клиента OpenAI (BYOK - Bring Your Own Key)
     */
    _getClient(apiKey) {
        if (!apiKey) throw new Error('API ключ OpenAI не предоставлен');
        return new OpenAI({ apiKey });
    }

    /**
     * Валидация ключа перед сохранением в БД
     */
    async validateOpenAIKey(apiKey) {
        try {
            const openai = new OpenAI({ apiKey });
            // Запрашиваем список моделей, чтобы проверить работоспособность ключа
            await openai.models.list();
            return true;
        } catch (error) {
            log(`⚠️ Валидация ключа провалилась: ${error.message}`);
            return false;
        }
    }

    /**
     * Расшифровка голосовых сообщений (Whisper)
     */
    async transcribe(filePath, encryptedApiKey) {
        const decryptedKey = decrypt(encryptedApiKey);
        const openai = this._getClient(decryptedKey);
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
    }

    /**
     * Полнотекстовый поиск по прайсу (FTS) с привязкой к Bot ID
     */
    async getRelevantKnowledge(userInput, botId, language = 'russian') {
        try {
            const countRes = await db.query('SELECT COUNT(*) as total FROM products WHERE bot_id = $1', [botId]);
            if (parseInt(countRes[0].total) === 0) {
                return "";
            }

            const searchTerms = userInput.trim();
            const sql = `
                SELECT name, description, price, category
                FROM products
                WHERE bot_id = $1 AND (
                    search_vector @@ websearch_to_tsquery($2, $3)
                    OR name ILIKE $4
                    OR description ILIKE $4
                )
                ORDER BY ts_rank(search_vector, websearch_to_tsquery($2, $3)) DESC
                LIMIT 10
            `;
            
            const data = await db.query(sql, [botId, language, searchTerms, `%${searchTerms}%`]);

            if (!data || data.length === 0) {
                return "";
            }

            log(`✅ [FTS] Найдено позиций: ${data.length} для бота #${botId}`);

            return `\n\nАКТУАЛЬНЫЙ ПРАЙС-ЛИСТ И УСЛУГИ:\n` + data.map(item => 
                `Услуга: ${item.name}\nЦена: ${item.price} руб.\nОписание: ${item.description || 'Нет описания'}`
            ).join('\n\n---\n\n');
        } catch (err) {
            log(`⚠️ Ошибка FTS: ${err.message}`);
            return ""; 
        }
    }

    /**
     * Подготовка системного промпта
     */
    _prepareSystemPrompt(template, businessName, knowledge) {
        const baseTemplate = template || SALES_SERVICES_PROMPT;
        const promptWithBusiness = baseTemplate.replace(/{{business_name}}/g, businessName || 'нашей компании');
        return `${promptWithBusiness}\n\n${knowledge}`;
    }

    /**
     * Логика выбора модели (Dokki Spec)
     */
    _needsAdvancedModel(userMessage, knowledge) {
        if (knowledge.length > 800) return true;
        
        const complexPatterns = [
            /сравни|порекомендуй|выбери|лучше/i,
            /почему|как именно|анализ|преимущества/i,
            /смета|расчет|стоимость за все/i
        ];
        
        return complexPatterns.some(pattern => pattern.test(userMessage));
    }

    /**
     * Определение готовности к передаче менеджеру
     */
    isReadyForManager(userMessage, aiResponse) {
        const clientReadyPatterns = [
            /хочу купить|заказать|оплата|куда платить/i,
            /менеджер|человек|оператор|свяжитесь/i,
            /договор|счет|реквизиты/i
        ];

        const botHandoffPatterns = [
            /передам.*менеджер/i,
            /свяжется с вами/i,
            /обсудить детали/i
        ];

        return clientReadyPatterns.some(p => p.test(userMessage)) ||
               botHandoffPatterns.some(p => p.test(aiResponse));
    }

    /**
     * Основной метод генерации ответа
     */
    async ask(botConfig, history, userMessage) {
        const { id, openai_key, business_name, system_prompt } = botConfig;
        
        if (!openai_key) {
            throw new Error('У бота не настроен API ключ OpenAI.');
        }
        
        // Расшифровываем ключ перед использованием
        const decryptedKey = decrypt(openai_key);
        const openai = this._getClient(decryptedKey);

        const knowledge = await this.getRelevantKnowledge(userMessage, id);
        const fullSystemPrompt = this._prepareSystemPrompt(system_prompt, business_name, knowledge);

        const model = this._needsAdvancedModel(userMessage, knowledge)
            ? "gpt-4o"  
            : "gpt-4o-mini"; 

        log(`[LLM] Запрос бота #${id} (${business_name}). Модель: ${model}`);

        try {
            const res = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: fullSystemPrompt },
                    ...history,
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
            
            if (error.status === 401) throw new Error('Неверный API ключ OpenAI в настройках бота.');
            if (error.status === 429) throw new Error('Лимит запросов OpenAI исчерпан.');
            
            throw new Error('Сервис временно недоступен. Попробуйте позже.');
        }
    }
}

export const llm = new LLMService();