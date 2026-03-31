import express from 'express';
import { db } from '../services/database.js';

const router = express.Router();

/**
 * Валидация и автоматическая генерация SKU.
 */
function validateAndPrepareProduct(p) {
    if (!p.name || typeof p.name !== 'string') {
        throw new Error(`Имя товара обязательно`);
    }

    // Авто-генерация SKU, если он не передан (Вариант Б)
    if (!p.sku) {
        p.sku = p.name
            .toLowerCase()
            .replace(/[^a-zа-я0-9\s]/g, '')
            .replace(/\s+/g, '-')
            .slice(0, 50);
    }

    if (p.price !== undefined && (typeof p.price !== 'number' || p.price < 0)) {
        throw new Error(`Некорректная цена для "${p.name}"`);
    }

    return true;
}

/**
 * Хелпер: Проверка существования бота перед операциями с прайсом
 */
async function ensureBotExists(botId) {
    const res = await db.query('SELECT id FROM bots WHERE id = $1', [botId]);
    if (!res[0]) throw new Error(`Бот с ID ${botId} не найден в системе`);
    return true;
}

// --- НОВЫЕ ЭНДПОИНТЫ ДЛЯ ТОЧЕЧНОГО УПРАВЛЕНИЯ (ЗАДАЧА 32) ---

/**
 * POST /api/prices/update-single
 * Создание или обновление одного товара
 */
router.post('/update-single', async (req, res) => {
    const { telegram_username, product } = req.body;

    if (!telegram_username || !product || !product.name) {
        return res.status(400).json({ error: 'Требуются telegram_username и product.name' });
    }

    const cleanUsername = telegram_username.startsWith('@') 
        ? telegram_username.toLowerCase() 
        : `@${telegram_username.toLowerCase()}`;

    try {
        // 1. Ищем бота
        const botRes = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [cleanUsername]);
        if (!botRes[0]) {
            return res.status(404).json({ error: 'Бот не зарегистрирован' });
        }

        const bot_id = botRes[0].id;

        // 2. Валидация и подготовка SKU (через существующую функцию)
        validateAndPrepareProduct(product);

        // 3. Логика сохранения: UPDATE если есть ID, иначе INSERT
        if (product.id) {
            await db.query(`
                UPDATE products 
                SET name = $1, category = $2, price = $3, description = $4, sku = $5
                WHERE bot_id = $6 AND id = $7
            `, [
                product.name, 
                product.category || 'Общее', 
                product.price || 0, 
                product.description || '', 
                product.sku,
                bot_id, 
                product.id
            ]);
            console.log(`[API] Товар ID ${product.id} обновлен для ${cleanUsername}`);
        } else {
            await db.query(`
                INSERT INTO products (bot_id, sku, name, category, price, description)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (bot_id, sku) DO UPDATE SET
                    name = EXCLUDED.name,
                    category = EXCLUDED.category,
                    price = EXCLUDED.price,
                    description = EXCLUDED.description
            `, [
                bot_id, 
                product.sku, 
                product.name, 
                product.category || 'Общее', 
                product.price || 0, 
                product.description || ''
            ]);
            console.log(`[API] Новый товар "${product.name}" добавлен для ${cleanUsername}`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error(`[API_ERROR] update-single: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/prices/delete-single
 * Удаление одного товара
 */
router.delete('/delete-single', async (req, res) => {
    const { telegram_username, product_id } = req.body;

    if (!telegram_username || !product_id) {
        return res.status(400).json({ error: 'Требуются telegram_username и product_id' });
    }

    const cleanUsername = telegram_username.startsWith('@') 
        ? telegram_username.toLowerCase() 
        : `@${telegram_username.toLowerCase()}`;

    try {
        const botRes = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [cleanUsername]);
        if (!botRes[0]) {
            return res.status(404).json({ error: 'Бот не найден' });
        }

        const bot_id = botRes[0].id;

        // Удаляем только если товар принадлежит именно этому боту
        const deleteRes = await db.query(
            'DELETE FROM products WHERE bot_id = $1 AND id = $2 RETURNING id', 
            [bot_id, product_id]
        );

        if (deleteRes.length === 0) {
            return res.status(404).json({ error: 'Товар не найден или не принадлежит этому боту' });
        }

        console.log(`[API] Товар ID ${product_id} удален для ${cleanUsername}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API_ERROR] delete-single: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// --- СУЩЕСТВУЮЩИЕ ЭНДПОИНТЫ ---

/**
 * POST /api/prices/upload
 * Массовая загрузка прайса
 */
router.post('/upload', async (req, res) => {
    const { telegram_username, products } = req.body;
    if (!telegram_username || !Array.isArray(products)) {
        return res.status(400).json({ error: 'Некорректные данные' });
    }
    const cleanUsername = telegram_username.startsWith('@') 
        ? telegram_username.toLowerCase() 
        : `@${telegram_username.toLowerCase()}`;

    try {
        const botRes = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [cleanUsername]);
        if (!botRes[0]) return res.status(404).json({ error: 'Бот не найден' });
        const bot_id = botRes[0].id;

        products.forEach(validateAndPrepareProduct);

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM products WHERE bot_id = $1', [bot_id]);
            for (const p of products) {
                await client.query(
                    `INSERT INTO products (bot_id, sku, name, category, price, description) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [bot_id, p.sku, p.name, p.category || 'Общее', p.price || 0, p.description || '']
                );
            }
            await client.query('COMMIT');
            res.json({ success: true, count: products.length });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Получение прайса по username
 */
router.get('/by-username/:username', async (req, res) => {
    const { username } = req.params;
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;
    try {
        const bot = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [formattedUsername]);
        if (!bot[0]) return res.status(404).json({ error: 'Бот не найден' });
        const products = await db.query(
            'SELECT id, sku, name, category, price, description FROM products WHERE bot_id = $1 ORDER BY category, name',
            [bot[0].id]
        );
        res.json({ success: true, bot_id: bot[0].id, products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Дополнительные маршруты по ID
router.get('/:bot_id', async (req, res) => {
    try {
        const products = await db.query(
            'SELECT id, sku, name, category, price, description FROM products WHERE bot_id = $1 ORDER BY category, name',
            [req.params.bot_id]
        );
        res.json({ success: true, count: products.length, products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;