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

    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1);
    });
  }

  /**
   * Инициализация всех таблиц и индексов
   */
  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Конфигурация (системные промпты и настройки)
      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_config (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Топики пользователей (связь клиент -> форум-группа)
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

      // 3. База знаний для RAG (services/llm.js)
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_entries (
          id SERIAL PRIMARY KEY,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 4. Лог сообщений для истории LLM и аналитики
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

      // 5. Каталог товаров с мультиязычным FTS (ЗАДАЧА №3)
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          external_id TEXT UNIQUE,
          name TEXT NOT NULL,
          name_ru TEXT,
          name_ar TEXT,
          description TEXT,
          description_ru TEXT,
          description_ar TEXT,
          price NUMERIC(12, 2) DEFAULT 0,
          metadata JSONB,
          search_vector tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
            setweight(to_tsvector('russian', coalesce(name_ru, '')), 'A') ||
            setweight(to_tsvector('simple', coalesce(name_ar, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
            setweight(to_tsvector('russian', coalesce(description_ru, '')), 'B') ||
            setweight(to_tsvector('simple', coalesce(description_ar, '')), 'B')
          ) STORED
        );
      `);

      await client.query('CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN(search_vector);');

      await client.query('COMMIT');
      console.log('✅ Postgres tables initialized');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('❌ DB Init Error:', e.message);
      throw e;
    } finally {
      client.release();
    }
  }

  // --- УНИВЕРСАЛЬНЫЕ МЕТОДЫ ---

  async query(sql, params = []) {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  // --- МЕТОДЫ SALES БОТА ---

  async getConfig(key) {
    const res = await this.pool.query('SELECT value FROM bot_config WHERE key = $1', [key]);
    return res.rows[0]?.value || null;
  }

  async getTopic(userId) {
    const res = await this.pool.query('SELECT * FROM user_topics WHERE user_id = $1', [userId]);
    return res.rows[0] || null;
  }

  async createTopic(topicData) {
    const sql = `
      INSERT INTO user_topics (user_id, topic_id, username, first_name, admin_override)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        topic_id = EXCLUDED.topic_id,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name
      RETURNING *;
    `;
    const values = [
      topicData.user_id, 
      topicData.topic_id, 
      topicData.username || 'n/a', 
      topicData.first_name || 'Клиент',
      false
    ];
    const res = await this.pool.query(sql, values);
    return res.rows[0];
  }

  async updateTopicId(userId, topicId) {
    await this.pool.query('UPDATE user_topics SET topic_id = $1 WHERE user_id = $2', [topicId, userId]);
  }

  async setOverride(userId, value) {
    const sql = `
      UPDATE user_topics 
      SET admin_override = $1, admin_override_at = $2 
      WHERE user_id = $3
    `;
    await this.pool.query(sql, [value, value ? new Date() : null, userId]);
  }

  async getUserIdByTopic(topicId) {
    const res = await this.pool.query('SELECT user_id FROM user_topics WHERE topic_id = $1', [topicId]);
    return res.rows[0]?.user_id || null;
  }

  async logMessage(log) {
    const sql = `
      INSERT INTO messages_log (user_id, message_text, bot_response, model_used, cost_usd)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await this.pool.query(sql, [log.user_id, log.message_text, log.bot_response, log.model_used, log.cost_usd]);
  }

  async getHistory(userId) {
    const sql = `
      SELECT message_text, bot_response 
      FROM messages_log 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 5
    `;
    const res = await this.pool.query(sql, [userId]);
    const history = [];
    res.rows.reverse().forEach(row => {
      if (row.message_text) history.push({ role: 'user', content: row.message_text });
      if (row.bot_response) history.push({ role: 'assistant', content: row.bot_response });
    });
    return history;
  }

  // --- ПОИСК (ЗАДАЧА №3) ---

  async searchProducts(searchQuery, lang = 'ru', limit = 10) {
    const nameField = lang === 'ar' ? 'name_ar' : (lang === 'ru' ? 'name_ru' : 'name');
    const descField = lang === 'ar' ? 'description_ar' : (lang === 'ru' ? 'description_ru' : 'description');
    
    const sql = `
      SELECT 
        id, 
        COALESCE(${nameField}, name) as display_name,
        COALESCE(${descField}, description) as display_description,
        price,
        ts_rank(search_vector, websearch_to_tsquery('simple', $1)) as rank
      FROM products
      WHERE search_vector @@ websearch_to_tsquery('simple', $1)
      ORDER BY rank DESC
      LIMIT $2;
    `;
    const res = await this.pool.query(sql, [searchQuery, limit]);
    return res.rows;
  }
}

export const db = new Database();