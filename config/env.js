import 'dotenv/config';

// Список обязательных переменных для Dokki Sales Bot (Postgres)
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN', 
  'TELEGRAM_ADMIN_GROUP_ID', 
  'DATABASE_URL', 
  'OPENAI_API_KEY', 
  'ANTHROPIC_API_KEY', 
  'GOOGLE_API_KEY'
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ ОШИБКА: Переменная ${key} не задана!`);
    process.exit(1);
  }
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminGroupId: Number(process.env.TELEGRAM_ADMIN_GROUP_ID),
    alertsTopicId: parseInt(process.env.ALERTS_TOPIC_ID) || 194,
  },
  // Supabase удален, база работает через DATABASE_URL в database.js
  ai: {
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    models: {
      filter: 'gpt-4o-mini',
      expert: 'gemini-3-flash', // Обновлено до актуальной версии
      closer: 'claude-3-5-sonnet'
    },
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.7,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || 1000,
  }
};