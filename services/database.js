import pg from 'pg';
const { Pool } = pg;

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 30, // Увеличили пул под нагрузку
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: false }
    });
  }

  /**
   * Универсальный метод для выполнения запросов
   */
  async query(text, params) {
    try {
      const res = await this.pool.query(text, params);
      return res.rows;
    } catch (error) {
      console.error(`[DB_QUERY_ERROR] ${error.message}`);
      throw error;
    }
  }

  /**
   * Инициализация Production-структуры (Multi-bot)
   */
  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. БОТЫ (Multi-tenant ядро)
      await client.query(`
        CREATE TABLE IF NOT EXISTS bots (
          id SERIAL PRIMARY KEY,
          telegram_username TEXT UNIQUE NOT NULL,
          openai_key TEXT NOT NULL,
          business_name TEXT NOT NULL,
          welcome_message TEXT,
          system_prompt TEXT,
          alerts_topic_id BIGINT,
          owner_user_id BIGINT,
          status TEXT DEFAULT 'active',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // 2. ПРАЙС (Привязка к боту + SKU)
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT,
          price NUMERIC(12, 2) DEFAULT 0,
          description TEXT,
          search_vector TSVECTOR GENERATED ALWAYS AS (
            setweight(to_tsvector('russian', coalesce(name, '')), 'A') ||
            setweight(to_tsvector('russian', coalesce(description, '')), 'B')
          ) STORED,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT products_bot_sku_unique UNIQUE (bot_id, sku)
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN(search_vector);`);

      // 3. ТОПИКИ (Связь юзеров с ветками в админ-группах конкретных ботов)
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_topics (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL,
          topic_id INTEGER,
          username TEXT,
          first_name TEXT,
          admin_override BOOLEAN DEFAULT FALSE,
          admin_override_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT user_topics_bot_user_unique UNIQUE (bot_id, user_id)
        );
      `);

      // 4. ДИАЛОГИ (Мета-данные сессий)
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT conversations_bot_user_unique UNIQUE (bot_id, user_id)
        );
      `);

      // 5. СООБЩЕНИЯ (Нормализованная история)
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          model_used TEXT,
          tokens_input INTEGER,
          tokens_output INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);`);

      // 6. БИЛЛИНГ И СТАТИСТИКА (Usage Logs)
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_logs (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
          period DATE NOT NULL,
          messages_count INTEGER DEFAULT 0,
          tokens_input INTEGER DEFAULT 0,
          tokens_output INTEGER DEFAULT 0,
          cost_usd NUMERIC(10, 4) DEFAULT 0,
          CONSTRAINT usage_unique UNIQUE (bot_id, period)
        );
      `);

      await client.query('COMMIT');
      console.log('🚀 [DATABASE] Production schema initialized successfully');

      await this.ensureDefaults();

    } catch (e) {
      await client.query('ROLLBACK');
      console.error('❌ [DATABASE] Init Critical Error:', e.message);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Гарантируем наличие хотя бы одного системного бота для тестов
   */
  async ensureDefaults() {
    try {
      const res = await this.pool.query('SELECT COUNT(*) FROM bots');
      if (res.rows[0].count === '0') {
        const defaultPrompt = `Ты — AI-ассистент Dokki Business. Твоя цель — профессиональная консультация и продажи.`;
        
        await this.pool.query(`
          INSERT INTO bots (telegram_username, openai_key, business_name, system_prompt) 
          VALUES ($1, $2, $3, $4)
        `, ['DokkiSystemBot', 'sk-placeholder', 'Dokki Business', defaultPrompt]);
        
        console.log('✅ [DATABASE] Default test bot created');
      }
    } catch (e) {
      console.error('❌ [DATABASE] ensureDefaults Error:', e.message);
    }
  }

  /**
   * Логирование сообщения и обновление статистики (Атомарно)
   */
  async logInteraction(botId, userId, messageData, usageData) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Получаем ID диалога
      let conv = await client.query(
        'SELECT id FROM conversations WHERE bot_id = $1 AND user_id = $2',
        [botId, userId]
      );
      
      let conversationId;
      if (!conv.rows[0]) {
        const newConv = await client.query(
          'INSERT INTO conversations (bot_id, user_id) VALUES ($1, $2) RETURNING id',
          [botId, userId]
        );
        conversationId = newConv.rows[0].id;
      } else {
        conversationId = conv.rows[0].id;
      }

      // 2. Записываем сообщение
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, model_used, tokens_input, tokens_output) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [conversationId, messageData.role, messageData.content, usageData.model, usageData.input, usageData.output]
      );

      // 3. Обновляем Usage Logs (UPSERT)
      const period = new Date().toISOString().split('T')[0];
      await client.query(`
        INSERT INTO usage_logs (bot_id, period, messages_count, tokens_input, tokens_output)
        VALUES ($1, $2, 1, $3, $4)
        ON CONFLICT (bot_id, period) DO UPDATE
        SET messages_count = usage_logs.messages_count + 1,
            tokens_input = usage_logs.tokens_input + EXCLUDED.tokens_input,
            tokens_output = usage_logs.tokens_output + EXCLUDED.tokens_output
      `, [botId, period, usageData.input, usageData.output]);

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Получение истории для OpenAI (теперь из нормализованной таблицы)
   */
  async getChatHistory(botId, userId, limit = 15) {
    const sql = `
      SELECT m.role, m.content 
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.bot_id = $1 AND c.user_id = $2
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    const res = await this.query(sql, [botId, userId, limit]);
    return res.reverse(); // Возвращаем в хронологическом порядке
  }
}

export const db = new Database();