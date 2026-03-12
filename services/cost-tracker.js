const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'deepseek-chat': { input: 0.27, output: 1.10 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 }
};

/**
 * Расчет стоимости запроса в USD (на 1 млн токенов)
 */
export function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  
  const cost = (inputTokens * pricing.input / 1_000_000) + 
               (outputTokens * pricing.output / 1_000_000);
  return parseFloat(cost.toFixed(6));
}