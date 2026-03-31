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

    // Авто-генерация SKU, если он не передан
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

/**
 * НОВЫЙ ЭНДПОИНТ (Задача 20)
 * POST /api/prices/upload
 * Загрузка прайса по telegram_username (для Flutter)
 */
router.post('/upload', async (req, res) => {
    const { telegram_username, products } = req.body;

    if (!telegram_username) {
        return res.status(400).json({ error: 'telegram_username обязательно' });
    }

    if (!Array.isArray(products)) {
        return res.status(400).json({ error: 'Ожидается массив products' });
    }

    // Нормализация юзернейма
    const cleanUsername = telegram_username.startsWith('@') 
        ? telegram_username.toLowerCase() 
        : `@${telegram_username.toLowerCase()}`;

    try {
        // 1. Ищем bot_id по username
        const botRes = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [cleanUsername]);
        if (!botRes[0]) {
            return res.status(404).json({ error: `Бот ${cleanUsername} не зарегистрирован в системе` });
        }

        const bot_id = botRes[0].id;

        // 2. Валидация всех пришедших товаров
        products.forEach(validateAndPrepareProduct);

        // 3. Атомарная замена прайса через транзакцию
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Удаляем старый прайс этого бота
            await client.query('DELETE FROM products WHERE bot_id = $1', [bot_id]);
            
            // Вставляем новые позиции
            for (const p of products) {
                await client.query(
                    `INSERT INTO products (bot_id, sku, name, category, price, description) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        bot_id, 
                        p.sku, 
                        p.name, 
                        p.category || 'Общее', 
                        p.price || 0, 
                        p.description || ''
                    ]
                );
            }
            
            await client.query('COMMIT');
            console.log(`[API] Прайс обновлен для @${cleanUsername} (${products.length} поз.)`);
            res.json({ success: true, count: products.length });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(`[API_ERROR] /prices/upload: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 1. GET /api/prices/:bot_id
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
        res.json({ success: true, count: products.length, products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 2. GET /api/prices/by-username/:username
 */
router.get('/by-username/:username', async (req, res) => {
    const { username } = req.params;
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;

    try {
        const bot = await db.query('SELECT id FROM bots WHERE telegram_username = $1', [formattedUsername]);
        if (!bot[0]) return res.status(404).json({ error: 'Бот не найден' });
        
        const products = await db.query(
            'SELECT sku, name, category, price, description FROM products WHERE bot_id = $1 ORDER BY category, name',
            [bot[0].id]
        );
        
        res.json({ success: true, bot_id: bot[0].id, products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 3. DELETE /api/prices/:bot_id
 */
router.delete('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    try {
        await ensureBotExists(bot_id);
        const result = await db.query('DELETE FROM products WHERE bot_id = $1 RETURNING id', [bot_id]);
        res.json({ success: true, deleted_count: result.length });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * 4. PUT /api/prices/:bot_id
 */
router.put('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    const { products } = req.body;

    if (!Array.isArray(products)) return res.status(400).json({ error: 'Ожидается массив products' });

    try {
        await ensureBotExists(bot_id);
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
            res.json({ success: true, message: 'Прайс-лист полностью обновлен', count: products.length });
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
 * 5. POST /api/prices/:bot_id
 */
router.post('/:bot_id', async (req, res) => {
    const { bot_id } = req.params;
    const { products } = req.body;

    if (!Array.isArray(products)) return res.status(400).json({ error: 'Ожидается массив' });

    try {
        await ensureBotExists(bot_id);
        products.forEach(validateAndPrepareProduct);

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            for (const p of products) {
                await client.query(`
                    INSERT INTO products (bot_id, sku, name, category, price, description)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (bot_id, sku) DO UPDATE SET
                        name = EXCLUDED.name,
                        category = EXCLUDED.category,
                        price = EXCLUDED.price,
                        description = EXCLUDED.description,
                        created_at = NOW()
                `, [bot_id, p.sku, p.name, p.category || 'Общее', p.price || 0, p.description || '']);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: 'Товары синхронизированы по SKU' });
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