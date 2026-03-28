import express from 'express';
import { db } from '../services/database.js';

const router = express.Router();

/**
 * Валидация и подготовка данных товара.
 * Если SKU не передан, он генерируется на основе имени.
 */
function validateAndPrepareProduct(p) {
    if (!p.name || typeof p.name !== 'string') {
        throw new Error(`Имя товара обязательно и должно быть строкой`);
    }

    // Генерация SKU из названия, если он не указан
    if (!p.sku) {
        p.sku = p.name
            .toLowerCase()
            .replace(/[^a-zа-я0-9\s]/g, '') // Удаляем спецсимволы
            .replace(/\s+/g, '-')           // Заменяем пробелы на дефисы
            .slice(0, 50);                  // Ограничиваем длину
    }

    if (typeof p.sku !== 'string' || p.sku.length > 50) {
        throw new Error(`SKU для "${p.name}" должен быть строкой до 50 символов`);
    }

    if (p.price !== undefined && (typeof p.price !== 'number' || p.price < 0)) {
        throw new Error(`Цена для "${p.name}" должна быть положительным числом`);
    }

    return true;
}

/**
 * 1. GET /api/prices/:bot_id — Получить весь прайс конкретного бота
 */
router.get('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    try {
        const products = await db.query(
            `SELECT id, sku, name, category, price, description 
             FROM products 
             WHERE bot_id = $1 
             ORDER BY category ASC, name ASC`,
            [bot_id]
        );
        res.json({ 
            success: true, 
            bot_id: parseInt(bot_id), 
            count: products.length, 
            products 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 2. DELETE /api/prices/:bot_id — Полная очистка прайса конкретного бота
 */
router.delete('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    try {
        const result = await db.query(
            'DELETE FROM products WHERE bot_id = $1 RETURNING id', 
            [bot_id]
        );
        res.json({ 
            success: true, 
            message: `Прайс бота #${bot_id} полностью удален`, 
            deleted_count: result.length 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 3. PUT /api/prices/:bot_id — Полная замена прайса (Атомарная транзакция)
 */
router.put('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    const { products } = req.body;

    if (!Array.isArray(products)) {
        return res.status(400).json({ error: 'Поле products должно быть массивом' });
    }

    try {
        // Предварительная валидация всех элементов
        products.forEach(validateAndPrepareProduct);

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Удаляем старый прайс конкретного бота
            await client.query('DELETE FROM products WHERE bot_id = $1', [bot_id]);
            
            // Вставляем новые позиции
            for (const p of products) {
                await client.query(
                    `INSERT INTO products (bot_id, sku, name, category, price, description) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [bot_id, p.sku, p.name, p.category || 'Общее', p.price || 0, p.description || '']
                );
            }
            
            await client.query('COMMIT');
            res.json({ 
                success: true, 
                message: `Прайс успешно заменен для бота #${bot_id}`, 
                count: products.length 
            });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * 4. POST /api/prices/:bot_id — Добавление или обновление по SKU (UPSERT)
 */
router.post('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    const { products } = req.body;

    if (!Array.isArray(products)) {
        return res.status(400).json({ error: 'Ожидается массив товаров' });
    }

    try {
        products.forEach(validateAndPrepareProduct);
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            for (const p of products) {
                const sql = `
                    INSERT INTO products (bot_id, sku, name, category, price, description)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (bot_id, sku) DO UPDATE SET
                        name = EXCLUDED.name,
                        category = EXCLUDED.category,
                        price = EXCLUDED.price,
                        description = EXCLUDED.description,
                        created_at = NOW()
                `;
                await client.query(sql, [
                    bot_id, 
                    p.sku, 
                    p.name, 
                    p.category || 'Общее', 
                    p.price || 0, 
                    p.description || ''
                ]);
            }
            await client.query('COMMIT');
            res.json({ 
                success: true, 
                message: `Товары синхронизированы по SKU для бота #${bot_id}` 
            });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

export default router;