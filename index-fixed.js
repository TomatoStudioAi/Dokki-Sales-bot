// ========== ЛОГИРОВАНИЕ СТАРТА ==========
console.log('=== BOT STARTUP ===');
console.log('Node version:', process.version);
console.log('Environment:', process.env.NODE_ENV || 'production');

// ========== ИМПОРТЫ С ОБРАБОТКОЙ ОШИБОК ==========
let config, db, llm, topics;

try {
  console.log('📦 Importing modules...');
  
  const configModule = await import('./config/env.js');
  config = configModule.config;
  console.log('✅ Config loaded');
  
  const dbModule = await import('./services/supabase.js');
  db = dbModule.db;
  console.log('✅ Database module loaded');
  
  const llmModule = await import('./services/llm.js');
  llm = llmModule.llm;
  console.log('✅ LLM module loaded');
  
  const topicsModule = await import('./services/topics.js');
  topics = topicsModule.topics;
  console.log('✅ Topics module loaded');
  
} catch (error) {
  console.error('❌ IMPORT ERROR:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
}

// ========== ПРОВЕРКА КОНФИГА ==========
if (!config?.telegram?.token) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in config!');
  process.exit(1);
}

if (!config?.telegram?.adminGroupId) {
  console.error('❌ ADMIN_GROUP_ID not found in config!');
  process.exit(1);
}

console.log('✅ Token exists:', config.telegram.token.substring(0, 10) + '...');
console.log('✅ Admin Group ID:', config.telegram.adminGroupId);

// ========== СОЗДАНИЕ БОТА ==========
const { Telegraf } = await import('telegraf');
const bot = new Telegraf(config.telegram.token);

console.log('✅ Bot instance created');

// ========== СИСТЕМНЫЙ ПРОМПТ ==========
const SYSTEM_PROMPT = `
You are Alexey, Senior Manager at I.T.C Solutions FZE (TomatoStudio).
Your style: professional, concise, expert. 
IMPORTANT: Respond in the SAME LANGUAGE as the client (RU/EN/AR).
If client asks for pricing -> suggest a meeting.
Goal: Qualify the lead and close for a call.
`;

// ========== ОПРЕДЕЛЕНИЕ ЯЗЫКА ==========
function detectLanguage(text) {
  if (/[а-яА-ЯёЁ]/.test(text)) return 'ru';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  return 'en';
}

// ========== MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ ВСЕХ СОБЫТИЙ ==========
bot.use((ctx, next) => {
  console.log('📨 [INCOMING UPDATE]', {
    type: ctx.updateType,
    chatId: ctx.chat?.id,
    from: ctx.from?.username,
    hasText: !!ctx.message?.text
  });
  return next();
});

// ========== ОБРАБОТКА ОШИБОК ==========
bot.catch((err, ctx) => {
  console.error('❌ [BOT ERROR]', err);
  console.error('Context:', {
    updateType: ctx.updateType,
    chatId: ctx.chat?.id
  });
});

// ========== ОБРАБОТКА СООБЩЕНИЙ ОТ КЛИЕНТОВ ==========
bot.on('message', async (ctx) => {
  console.log('💬 [MESSAGE HANDLER] Triggered');
  
  // Игнорируем сообщения в админ-группе
  if (ctx.chat.id.toString() === config.telegram.adminGroupId.toString()) {
    console.log('📋 [ADMIN GROUP] Redirecting to admin handler');
    return handleAdminReply(ctx);
  }

  const userId = ctx.from.id;
  const text = ctx.message.text || "[Медиа-сообщение]";
  const lang = detectLanguage(text);

  console.log(`👤 [CLIENT] User ${userId} (@${ctx.from.username}): ${text.substring(0, 50)}...`);

  try {
    // 1. Ищем или создаем топик в БД
    console.log('🔍 [DB] Getting topic for user', userId);
    let userTopic = await db.getTopic(userId);
    
    if (!userTopic) {
      console.log('📝 [TOPIC] Creating new topic');
      const topicId = await topics.create(ctx, ctx.from.first_name, ctx.from.username);
      userTopic = await db.createTopic({
        user_id: userId,
        topic_id: topicId,
        username: ctx.from.username,
        first_name: ctx.from.first_name
      });
      console.log(`✅ Новый клиент: ${ctx.from.first_name} (ID: ${userId}, Topic: ${topicId})`);
    } else {
      console.log(`✅ Existing topic: ${userTopic.topic_id}`);
    }

    // 2. Пересылаем сообщение клиента в админ-группу
    console.log('📤 [FORWARD] Sending to admin group');
    await ctx.telegram.sendMessage(config.telegram.adminGroupId, `<b>Клиент:</b> ${text}`, {
      message_thread_id: userTopic.topic_id,
      parse_mode: 'HTML'
    });

    // 3. Проверяем перехват админом
    if (userTopic.admin_override) {
      console.log('⏸️ [OVERRIDE] Admin has control, bot is silent');
      return;
    }

    // 4. Получаем историю и выбираем модель
    console.log('📚 [HISTORY] Getting conversation history');
    const history = await db.getHistory(userId);
    const model = llm.selectModel(text, history.length / 2, history);
    console.log(`🤖 [MODEL] Selected: ${model}`);

    // Имитация печатания
    await ctx.sendChatAction('typing');

    // 5. Запрос к ИИ
    console.log('🧠 [LLM] Requesting AI response');
    const aiResponse = await llm.ask(model, SYSTEM_PROMPT, history, text);
    console.log(`✅ [LLM] Response received (${aiResponse.tokens.output_tokens} tokens)`);

    // 6. Отвечаем клиенту
    await ctx.reply(aiResponse.text);
    console.log('✅ [REPLY] Sent to client');

    // 7. Дублируем ответ бота в админ-топик
    await ctx.telegram.sendMessage(config.telegram.adminGroupId, `<b>Алексей (ИИ):</b> ${aiResponse.text}`, {
      message_thread_id: userTopic.topic_id,
      parse_mode: 'HTML'
    });

    // 8. Логируем в Supabase
    console.log('💾 [DB] Logging message');
    await db.logMessage({
      user_id: userId,
      message_text: text,
      bot_response: aiResponse.text,
      model_used: aiResponse.model,
      tokens_input: aiResponse.tokens.input_tokens,
      tokens_output: aiResponse.tokens.output_tokens,
      cost_usd: aiResponse.cost,
      language: lang
    });

    console.log(`🎯 [SUCCESS] Response (${aiResponse.model}): $${aiResponse.cost.toFixed(6)}`);

  } catch (error) {
    console.error('❌ [ERROR] Handler failed:', error);
    console.error('Stack:', error.stack);
    
    // Отправляем клиенту сообщение об ошибке
    try {
      await ctx.reply('Извините, произошла ошибка. Попробуйте позже или напишите напрямую менеджеру.');
    } catch (e) {
      console.error('❌ Failed to send error message:', e);
    }
  }
});

// ========== ОБРАБОТКА ОТВЕТОВ ИЗ АДМИН-ГРУППЫ ==========
async function handleAdminReply(ctx) {
  const topicId = ctx.message?.message_thread_id;
  
  if (!topicId) {
    console.log('⏭️ [ADMIN] Message in General chat, ignoring');
    return;
  }

  console.log(`👨‍💼 [ADMIN] Reply in topic ${topicId}`);

  try {
    // Находим клиента по topic_id
    const { data: userTopic, error } = await db.supabase
      .from('user_topics')
      .select('*')
      .eq('topic_id', topicId)
      .single();

    if (error) throw error;

    if (userTopic) {
      // Пересылаем ответ админа клиенту
      await ctx.telegram.sendMessage(userTopic.user_id, ctx.message.text);
      
      // Включаем режим перехвата
      await db.setOverride(userTopic.user_id, true);
      console.log(`✅ [ADMIN] Took control in topic #${topicId} for user ${userTopic.user_id}`);
    } else {
      console.log(`⚠️ [ADMIN] No user found for topic ${topicId}`);
    }
  } catch (e) {
    console.error('❌ [ADMIN ERROR]', e);
  }
}

// ========== ЗАПУСК БОТА ==========
console.log('🚀 [LAUNCH] Starting bot...');

bot.launch()
  .then(() => {
    console.log('✅ ========================================');
    console.log('✅ БОТ "АЛЕКСЕЙ" ЗАПУЩЕН И ГОТОВ К РАБОТЕ');
    console.log('✅ ========================================');
  })
  .catch(err => {
    console.error('❌ ========================================');
    console.error('❌ BOT LAUNCH FAILED');
    console.error('❌ ========================================');
    console.error(err);
    process.exit(1);
  });

// ========== GRACEFUL SHUTDOWN ==========
process.once('SIGINT', () => {
  console.log('⚠️ [SHUTDOWN] SIGINT received');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('⚠️ [SHUTDOWN] SIGTERM received');
  bot.stop('SIGTERM');
});

console.log('🎯 [READY] All handlers registered');