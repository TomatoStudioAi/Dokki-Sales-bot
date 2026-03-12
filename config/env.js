import 'dotenv/config';

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN', 'ADMIN_GROUP_ID', 'SUPABASE_URL', 
  'SUPABASE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'
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
    // ✅ ФИКС: Строгое приведение к числу (Number). Иначе API Telegram выдает ошибку.
    adminGroupId: Number(process.env.ADMIN_GROUP_ID),
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  ai: {
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    models: {
      filter: process.env.LLM_MODEL_FILTER || 'gpt-4o-mini',
      expert: process.env.LLM_MODEL_EXPERT || 'gpt-4o',
      closer: process.env.LLM_MODEL_CLOSER || 'claude-3-5-sonnet-20241022',
    },
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.1,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || 1000,
  }
};