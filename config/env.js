import 'dotenv/config';

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN', 'ADMIN_GROUP_ID', 'SUPABASE_URL', 
  'SUPABASE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'
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
    adminGroupId: Number(process.env.ADMIN_GROUP_ID),
    alertsTopicId: parseInt(process.env.ALERTS_TOPIC_ID) || 194,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  ai: {
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    models: {
      filter: 'gpt-4o-mini',
      expert: 'gemini-3-flash-preview',
      closer: 'claude-sonnet-4-6'
    },
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.7,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || 1000, // Возвращено к 1000
  }
};