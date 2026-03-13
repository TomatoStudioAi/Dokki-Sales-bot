import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

const supabase = createClient(config.supabase.url, config.supabase.key);

export const db = {
  // Экспортируем сам клиент для прямых запросов в index.js
  supabase,

  getTopic: async (userId) => {
    const { data, error } = await supabase
      .from('user_topics')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Ошибка БД при поиске топика: ${error.message}`);
    }
    return data || null;
  },

  // Изменено название и аргументы под вызов в index.js
  createTopic: async (topicData) => {
    const record = { 
      user_id: topicData.user_id, 
      topic_id: topicData.topic_id, 
      username: topicData.username || 'n/a',
      first_name: topicData.first_name || 'Клиент',
      admin_override: false 
    };
    const { error } = await supabase.from('user_topics').upsert(record);
    
    if (error) throw new Error(`Ошибка БД при сохранении топика: ${error.message}`);
    return record;
  },

  setOverride: async (userId, value) => {
    await supabase.from('user_topics').update({ 
        admin_override: value,
        admin_override_at: value ? new Date().toISOString() : null
    }).eq('user_id', userId);
  },

  getUserIdByTopic: async (topicId) => {
    const { data, error } = await supabase.from('user_topics').select('user_id').eq('topic_id', topicId).single();
    if (error) return null;
    return data.user_id;
  },

  logMessage: async (log) => {
        const { error } = await supabase.from('messages_log').insert(log);
        if (error) console.error('[logMessage] Ошибка:', error.message);
    },

  // Исправлено формирование истории из парных записей
  getHistory: async (userId) => {
    const { data, error } = await supabase
      .from('messages_log')
      .select('message_text, bot_response')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error || !data) return [];
    
    const history = [];
    data.reverse().forEach(row => {
      if (row.message_text) history.push({ role: 'user', content: row.message_text });
      if (row.bot_response) history.push({ role: 'assistant', content: row.bot_response });
    });

    return history;
  }
};