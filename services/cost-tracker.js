const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'deepseek-chat': { input: 0.14, output: 0.28 }, // V3.2 через стандартный алиас
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 } // Для обратной совместимости
};

/**
 * Расчет стоимости запроса в USD (на 1 млн токенов)
 */
export function calculateCost(model, inputTokens, outputTokens) {
  // Приводим модель к нижнему регистру для поиска
  const modelKey = model.toLowerCase();
  const pricing = PRICING[modelKey];
  
  if (!pricing) {
    console.warn(`⚠️ Цена для модели ${model} не найдена в PRICING`);
    return 0;
  }
  
  const cost = (inputTokens * pricing.input / 1_000_000) + 
               (outputTokens * pricing.output / 1_000_000);
               
  return parseFloat(cost.toFixed(6));
}