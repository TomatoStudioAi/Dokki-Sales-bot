import pg from 'pg';
const { Pool } = pg;

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, // Увеличили для стабильности в облаке
    });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Таблица конфига
      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_config (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Таблица топиков
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

      // 3. Лог сообщений
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

      await client.query('COMMIT');
      console.log('✅ Postgres tables initialized');

      // Проверка и создание дефолтных настроек
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
      const res = await this.pool.query(
        'SELECT value FROM bot_config WHERE key = $1',
        ['system_prompt']
      );

      if (!res.rows[0]) {
        console.log('⚠️ system_prompt не найден, создаю дефолтный...');
        
        const defaultPrompt = `Ты — AI-ассистент Dokki Business. Твоя задача: помогать клиентам с выбором AI-решений и записывать их на консультацию. Будь краток и профессионален.`;

        await this.pool.query(
          'INSERT INTO bot_config (key, value) VALUES ($1, $2)',
          ['system_prompt', JSON.stringify(defaultPrompt)]
        );
        
        console.log('✅ Дефолтный system_prompt создан');
      } else {
        console.log('✅ system_prompt найден в БД');
      }
    } catch (e) {
      console.error('❌ Ошибка ensureDefaults:', e.message);
    }
  }

  async getConfig(key) {
    const res = await this.pool.query('SELECT value FROM bot_config WHERE key = $1', [key]);
    return res.rows[0]?.value;
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }
}

export const db = new Database();