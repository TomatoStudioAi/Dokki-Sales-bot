import { Telegraf } from 'telegraf';
import { config } from './config/env.js';
import { handleClientMessage } from './handlers/messages.js';
import { handleAdminReply } from './handlers/admin.js';

const bot = new Telegraf(config.telegram.token);

bot.on('message', async (ctx) => {
  try {
    // Если сообщение пришло из нашей админ-группы
    if (ctx.chat.id === config.telegram.adminGroupId) {
      return await handleAdminReply(ctx);
    }
    // Если сообщение пришло в ЛС боту
    if (ctx.chat.type === 'private') {
      return await handleClientMessage(ctx);
    }
  } catch (err) {
    console.error('🔥 Global Error:', err.message);
  }
});

bot.launch().then(() => {
  console.log('🚀 TomatoStudio AI "Алексей" запущен. Полная интеграция с БД.');
});

// ✅ ФИКС 409 Conflict: Грациозное завершение процесса
// При обновлении на Railway бот корректно отключается от Telegram, не оставляя "призраков"
process.once('SIGINT', () => {
  console.log('🛑 Получен сигнал SIGINT. Останавливаем сессию...');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('🛑 Получен сигнал SIGTERM. Останавливаем сессию...');
  bot.stop('SIGTERM');
});