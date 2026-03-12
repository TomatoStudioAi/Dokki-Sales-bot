import 'dotenv/config';

// Список обязательных переменных
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_GROUP_ID',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY'
];

// Проверка наличия всех ключей
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ ОШИБКА: Переменная окружения ${key} не задана в файле .env!`);
    process.exit(1);
  }
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminGroupId: process.env.ADMIN_GROUP_ID,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  ai: {
    openaiKey: process.env.OPENAI_API_KEY,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    models: {
      filter: process.env.LLM_MODEL_FILTER || 'gpt-4o-mini',
      expert: process.env.LLM_MODEL_EXPERT || 'deepseek-chat',
      closer: process.env.LLM_MODEL_CLOSER || 'claude-sonnet-4-6',
    },
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.1,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || 1000,
  }
};

console.log('✅ Конфигурация успешно загружена и проверена.');