import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Provider } from "../../config/env.js";

/**
 * Modello del provider con la chiave data. Nessun nome di modello è scritto nel codice:
 * arriva da `DEFAULT_MODEL` o dalle impostazioni dell'utente.
 */
export type ModelFactory = (provider: Provider, model: string, apiKey: string) => LanguageModel;

export const createProviderModel: ModelFactory = (provider, model, apiKey) => {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "openrouter":
      return createOpenRouter({ apiKey }).chat(model);
  }
};
