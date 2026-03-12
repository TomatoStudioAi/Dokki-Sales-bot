import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env.js';
import { calculateCost } from './cost-tracker.js';

// Инициализация клиентов
const openai = new OpenAI({ apiKey: config.ai.openaiKey });
const deepseek = new OpenAI({ 
    apiKey: config.ai.deepseekKey, 
    baseURL: 'https://api.deepseek.com/v1' 
});
const anthropic = new Anthropic({ apiKey: config.ai.anthropicKey });

export const llm = {
    /**
     * Выбор модели на основе контента и истории
     */
    selectModel(text, messageCount, history) {
        const input = text.toLowerCase();
        
        // 1. Уровень "Closer" (Claude) - горячие лиды
        if (
            input.includes('созвон') || 
            input.includes('встреча') || 
            input.includes('договор') || 
            input.includes('бюджет') ||
            messageCount >= 5
        ) {
            return config.ai.models.closer;
        }

        // 2. Уровень "Expert" (DeepSeek) - консультации
        if (
            input.includes('кейс') || 
            input.includes('процесс') || 
            input.includes('услуг') ||
            (messageCount >= 2 && messageCount < 5)
        ) {
            return config.ai.models.expert;
        }

        // 3. Уровень "Filter" (GPT-4o-mini) - база и мусор
        return config.ai.models.filter;
    },

    /**
     * Основной метод вызова ИИ
     */
    async ask(model, systemPrompt, history, userMessage) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userMessage }
        ];

        let responseText = '';
        let usage = { input_tokens: 0, output_tokens: 0 };

        try {
            if (model.includes('claude')) {
                // Вызов Anthropic
                const msg = await anthropic.messages.create({
                    model: model,
                    max_tokens: config.ai.maxTokens,
                    temperature: config.ai.temperature,
                    system: systemPrompt,
                    messages: [...history, { role: 'user', content: userMessage }]
                });
                responseText = msg.content[0].text;
                usage = { 
                    input_tokens: msg.usage.input_tokens, 
                    output_tokens: msg.usage.output_tokens 
                };
            } else if (model.includes('deepseek')) {
                // Вызов DeepSeek
                const res = await deepseek.chat.completions.create({
                    model: model,
                    messages: messages,
                    temperature: config.ai.temperature,
                });
                responseText = res.choices[0].message.content;
                usage = { 
                    input_tokens: res.usage.prompt_tokens, 
                    output_tokens: res.usage.completion_tokens 
                };
            } else {
                // Вызов OpenAI (gpt-4o-mini)
                const res = await openai.chat.completions.create({
                    model: model,
                    messages: messages,
                    temperature: config.ai.temperature,
                });
                responseText = res.choices[0].message.content;
                usage = { 
                    input_tokens: res.usage.prompt_tokens, 
                    output_tokens: res.usage.completion_tokens 
                };
            }

            const cost = calculateCost(model, usage.input_tokens, usage.output_tokens);

            return {
                text: responseText,
                model: model,
                cost: cost,
                tokens: usage
            };

        } catch (error) {
            console.error(`❌ Ошибка LLM (${model}):`, error.message);
            throw error;
        }
    }
};