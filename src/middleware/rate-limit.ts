import { createMiddleware } from "hono/factory";
import { AppError } from "../shared/errors.js";
import type { AppEnv } from "../types.js";

export interface RateLimitRule {
  /** Nome del contatore: limiti diversi non si sommano. */
  bucket: string;
  limit: number;
}

export interface RateLimitOptions {
  /** Regola da applicare alla richiesta, in base al path. */
  rule: (path: string) => RateLimitRule;
  windowMs?: number;
  now?: () => number;
}

/**
 * Finestra fissa in memoria, per utente. Su Vercel ogni istanza ha il suo contatore:
 * è un limite indicativo.
 */
export function rateLimit({ rule, windowMs = 60_000, now = Date.now }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return createMiddleware<AppEnv>(async (c, next) => {
    const t = now();
    const { bucket, limit } = rule(c.req.path);
    const key = `${bucket}:${c.get("userId")}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - t) / 1000)));
      throw new AppError("RATE_LIMITED", "Troppe richieste, riprova tra poco");
    }
    await next();
  });
}
