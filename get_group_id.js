// Временный скрипт для получения ID админ-группы
require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

console.log('🤖 Бот запущен. Ожидаю команду /getid в админ-группе...\n');

// Обработчик команды /getid
bot.command('getid', (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  
  console.log('\n📋 Информация о чате:');
  console.log(`Chat ID: ${chatId}`);
  console.log(`Chat Type: ${chatType}`);
  console.log(`Chat Title: ${chatTitle}`);
  
  if (chatType === 'supergroup') {
    ctx.reply(
      `✅ Это супергруппа!\n\n` +
      `📊 Данные для .env:\n` +
      `ADMIN_GROUP_ID=${chatId}\n\n` +
      `Скопируй это значение в Railway environment variables.`,
      { reply_to_message_id: ctx.message.message_id }
    );
  } else if (chatType === 'group') {
    ctx.reply(
      `⚠️ Это обычная группа. Преобразуй её в супергруппу:\n` +
      `Settings → Group Type → Supergroup`,
      { reply_to_message_id: ctx.message.message_id }
    );
  } else {
    ctx.reply(
      `ℹ️ Chat ID: ${chatId}\n` +
      `Type: ${chatType}`,
      { reply_to_message_id: ctx.message.message_id }
    );
  }
});

// Запуск бота
bot.launch();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));