import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import { config } from '../config/env.js';
import { calculateCost } from './cost-tracker.js';

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

    selectModel(text, messageCount, history) {
        const input = text.toLowerCase().trim();
        
        if (input.includes('договор') || input.includes('созвон') || input.includes('встреча') || input.includes('подписать')) {
            return config.ai.models.closer;
        }
        
        const isShort = input.length < 20;
        const isGreeting = input.includes('привет') || input.includes('здравствуй') || 
                           input.includes('салем') || input.includes('добрый день');
        
        if (isShort || isGreeting) {
            return config.ai.models.filter;
        }

        if (input.includes('бюджет') || input.includes('цена') || input.includes('стоимость') || 
            input.includes('кейс') || input.includes('процесс') || input.includes('как вы') || 
            messageCount >= 8) {
            return config.ai.models.expert;
        }
        
        return config.ai.models.filter;
    },

    async ask(model, systemPrompt, history, userMessage) {
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
                        systemInstruction: systemPrompt,
                        generationConfig: {
                            temperature: 0.7,
                            topP: 0.95,
                            topK: 40,
                            maxOutputTokens: 1024,
                        },
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
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
                    system: systemPrompt,
                    messages: cleanMessages
                });
                responseText = msg.content[0].text;
                usage = { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens };

            } else {
                const res = await openai.chat.completions.create({
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