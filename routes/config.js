/**
 * API для управления конфигурацией ботов
 * Реализовано по принципу White Label: каждый клиент управляет только своим ботом.
 */

import express from 'express';
import { db } from '../services/database.js';
import { encrypt } from '../services/encryption.js';
import { llm } from '../services/llm.js';

const router = express.Router();

// --- ХЕЛПЕРЫ ВАЛИДАЦИИ И НОРМАЛИЗАЦИИ ---

const normalizeUsername = (username) => {
    if (!username) return null;
    const clean = username.trim().toLowerCase();
    return clean.startsWith('@') ? clean : `@${clean}`;
};

const validateConfig = (data) => {
    const errors = [];
    if (data.welcome_message && data.welcome_message.length > 500) {
        errors.push('Приветствие не может быть длиннее 500 символов');
    }
    if (data.system_prompt && data.system_prompt.length > 3000) {
        errors.push('Системный промпт не может быть длиннее 3000 символов');
    }
    if (data.business_name && data.business_name.length > 100) {
        errors.push('Название компании слишком длинное');
    }
    return errors;
};

/**
 * 1. POST /api/config
 * Регистрация нового бота или полное обновление настроек (UPSERT)
 */
router.post('/', async (req, res) => {
    const { 
        telegram_username, 
        openai_key, 
        business_name, 
        system_prompt, 
        welcome_message,
        alerts_topic_id 
    } = req.body;

    if (!telegram_username || !openai_key || !business_name) {
        return res.status(400).json({ 
            success: false,
            error: 'Поля telegram_username, openai_key и business_name обязательны' 
        });
    }

    if (!openai_key.startsWith('sk-')) {
        return res.status(400).json({ 
            success: false,
            error: 'OpenAI ключ должен начинаться с sk-',
            field: 'openai_key'
        });
    }

    const formattedUsername = normalizeUsername(telegram_username);
    const validationErrors = validateConfig(req.body);
    
    if (validationErrors.length > 0) {
        return res.status(400).json({ success: false, errors: validationErrors });
    }

    console.log(`[API] Валидация OpenAI ключа для ${formattedUsername}...`);
    
    const isValidKey = await llm.validateOpenAIKey(openai_key);
    if (!isValidKey) {
        return res.status(400).json({ 
            success: false,
            error: 'Неверный OpenAI API ключ. Проверьте правильность ключа.',
            field: 'openai_key'
        });
    }

    console.log(`[API] Ключ валиден. Шифрование и сохранение...`);
    const encryptedKey = encrypt(openai_key);

    try {
        const sql = `
            INSERT INTO bots (
                telegram_username, 
                openai_key, 
                business_name, 
                system_prompt, 
                welcome_message,
                alerts_topic_id,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (telegram_username) 
            DO UPDATE SET 
                openai_key = EXCLUDED.openai_key,
                business_name = EXCLUDED.business_name,
                system_prompt = COALESCE(EXCLUDED.system_prompt, bots.system_prompt),
                welcome_message = COALESCE(EXCLUDED.welcome_message, bots.welcome_message),
                alerts_topic_id = COALESCE(EXCLUDED.alerts_topic_id, bots.alerts_topic_id),
                updated_at = NOW()
            RETURNING id, telegram_username, business_name;
        `;

        const result = await db.query(sql, [
            formattedUsername,
            encryptedKey,
            business_name.trim(),
            system_prompt?.trim() || null,
            welcome_message?.trim() || null,
            alerts_topic_id || null
        ]);

        console.log(`✅ [API POST] Бот успешно сохранен (ID: ${result[0].id})`);
        res.json({ success: true, bot: result[0] });
    } catch (error) {
        console.error(`❌ [API POST ERROR] для ${formattedUsername}:`, error.message);
        res.status(500).json({ success: false, error: 'Ошибка при сохранении конфигурации в базу' });
    }
});

/**
 * 2. GET /api/config/:username
 */
router.get('/:username', async (req, res) => {
    const formattedUsername = normalizeUsername(req.params.username);

    try {
        const sql = `
            SELECT 
                id, 
                telegram_username, 
                business_name, 
                welcome_message, 
                system_prompt, 
                alerts_topic_id,
                status
            FROM bots 
            WHERE telegram_username = $1
        `;
        
        const result = await db.query(sql, [formattedUsername]);
        
        if (!result[0]) {
            return res.status(404).json({ error: 'Бот не зарегистрирован.' });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`[API GET CONFIG ERROR] для ${formattedUsername}:`, error.message);
        res.status(500).json({ error: 'Ошибка сервера при получении данных' });
    }
});

/**
 * 3. PATCH /api/config/:username
 */
router.patch('/:username', async (req, res) => {
    const formattedUsername = normalizeUsername(req.params.username);
    const { welcome_message, system_prompt, business_name, alerts_topic_id, openai_key } = req.body;

    const validationErrors = validateConfig(req.body);
    if (validationErrors.length > 0) {
        return res.status(400).json({ success: false, errors: validationErrors });
    }

    let finalKeyToSave = null;

    // Если прислали новый ключ - проверяем и шифруем
    if (openai_key) {
        if (!openai_key.startsWith('sk-')) {
            return res.status(400).json({ success: false, error: 'OpenAI ключ должен начинаться с sk-' });
        }
        const isValidKey = await llm.validateOpenAIKey(openai_key);
        if (!isValidKey) {
            return res.status(400).json({ success: false, error: 'Неверный OpenAI API ключ.' });
        }
        finalKeyToSave = encrypt(openai_key);
    }

    try {
        const sql = `
            UPDATE bots 
            SET 
                welcome_message = COALESCE($1, welcome_message),
                system_prompt = COALESCE($2, system_prompt),
                business_name = COALESCE($3, business_name),
                alerts_topic_id = COALESCE($4, alerts_topic_id),
                openai_key = COALESCE($5, openai_key),
                updated_at = NOW()
            WHERE telegram_username = $6
            RETURNING id, telegram_username, business_name, updated_at
        `;
        
        const params = [
            welcome_message?.trim() || null,
            system_prompt?.trim() || null,
            business_name?.trim() || null,
            alerts_topic_id || null,
            finalKeyToSave,
            formattedUsername
        ];

        const result = await db.query(sql, params);
        
        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Бот не найден' });
        }
        
        res.json({ success: true, updated: result[0] });
    } catch (error) {
        console.error(`[API PATCH ERROR] для ${formattedUsername}:`, error.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера при сохранении настроек' });
    }
});

/**
 * 4. DELETE /api/config/:username
 */
router.delete('/:username', async (req, res) => {
    const formattedUsername = normalizeUsername(req.params.username);

    try {
        const result = await db.query(
            'DELETE FROM bots WHERE telegram_username = $1 RETURNING id', 
            [formattedUsername]
        );
        
        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Бот не найден' });
        }
        
        console.log(`🗑 [API DELETE] Бот ${formattedUsername} удален`);
        res.json({ success: true, message: `Бот ${formattedUsername} удален` });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Ошибка при удалении' });
    }
});

export default router;