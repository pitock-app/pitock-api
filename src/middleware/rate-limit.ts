import { createMiddleware } from "hono/factory";
import { AppError } from "../shared/errors.js";
import type { AppEnv } from "../types.js";

export interface RateLimitRule {
  /** Nome del contatore: limiti diversi non si sommano. */
  bucket: string;
  limit: number;
}

/** Contatore a finestra fissa: incrementa e restituisce il valore dopo l'incremento. */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>;
}

/**
 * Contatore in memoria, per i test e lo sviluppo. Su Vercel ogni istanza avrebbe il suo:
 * in produzione si usa quello su Postgres (`createPgRateLimitStore`).
 */
export function createMemoryRateLimitStore(): RateLimitStore {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, windowMs, now) {
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        if (hits.size > 10_000) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        }
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return Promise.resolve({ ...entry });
    },
  };
}

export interface RateLimitOptions {
  /** Regola da applicare alla richiesta, in base al path. */
  rule: (path: string) => RateLimitRule;
  store: RateLimitStore;
  windowMs?: number;
  now?: () => number;
  /** Errore del contatore (es. database irraggiungibile): la richiesta passa comunque. */
  onStoreError?: (err: unknown) => void;
}

/** Limite per utente a finestra fissa, con il contatore in `store`. */
export function rateLimit({
  rule,
  store,
  windowMs = 60_000,
  now = Date.now,
  onStoreError,
}: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const t = now();
    const { bucket, limit } = rule(c.req.path);
    let hit: { count: number; resetAt: number } | null = null;
    try {
      hit = await store.hit(`${bucket}:${c.get("userId")}`, windowMs, t);
    } catch (err) {
      // Meglio servire la richiesta senza limite che rifiutarla per un problema del contatore.
      onStoreError?.(err);
    }
    if (hit && hit.count > limit) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((hit.resetAt - t) / 1000))));
      throw new AppError("RATE_LIMITED", "Troppe richieste, riprova tra poco");
    }
    await next();
  });
}
