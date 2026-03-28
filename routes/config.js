/**
 * API для управления конфигурацией бота
 * * TODO (Production): 
 * - Добавить middleware для аутентификации (JWT/API-Key)
 * - Валидировать bot_id из токена
 * - Добавить Rate limiting для защиты от спама
 */

import express from 'express';
import { db } from '../services/database.js';

const router = express.Router();

/**
 * 1. PUT /api/config/welcome
 * Обновление приветственного сообщения из Flutter
 */
router.put('/welcome', async (req, res) => {
    const { welcome_message } = req.body;
    
    if (!welcome_message || welcome_message.trim().length === 0) {
        return res.status(400).json({ error: 'welcome_message обязателен' });
    }
    
    if (welcome_message.length > 500) {
        return res.status(400).json({ error: 'Максимальная длина приветствия — 500 символов' });
    }
    
    try {
        const sql = `
            UPDATE bot_config 
            SET welcome_message = $1 
            WHERE id = (SELECT id FROM bot_config LIMIT 1)
            RETURNING welcome_message
        `;
        
        const result = await db.query(sql, [welcome_message.trim()]);
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Конфигурация бота не найдена' });
        }
        
        res.json({
            success: true,
            welcome_message: result[0].welcome_message
        });
    } catch (error) {
        console.error('[API] Ошибка обновления welcome_message:', error.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * 2. GET /api/config/welcome
 */
router.get('/welcome', async (req, res) => {
    try {
        const sql = `SELECT welcome_message, business_name FROM bot_config LIMIT 1`;
        const result = await db.query(sql);
        
        if (!result[0]) {
            return res.status(404).json({ error: 'Конфигурация не найдена' });
        }
        
        res.json({
            welcome_message: result[0].welcome_message,
            business_name: result[0].business_name
        });
    } catch (error) {
        console.error('[API] Ошибка получения welcome_message:', error.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * 3. PUT /api/config/prompt
 * Обновление системного промпта для AI
 */
router.put('/prompt', async (req, res) => {
    const { system_prompt } = req.body;
    
    if (!system_prompt || system_prompt.trim().length === 0) {
        return res.status(400).json({ error: 'system_prompt не может быть пустым' });
    }
    
    if (system_prompt.length > 2000) {
        return res.status(400).json({ error: 'Максимальная длина промпта — 2000 символов' });
    }
    
    try {
        const sql = `
            UPDATE bot_config 
            SET system_prompt = $1 
            WHERE id = (SELECT id FROM bot_config LIMIT 1)
            RETURNING system_prompt
        `;
        
        const result = await db.query(sql, [system_prompt.trim()]);
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Конфигурация не найдена' });
        }
        
        res.json({
            success: true,
            system_prompt: result[0].system_prompt
        });
    } catch (error) {
        console.error('[API] Ошибка PUT /prompt:', error.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

/**
 * 4. GET /api/config/prompt
 */
router.get('/prompt', async (req, res) => {
    try {
        const sql = `SELECT system_prompt FROM bot_config LIMIT 1`;
        const result = await db.query(sql);
        
        if (!result[0]) {
            return res.status(404).json({ error: 'Настройки не найдены' });
        }
        
        res.json({
            system_prompt: result[0].system_prompt
        });
    } catch (error) {
        console.error('[API] Ошибка GET /prompt:', error.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

export default router;
