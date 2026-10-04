import { and, asc, eq } from "drizzle-orm";
import type { EncryptedSecret } from "../../infra/crypto/key-cipher.js";
import type { Db } from "../../infra/db/client.js";
import { userAiSettings, userApiKeys } from "../../infra/db/schema/index.js";

export type AiSettingsRow = typeof userAiSettings.$inferSelect;
export type ApiKeyRow = typeof userApiKeys.$inferSelect;

export interface AiSettingsValues {
  mode: "platform" | "byok";
  provider: string | null;
  model: string | null;
  fallbackToPlatform: boolean;
}

/** Parte pubblica di una chiave salvata: mai ciphertext, IV o tag. */
export interface ApiKeySummary {
  provider: string;
  last4: string;
  verifiedAt: Date | null;
}

/** Unico accesso alle impostazioni AI e alle chiavi BYOK: ogni query filtra per `userId`. */
export function createSettingsRepo(db: Db) {
  return {
    async getAiSettings(userId: string): Promise<AiSettingsRow | undefined> {
      const [row] = await db.select().from(userAiSettings).where(eq(userAiSettings.userId, userId));
      return row;
    },

    async upsertAiSettings(userId: string, v: AiSettingsValues, now: Date): Promise<void> {
      await db
        .insert(userAiSettings)
        .values({ userId, ...v, updatedAt: now })
        .onConflictDoUpdate({ target: userAiSettings.userId, set: { ...v, updatedAt: now } });
    },

    /** Riga cifrata della chiave del provider: va decifrata solo al momento della chiamata. */
    async getApiKey(userId: string, provider: string): Promise<ApiKeyRow | undefined> {
      const [row] = await db
        .select()
        .from(userApiKeys)
        .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
      return row;
    },

    async listApiKeys(userId: string): Promise<ApiKeySummary[]> {
      return db
        .select({
          provider: userApiKeys.provider,
          last4: userApiKeys.last4,
          verifiedAt: userApiKeys.verifiedAt,
        })
        .from(userApiKeys)
        .where(eq(userApiKeys.userId, userId))
        .orderBy(asc(userApiKeys.provider));
    },

    async upsertApiKey(
      userId: string,
      provider: string,
      secret: EncryptedSecret,
      last4: string,
      now: Date,
    ): Promise<ApiKeySummary> {
      const values = { ...secret, last4, verifiedAt: now, updatedAt: now };
      const [row] = await db
        .insert(userApiKeys)
        .values({ userId, provider, ...values, createdAt: now })
        .onConflictDoUpdate({ target: [userApiKeys.userId, userApiKeys.provider], set: values })
        .returning({
          provider: userApiKeys.provider,
          last4: userApiKeys.last4,
          verifiedAt: userApiKeys.verifiedAt,
        });
      if (!row) throw new Error("upsert user_api_keys senza risultato");
      return row;
    },

    /**
     * Cancella la chiave; se era quella in uso (`mode=byok` sullo stesso provider) torna a
     * `mode=platform`. Restituisce `false` se la chiave non esisteva.
     */
    async deleteApiKey(userId: string, provider: string, now: Date): Promise<boolean> {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(userApiKeys)
          .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)))
          .returning({ id: userApiKeys.id });
        if (deleted.length === 0) return false;
        await tx
          .update(userAiSettings)
          .set({ mode: "platform", updatedAt: now })
          .where(
            and(
              eq(userAiSettings.userId, userId),
              eq(userAiSettings.mode, "byok"),
              eq(userAiSettings.provider, provider),
            ),
          );
        return true;
      });
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
