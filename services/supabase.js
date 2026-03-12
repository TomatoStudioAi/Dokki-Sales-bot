import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

const supabase = createClient(config.supabase.url, config.supabase.key);

export const db = {
  // Получить данные топика пользователя
  async getTopic(userId) {
    const { data, error } = await supabase
      .from('user_topics')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Создать новый топик
  async createTopic(userData) {
    const { data, error } = await supabase
      .from('user_topics')
      .insert([userData])
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },

  // Обновить статус вмешательства админа
  async setOverride(userId, status) {
    const { error } = await supabase
      .from('user_topics')
      .update({ admin_override: status, last_activity: new Date() })
      .eq('user_id', userId);
    
    if (error) throw error;
  },

  // Логирование сообщения и стоимости
  async logMessage(logData) {
    const { error } = await supabase
      .from('messages_log')
      .insert([logData]);
    
    if (error) console.error('⚠️ Ошибка записи лога:', error.message);
  },

  // Получение истории для контекста ИИ
  async getHistory(userId, limit = 5) {
    const { data, error } = await supabase
      .from('messages_log')
      .select('message_text, bot_response')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) return [];
    return data.reverse().flatMap(m => [
      { role: 'user', content: m.message_text },
      { role: 'assistant', content: m.bot_response }
    ]);
  }
};