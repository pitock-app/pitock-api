import { sql } from "drizzle-orm";
import type { RateLimitStore } from "../../middleware/rate-limit.js";
import type { Db } from "./client.js";
import { rateLimits } from "./schema/index.js";
import { timestamptz } from "./timestamptz.js";

/**
 * Rate limit condiviso tra le istanze: un solo upsert atomico per richiesta. Se la finestra è
 * scaduta il contatore riparte da 1, altrimenti si incrementa.
 */
export function createPgRateLimitStore(db: Db): RateLimitStore {
  return {
    async hit(key, windowMs, now) {
      const at = timestamptz(new Date(now));
      const resetAt = timestamptz(new Date(now + windowMs));
      const [row] = await db
        .insert(rateLimits)
        .values({ key, count: 1, resetAt: sql`${resetAt}` })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            count: sql`case when ${rateLimits.resetAt} <= ${at} then 1 else ${rateLimits.count} + 1 end`,
            resetAt: sql`case when ${rateLimits.resetAt} <= ${at} then ${resetAt} else ${rateLimits.resetAt} end`,
          },
        })
        .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
      if (!row) throw new Error("rate limit: nessuna riga restituita");
      return { count: row.count, resetAt: row.resetAt.getTime() };
    },
  };
}
