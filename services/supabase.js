import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

const supabase = createClient(config.supabase.url, config.supabase.key);

export const db = {
  getTopic: async (userId) => {
    const { data, error } = await supabase
      .from('user_topics')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = "запись не найдена"
      throw new Error(`Ошибка БД при поиске топика: ${error.message}`);
    }
    return data || null;
  },

  saveTopic: async (userId, topicId, username) => {
    const record = { user_id: userId, topic_id: topicId, username, admin_override: false };
    const { error } = await supabase.from('user_topics').upsert(record);
    
    if (error) throw new Error(`Ошибка БД при сохранении топика: ${error.message}`);
    return record;
  },

  setOverride: async (userId, value) => {
    await supabase.from('user_topics').update({ admin_override: value }).eq('user_id', userId);
  },

  getUserIdByTopic: async (topicId) => {
    const { data, error } = await supabase.from('user_topics').select('user_id').eq('topic_id', topicId).single();
    if (error) return null;
    return data.user_id;
  },

  logMessage: async (log) => {
    await supabase.from('messages_log').insert(log).catch(e => console.error('Ошибка логирования:', e.message));
  },

  getHistory: async (userId) => {
    const { data, error } = await supabase
      .from('messages_log')
      .select('from_user, message_text')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error || !data) return [];
    return data.reverse().map(l => ({
      role: l.from_user ? 'user' : 'assistant',
      content: l.message_text
    }));
  }
};