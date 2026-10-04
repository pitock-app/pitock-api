import type { Provider } from "../config/env.js";

/** Eventi asincroni. Contengono solo identificativi: mai file, chiavi o dati personali. */
export interface QueueEvents {
  "receipt/uploaded": {
    receiptId: string;
    userId: string;
    /** Solo per `reextract`: override facoltativo del modello. */
    reextract?: { provider?: Provider; model?: string };
  };
  "stats/recompute": { userId: string };
}

export type QueueEventName = keyof QueueEvents;

export interface QueuePort {
  send<N extends QueueEventName>(name: N, data: QueueEvents[N]): Promise<void>;
}
