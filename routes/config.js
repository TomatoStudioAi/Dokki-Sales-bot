/**
 * API для управления конфигурацией ботов
 * Реализовано по принципу White Label: каждый клиент управляет только своим ботом.
 */

import express from 'express';
import { db } from '../services/database.js';

const router = express.Router();

// --- ХЕЛПЕРЫ ВАЛИДАЦИИ ---
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
 * 1. GET /api/config/:username
 * Получение полной конфигурации конкретного бота
 */
router.get('/:username', async (req, res) => {
    const { username } = req.params;
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;

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
            return res.status(404).json({ 
                error: 'Бот с таким username не зарегистрирован в системе' 
            });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`[API GET CONFIG] Ошибка для ${formattedUsername}:`, error.message);
        res.status(500).json({ error: 'Ошибка сервера при получении данных' });
    }
});

/**
 * 2. PATCH /api/config/:username
 * Универсальное обновление настроек (Приветствие, Промпт, Имя бизнеса)
 * Используем PATCH и COALESCE для частичного обновления данных из Flutter
 */
router.patch('/:username', async (req, res) => {
    const { username } = req.params;
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;
    const { welcome_message, system_prompt, business_name, alerts_topic_id } = req.body;

    // Валидация входных данных
    const validationErrors = validateConfig(req.body);
    if (validationErrors.length > 0) {
        return res.status(400).json({ errors: validationErrors });
    }

    try {
        // COALESCE позволяет обновить только те поля, которые прислал Flutter, сохранив остальные
        const sql = `
            UPDATE bots 
            SET 
                welcome_message = COALESCE($1, welcome_message),
                system_prompt = COALESCE($2, system_prompt),
                business_name = COALESCE($3, business_name),
                alerts_topic_id = COALESCE($4, alerts_topic_id),
                updated_at = NOW()
            WHERE telegram_username = $5
            RETURNING id, telegram_username, business_name, updated_at
        `;
        
        const params = [
            welcome_message?.trim() || null,
            system_prompt?.trim() || null,
            business_name?.trim() || null,
            alerts_topic_id || null,
            formattedUsername
        ];

        const result = await db.query(sql, params);
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Бот не найден. Сначала создайте запись в БД.' });
        }
        
        res.json({
            success: true,
            message: 'Конфигурация успешно обновлена',
            updated: result[0]
        });
    } catch (error) {
        console.error(`[API PATCH CONFIG] Ошибка для ${formattedUsername}:`, error.message);
        res.status(500).json({ error: 'Ошибка сервера при сохранении настроек' });
    }
});

/**
 * 3. DELETE /api/config/:username
 * Удаление бота из системы (например, при отписке клиента)
 */
router.delete('/:username', async (req, res) => {
    const { username } = req.params;
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;

    try {
        const result = await db.query(
            'DELETE FROM bots WHERE telegram_username = $1 RETURNING id', 
            [formattedUsername]
        );
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Бот не найден' });
        }
        
        res.json({ success: true, message: `Бот ${formattedUsername} удален из системы` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

export default router;