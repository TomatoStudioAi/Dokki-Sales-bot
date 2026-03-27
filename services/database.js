import pg from 'pg';
const { Pool } = pg;

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  /**
   * Инициализация всех таблиц и индексов
   */
  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Конфигурация (Промпты и настройки)
      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_config (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Топики пользователей (Связь Юзер <-> Ветка в админке)
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_topics (
          user_id BIGINT PRIMARY KEY,
          topic_id INTEGER,
          username TEXT,
          first_name TEXT,
          admin_override BOOLEAN DEFAULT FALSE,
          admin_override_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 3. Лог сообщений (Для истории и аналитики)
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages_log (
          id SERIAL PRIMARY KEY,
          user_id BIGINT,
          message_text TEXT,
          bot_response TEXT,
          model_used TEXT,
          cost_usd NUMERIC(10, 6),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 4. ТОВАРЫ И УСЛУГИ С FTS (Полнотекстовый поиск)
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT,
          price NUMERIC(12, 2) DEFAULT 0,
          description TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          search_vector tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('russian', coalesce(name, '')), 'A') ||
            setweight(to_tsvector('russian', coalesce(description, '')), 'B')
          ) STORED
        );
      `);

      // Индекс для мгновенного поиска по вектору
      await client.query(`
        CREATE INDEX IF NOT EXISTS products_search_idx 
        ON products USING GIN(search_vector);
      `);

      await client.query('COMMIT');
      console.log('✅ Postgres tables & FTS indexes initialized');

      await this.ensureDefaults();

    } catch (e) {
      await client.query('ROLLBACK');
      console.error('❌ DB Init Error:', e.message);
      throw e;
    } finally {
      client.release();
    }
  }

  async ensureDefaults() {
    try {
      const res = await this.pool.query('SELECT value FROM bot_config WHERE key = $1', ['system_prompt']);
      if (!res.rows[0]) {
        const defaultPrompt = `Ты — AI-ассистент Dokki Business. Помогай клиентам с выбором AI-решений.`;
        await this.pool.query(
          'INSERT INTO bot_config (key, value) VALUES ($1, $2)',
          ['system_prompt', JSON.stringify(defaultPrompt)]
        );
      }
    } catch (e) {
      console.error('❌ ensureDefaults Error:', e.message);
    }
  }

  // --- МЕТОДЫ ПОИСКА ПО ПРАЙСУ ---

  async searchProducts(query, limit = 10) {
    const sql = `
      SELECT 
        id, name, category, price, description,
        ts_rank(search_vector, websearch_to_tsquery('russian', $1)) as rank
      FROM products
      WHERE search_vector @@ websearch_to_tsquery('russian', $1)
      ORDER BY rank DESC
      LIMIT $2
    `;
    const res = await this.pool.query(sql, [query, limit]);
    return res.rows;
  }

  async insertProducts(productsArray) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of productsArray) {
        await client.query(
          'INSERT INTO products (name, category, price, description) VALUES ($1, $2, $3, $4)',
          [p.name, p.category, p.price, p.description || '']
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // --- МЕТОДЫ УПРАВЛЕНИЯ ПОЛЬЗОВАТЕЛЯМИ ---

  async getTopic(userId) {
    const res = await this.pool.query('SELECT * FROM user_topics WHERE user_id = $1', [userId]);
    return res.rows[0];
  }

  async createTopic(data) {
    const res = await this.pool.query(
      `INSERT INTO user_topics (user_id, topic_id, username, first_name) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.user_id, data.topic_id, data.username, data.first_name]
    );
    return res.rows[0];
  }

  async updateTopicId(userId, topicId) {
    await this.pool.query('UPDATE user_topics SET topic_id = $2 WHERE user_id = $1', [userId, topicId]);
  }

  async setOverride(userId, value) {
    const at = value ? new Date() : null;
    await this.pool.query(
      'UPDATE user_topics SET admin_override = $2, admin_override_at = $3 WHERE user_id = $1',
      [userId, value, at]
    );
  }

  async getUserIdByTopic(topicId) {
    const res = await this.pool.query('SELECT user_id FROM user_topics WHERE topic_id = $1', [topicId]);
    return res.rows[0]?.user_id;
  }

  // --- КОНФИГ И ЛОГИ ---

  async getConfig(key) {
    const res = await this.pool.query('SELECT value FROM bot_config WHERE key = $1', [key]);
    return res.rows[0]?.value;
  }

  async logMessage(log) {
    await this.pool.query(
      `INSERT INTO messages_log (user_id, message_text, bot_response, model_used, cost_usd) 
       VALUES ($1, $2, $3, $4, $5)`,
      [log.user_id, log.message_text, log.bot_response, log.model_used, log.cost_usd]
    );
  }

  async getHistory(userId, limit = 10) {
    const res = await this.pool.query(
      `SELECT message_text, bot_response FROM messages_log 
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    const history = [];
    res.rows.reverse().forEach(row => {
      history.push({ role: 'user', content: row.message_text });
      history.push({ role: 'assistant', content: row.bot_response });
    });
    return history;
  }
}

export const db = new Database();