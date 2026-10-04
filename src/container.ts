import type { Env } from "./config/env.js";
import { createDb, type Db } from "./infra/db/client.js";
import { unavailableDb } from "./infra/db/unavailable.js";
import type { Inngest } from "inngest";
import { createKeyCipher, type KeyCipher } from "./infra/crypto/key-cipher.js";
import { createAiSdkLlm } from "./infra/llm/ai-sdk.adapter.js";
import { createModelCatalog } from "./infra/llm/model-catalog.adapter.js";
import { createInngestQueue } from "./infra/queue/inngest.adapter.js";
import { createInngest } from "./infra/queue/inngest.client.js";
import { createSupabaseStorage } from "./infra/storage/supabase-storage.adapter.js";
import {
  createJwtVerifier,
  remoteJwks,
  SUPABASE_AUDIENCE,
  type TokenVerifier,
} from "./middleware/auth.js";
import { createAiRouter } from "./modules/ai/ai-router.js";
import { createModelsService } from "./modules/ai/models.service.js";
import { createExtractionService } from "./modules/extraction/extraction.service.js";
import { createAccountRepo } from "./modules/account/account.repo.js";
import { createAccountService } from "./modules/account/account.service.js";
import { createStatsRepo } from "./modules/stats/stats.repo.js";
import { createStatsService } from "./modules/stats/stats.service.js";
import { createSupabaseUserAdmin } from "./infra/auth/supabase-user-admin.adapter.js";
import type { UserAdminPort } from "./ports/user-admin.port.js";
import { createExtractionEditService } from "./modules/extraction/extraction-edit.service.js";
import { createExtractionsRepo } from "./modules/extraction/extractions.repo.js";
import { createReceiptsRepo } from "./modules/receipts/receipts.repo.js";
import { createReceiptsService } from "./modules/receipts/receipts.service.js";
import { createSettingsRepo } from "./modules/settings/settings.repo.js";
import { createSettingsService } from "./modules/settings/settings.service.js";
import { createUsageRepo } from "./modules/usage/usage.repo.js";
import { createUsageService } from "./modules/usage/usage.service.js";
import { systemClock, type Clock } from "./ports/clock.port.js";
import type { LlmPort } from "./ports/llm.port.js";
import type { ModelCatalogPort } from "./ports/model-catalog.port.js";
import type { QueuePort } from "./ports/queue.port.js";
import type { StoragePort } from "./ports/storage.port.js";
import { AppError } from "./shared/errors.js";

export interface Infra {
  db: Db;
  storage: StoragePort;
  queue: QueuePort;
  clock: Clock;
  auth: TokenVerifier;
  llm: LlmPort;
  catalog: ModelCatalogPort;
  users: UserAdminPort;
}

/** Cifrario delle chiavi BYOK; `null` se `KEY_ENCRYPTION_SECRET` manca. */
const keyCipher = (env: Env): KeyCipher | null =>
  env.KEY_ENCRYPTION_SECRET
    ? createKeyCipher({ keys: { 1: env.KEY_ENCRYPTION_SECRET }, currentVersion: 1 })
    : null;

const unavailable = (what: string) => () => {
  throw new AppError("SERVICE_UNAVAILABLE", `${what} non configurato`);
};

/** Servizi costruiti sopra le porte: gli stessi in produzione e nei test. */
export function buildContainer(env: Env, infra: Infra) {
  const receipts = createReceiptsRepo(infra.db);
  const extractions = createExtractionsRepo(infra.db);
  const usage = createUsageRepo(infra.db);
  const settings = createSettingsRepo(infra.db);
  const cipher = keyCipher(env);
  const router = createAiRouter({ settings, usage, clock: infra.clock, cipher, env });

  return {
    auth: infra.auth,
    receipts: createReceiptsService({
      receipts,
      extractions,
      usage,
      storage: infra.storage,
      queue: infra.queue,
      clock: infra.clock,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
    }),
    extractionEdit: createExtractionEditService({ extractions, queue: infra.queue }),
    extraction: createExtractionService({
      receipts,
      extractions,
      usage,
      router,
      llm: infra.llm,
      storage: infra.storage,
      queue: infra.queue,
      clock: infra.clock,
    }),
    account: createAccountService({
      account: createAccountRepo(infra.db),
      storage: infra.storage,
      users: infra.users,
      settings,
      usage,
      clock: infra.clock,
      env,
    }),
    stats: createStatsService({ stats: createStatsRepo(infra.db) }),
    settings: createSettingsService({
      settings,
      usage,
      catalog: infra.catalog,
      cipher,
      clock: infra.clock,
      env,
    }),
    models: createModelsService({
      settings,
      usage,
      catalog: infra.catalog,
      llm: infra.llm,
      cipher,
      clock: infra.clock,
    }),
    usage: createUsageService({ usage, clock: infra.clock }),
  };
}

export type Container = ReturnType<typeof buildContainer>;

/**
 * Adapter reali. Nessuna connessione all'avvio: ciò che manca nell'env
 * risponde 503 solo quando viene usato, così l'app parte anche senza segreti.
 */
export function createContainer(env: Env, inngest: Inngest = createInngest(env)): Container {
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL).db : unavailableDb();

  const storage: StoragePort =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? createSupabaseStorage({
          url: env.SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        })
      : {
          createSignedUploadUrl: unavailable("Storage"),
          createSignedReadUrl: unavailable("Storage"),
          stat: unavailable("Storage"),
          readHead: unavailable("Storage"),
          download: unavailable("Storage"),
          remove: unavailable("Storage"),
          removeFolder: unavailable("Storage"),
        };

  const users: UserAdminPort =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? createSupabaseUserAdmin({
          url: env.SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        })
      : { deleteUser: unavailable("Auth admin") };

  const auth: TokenVerifier =
    env.SUPABASE_JWKS_URL && env.SUPABASE_JWT_ISSUER
      ? createJwtVerifier({
          jwks: remoteJwks(env.SUPABASE_JWKS_URL),
          issuer: env.SUPABASE_JWT_ISSUER,
          audience: SUPABASE_AUDIENCE,
        })
      : { verify: unavailable("Auth") };

  const queue = createInngestQueue(inngest);

  return buildContainer(env, {
    db,
    storage,
    queue,
    clock: systemClock,
    auth,
    llm: createAiSdkLlm(),
    catalog: createModelCatalog(),
    users,
  });
}
