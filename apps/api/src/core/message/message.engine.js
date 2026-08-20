import { detectIntent, Intent } from "../intent/intent.core.js";
import { parseTransactionsWithAI } from "../parser/ai-transaction.parser.js";
import { parseBudgetMessage } from "../parser/budget.parser.js";

export async function processMessage(message) {
  const intent = detectIntent(message);

  if (intent === Intent.CREATE_TRANSACTION) {
    const data = await parseTransactionsWithAI(message);
    return {
      success: true,
      intent,
      data
    };
  }

  if (intent === Intent.SET_BUDGET) {
    return {
      success: true,
      intent,
      data: parseBudgetMessage(message)
    };
  }

  return {
    success: true,
    intent,
    data: null
  };
}