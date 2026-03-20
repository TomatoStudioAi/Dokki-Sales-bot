import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import { config } from '../config/env.js';
import { calculateCost } from './cost-tracker.js';
import { db } from './supabase.js';

const openai = new OpenAI({ apiKey: config.ai.openaiKey });
const anthropic = new Anthropic({ apiKey: config.ai.anthropicKey });
const googleAi = new GoogleGenAI({ apiKey: config.ai.googleApiKey });

export const llm = {
    async transcribe(filePath) {
        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: 'whisper-1',
            });
            return transcription.text;
        } catch (error) {
            console.error('❌ Ошибка Whisper:', error.message);
            throw new Error('Не удалось расшифровать аудио');
        }
    },

    _normalizeMessages(messages) {
        if (messages.length === 0) return [];
        const normalized = [];
        for (const msg of messages) {
            const last = normalized[normalized.length - 1];
            if (last && last.role === msg.role) {
                last.content += `\n\n${msg.content}`;
            } else {
                normalized.push({ ...msg });
            }
        }
        return normalized;
    },

    // Мульти-RAG: Собирает все подходящие категории знаний
    async getRelevantKnowledge(userInput) {
        const input = userInput.toLowerCase().trim();
        const foundCategories = new Set();

        // Поиск всех совпадений
        if (input.includes('сайт') || input.includes('тильда') || input.includes('tilda') || input.includes('разработка')) foundCategories.add('sites');
        if (input.includes('smm') || input.includes('смм') || input.includes('инстаграм') || input.includes('продвижение') || input.includes('вип') || input.includes('пакет')) foundCategories.add('smm');
        if (input.includes('таргет') || input.includes('meta') || input.includes('фейсбук') || input.includes('реклама') || input.includes('facebook')) foundCategories.add('ads_target');
        if (input.includes('google') || input.includes('гугл') || input.includes('контекст') || input.includes('поиск')) foundCategories.add('ads_google');
        if (input.includes('видео') || input.includes('ролик') || input.includes('съемка') || input.includes('съёмка') || input.includes('мобилограф') || input.includes('рилс') || input.includes('reels')) foundCategories.add('video');
        if (input.includes('лого') || input.includes('бренд') || input.includes('стиль') || input.includes('айдентика') || input.includes('дизайн')) foundCategories.add('branding');
        if (input.includes('печать') || input.includes('визитк') || input.includes('меню')) foundCategories.add('print');
        if (input.includes('гарант') || input.includes('договор') || input.includes('оплата') || input.includes('ндс') || input.includes('результат')) foundCategories.add('guarantees');

        if (foundCategories.size === 0) return "";

        const categoriesArray = Array.from(foundCategories);
        console.log(`[RAG] 🔍 Попытка загрузки категорий: ${categoriesArray.join(', ')}`);

        try {
            const { data, error } = await db.supabase
                .from('kb_entries')
                .select('content')
                .in('category', categoriesArray);

            if (error || !data || data.length === 0) return "";

            console.log(`[RAG] ✅ Загружено блоков: ${data.length}`);
            const combinedContent = data.map(item => item.content).join('\n\n---\n\n');
            return `\n\nИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ:\n${combinedContent}`;
        } catch (err) {
            console.error('⚠️ Ошибка RAG:', err.message);
            return "";
        }
    },

    selectModel(text, messageCount, history) {
        const input = text.toLowerCase().trim();
        const isSimple = input.length < 15 ||
            ['привет', 'здравствуй', 'салем', 'хай'].some(w => input.includes(w));
        return isSimple ? config.ai.models.filter : config.ai.models.expert;
    },

    async ask(model, systemPrompt, history, userMessage) {
        const extraKnowledge = await this.getRelevantKnowledge(userMessage);
        const fullSystemPrompt = systemPrompt + extraKnowledge;

        const rawMessages = [...history, { role: 'user', content: userMessage }];
        const cleanMessages = this._normalizeMessages(rawMessages);

        let responseText = '';
        let usage = { input_tokens: 0, output_tokens: 0 };

        try {
            if (model.startsWith('gemini-')) {
                const result = await googleAi.models.generateContent({
                    model: model,
                    contents: cleanMessages.map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }]
                    })),
                    config: {
                        systemInstruction: fullSystemPrompt,
                        temperature: 0.4,
                        topP: 0.95,
                        topK: 40,
                        maxOutputTokens: 4096,
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                        ]
                    }
                });
                responseText = result.text;
                usage = {
                    input_tokens: result.usageMetadata?.promptTokenCount || 0,
                    output_tokens: result.usageMetadata?.candidatesTokenCount || 0
                };
            } else if (model.includes('claude')) {
                const msg = await anthropic.messages.create({
                    model: model,
                    max_tokens: config.ai.maxTokens || 1024,
                    temperature: config.ai.temperature || 0.7,
                    system: fullSystemPrompt,
                    messages: cleanMessages
                });
                responseText = msg.content[0].text;
                usage = { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens };

            } else {
                const res = await openai.chat.completions.create({
                    model: model,
                    messages: [{ role: 'system', content: fullSystemPrompt }, ...cleanMessages],
                    temperature: config.ai.temperature || 0.7,
                });
                responseText = res.choices[0].message.content;
                usage = { input_tokens: res.usage.prompt_tokens, output_tokens: res.usage.completion_tokens };
            }

            const cost = calculateCost(model, usage.input_tokens, usage.output_tokens);
            return { text: responseText, model, cost, tokens: usage };

        } catch (error) {
            console.error(`❌ Ошибка LLM (${model}):`, error.message);
            throw error;
        }
    }
};