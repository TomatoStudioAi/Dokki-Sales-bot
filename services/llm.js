import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { config } from '../config/env.js';
import { calculateCost } from './cost-tracker.js';

const openai = new OpenAI({ apiKey: config.ai.openaiKey });
const deepseek = new OpenAI({ 
    apiKey: config.ai.deepseekKey, 
    baseURL: 'https://api.deepseek.com/v1' 
});
const anthropic = new Anthropic({ apiKey: config.ai.anthropicKey });

export const llm = {
    /**
     * Превращает голос в текст через Whisper
     */
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

    selectModel(text, messageCount, history) {
        const input = text.toLowerCase();
        
        // Премиум: финальные переговоры (договор, встреча, созвон)
        if (input.includes('договор') || input.includes('созвон') || input.includes('встреча') || input.includes('подписать')) {
            return config.ai.models.closer; // claude
        }
        
        // Средняя: конкретный интерес (бюджет, кейсы, процесс, цены) или долгий диалог
        if (input.includes('бюджет') || input.includes('цена') || input.includes('стоимость') || 
            input.includes('кейс') || input.includes('процесс') || input.includes('как вы') || 
            messageCount >= 4) {
            return config.ai.models.expert; // deepseek
        }
        
        // Дешёвая: всё остальное
        return config.ai.models.filter; // gpt-4o-mini
    },

    async ask(model, systemPrompt, history, userMessage) {
        const rawMessages = [...history, { role: 'user', content: userMessage }];
        const cleanMessages = this._normalizeMessages(rawMessages);

        let responseText = '';
        let usage = { input_tokens: 0, output_tokens: 0 };

        try {
            if (model.includes('claude')) {
                const msg = await anthropic.messages.create({
                    model: model,
                    max_tokens: config.ai.maxTokens || 1024,
                    temperature: config.ai.temperature || 0.7,
                    system: systemPrompt,
                    messages: cleanMessages
                });
                responseText = msg.content[0].text;
                usage = { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens };
            } else {
                const client = model.includes('deepseek') ? deepseek : openai;
                const res = await client.chat.completions.create({
                    model: model,
                    messages: [{ role: 'system', content: systemPrompt }, ...cleanMessages],
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