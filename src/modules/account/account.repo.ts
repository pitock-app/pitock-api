import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import {
  llmUsage,
  receiptsRaw,
  statsMonthly,
  userAiSettings,
  userApiKeys,
} from "../../infra/db/schema/index.js";

/** Accesso ai dati dell'intero account, per la cancellazione: ogni query filtra per `userId`. */
export function createAccountRepo(db: Db) {
  return {
    /** Percorsi di tutti i file dell'utente, anche quelli in attesa di upload. */
    async listStoragePaths(userId: string): Promise<string[]> {
      const rows = await db
        .select({ path: receiptsRaw.storagePath })
        .from(receiptsRaw)
        .where(and(eq(receiptsRaw.userId, userId), isNotNull(receiptsRaw.storagePath)));
      return rows.flatMap((r) => (r.path ? [r.path] : []));
    },

    /** Cancella tutte le righe dell'utente in una transazione (estrazioni e righe a cascata). */
    async deleteAllData(userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(llmUsage).where(eq(llmUsage.userId, userId));
        await tx.delete(statsMonthly).where(eq(statsMonthly.userId, userId));
        await tx.delete(userApiKeys).where(eq(userApiKeys.userId, userId));
        await tx.delete(userAiSettings).where(eq(userAiSettings.userId, userId));
        await tx.delete(receiptsRaw).where(eq(receiptsRaw.userId, userId));
      });
    },
  };
}

export type AccountRepo = ReturnType<typeof createAccountRepo>;
