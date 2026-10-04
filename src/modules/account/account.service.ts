import type { Env } from "../../config/env.js";
import type { Clock } from "../../ports/clock.port.js";
import type { StoragePort } from "../../ports/storage.port.js";
import type { UserAdminPort } from "../../ports/user-admin.port.js";
import type { SettingsRepo } from "../settings/settings.repo.js";
import { platformQuota } from "../usage/quota.js";
import type { UsageRepo } from "../usage/usage.repo.js";
import type { AccountRepo } from "./account.repo.js";

export interface AccountDeps {
  account: AccountRepo;
  storage: StoragePort;
  users: UserAdminPort;
  settings: SettingsRepo;
  usage: UsageRepo;
  clock: Clock;
  env: Pick<Env, "DEFAULT_PROVIDER" | "DEFAULT_MODEL" | "PLATFORM_MONTHLY_RECEIPT_LIMIT">;
}

/** File cancellati per chiamata a Storage. */
const STORAGE_BATCH = 100;

export function createAccountService(d: AccountDeps) {
  return {
    async me(userId: string, email: string | null) {
      const s = await d.settings.getAiSettings(userId);
      const byok = s?.mode === "byok";
      return {
        userId,
        email,
        ai: {
          mode: byok ? ("byok" as const) : ("platform" as const),
          provider: byok ? (s.provider ?? null) : d.env.DEFAULT_PROVIDER,
          model: byok ? (s.model ?? null) : (d.env.DEFAULT_MODEL ?? null),
        },
        platformQuota: await platformQuota(
          d.usage,
          d.clock,
          userId,
          d.env.PLATFORM_MONTHLY_RECEIPT_LIMIT,
        ),
      };
    },

    /**
     * Cancella l'account: prima i file (se Storage fallisce non si cancella nulla), poi tutte le
     * righe in una transazione, poi l'utente di Supabase Auth. Infine ripulisce di nuovo la cartella
     * `{user_id}/`, per gli upload con URL firmato arrivati durante la cancellazione.
     * Ogni passo è idempotente: dopo un errore la richiesta si può ripetere.
     */
    async deleteAccount(userId: string) {
      const paths = await d.account.listStoragePaths(userId);
      for (let i = 0; i < paths.length; i += STORAGE_BATCH) {
        await d.storage.remove(paths.slice(i, i + STORAGE_BATCH));
      }
      await d.storage.removeFolder(userId);
      await d.account.deleteAllData(userId);
      await d.users.deleteUser(userId);
      await d.storage.removeFolder(userId);
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
