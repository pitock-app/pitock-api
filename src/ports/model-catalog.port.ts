import type { Provider } from "../config/env.js";

export interface CatalogModel {
  id: string;
  label: string;
  /** `null` se il provider non dichiara la capacità nel suo elenco. */
  supportsImages: boolean | null;
  supportsPdf: boolean | null;
}

/**
 * Elenco dei modelli e verifica delle chiavi sugli endpoint dei provider (senza consumare token).
 * Gli errori sono `LlmError` con `kind` `auth`, `quota` o `unavailable`.
 */
export interface ModelCatalogPort {
  verifyKey(provider: Provider, apiKey: string): Promise<void>;
  /** `apiKey` è `null` solo per i provider con elenco pubblico (OpenRouter). */
  listModels(provider: Provider, apiKey: string | null): Promise<CatalogModel[]>;
}
