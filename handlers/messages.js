import { db } from '../services/supabase.js';
import { getAIResponse } from '../services/llm.js';
import { config } from '../config/env.js';

export const handleClientMessage = async (ctx) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    if (!text) return;

    let topic = await db.getTopic(userId);

    if (!topic) {
      const forum = await ctx.telegram.createForumTopic(
        config.telegram.adminGroupId,
        `${ctx.from.first_name} (@${ctx.from.username || 'n/a'})`
      );
      topic = await db.saveTopic(userId, forum.message_thread_id, ctx.from.username || 'n/a');
    }

    await ctx.telegram.sendMessage(config.telegram.adminGroupId, `👤 Клиент: ${text}`, { 
      message_thread_id: topic.topic_id 
    });

    if (topic.admin_override) return;

    const history = await db.getHistory(userId);
    const ai = await getAIResponse(userId, text, history);

    await ctx.reply(ai.text);
    
    await ctx.telegram.sendMessage(config.telegram.adminGroupId, `🤖 Алексей (${ai.model}): ${ai.text}`, { 
      message_thread_id: topic.topic_id 
    });

    await db.logMessage({
      user_id: userId, message_text: text, bot_response: ai.text, model_used: ai.model, from_user: true
    });

  } catch (err) {
    console.error('❌ Ошибка в сообщениях:', err.message);
    await ctx.reply("Извините, произошла техническая ошибка. Я уже передал информацию менеджеру.");
  }
};