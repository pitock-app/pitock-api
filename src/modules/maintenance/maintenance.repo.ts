import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import { rateLimits, receiptsRaw } from "../../infra/db/schema/index.js";
import { timestamptz } from "../../infra/db/timestamptz.js";
import type { ExtractionErrorCode } from "../extraction/extraction-errors.js";

/**
 * Pulizie periodiche. Unica eccezione alla regola "ogni query filtra per `userId`": lavora su
 * tutti gli utenti ed è usata solo dal cron, mai dalle rotte `/v1`.
 */
export function createMaintenanceRepo(db: Db) {
  return {
    /** Scontrini rimasti in `processing` da prima di `cutoff`: passano a `failed`. */
    async failStaleProcessing(cutoff: Date, errorCode: ExtractionErrorCode) {
      return db
        .update(receiptsRaw)
        .set({ status: "failed", errorCode })
        .where(
          and(eq(receiptsRaw.status, "processing"), lt(receiptsRaw.updatedAt, timestamptz(cutoff))),
        )
        .returning({ id: receiptsRaw.id, userId: receiptsRaw.userId });
    },

    /** Upload mai completati, creati prima di `cutoff`. */
    async staleUploads(cutoff: Date, limit: number) {
      return db
        .select({ id: receiptsRaw.id, storagePath: receiptsRaw.storagePath })
        .from(receiptsRaw)
        .where(
          and(
            eq(receiptsRaw.status, "pending_upload"),
            lt(receiptsRaw.createdAt, timestamptz(cutoff)),
          ),
        )
        .limit(limit);
    },

    /** Cancella le righe indicate, solo se sono ancora `pending_upload`. */
    async deletePendingUploads(ids: string[]) {
      if (ids.length === 0) return 0;
      const rows = await db
        .delete(receiptsRaw)
        .where(and(inArray(receiptsRaw.id, ids), eq(receiptsRaw.status, "pending_upload")))
        .returning({ id: receiptsRaw.id });
      return rows.length;
    },

    /** Contatori del rate limit scaduti prima di `cutoff`. */
    async purgeRateLimits(cutoff: Date) {
      const rows = await db
        .delete(rateLimits)
        .where(lt(rateLimits.resetAt, timestamptz(cutoff)))
        .returning({ key: rateLimits.key });
      return rows.length;
    },
  };
}

export type MaintenanceRepo = ReturnType<typeof createMaintenanceRepo>;
