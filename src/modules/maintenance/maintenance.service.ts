import type { Clock } from "../../ports/clock.port.js";
import type { StoragePort } from "../../ports/storage.port.js";
import type { MaintenanceRepo } from "./maintenance.repo.js";

/** Oltre questo tempo in `processing` l'estrazione non è più in corso: la funzione è morta. */
export const STALE_PROCESSING_MS = 10 * 60_000;
/** Un URL di upload vale 2 minuti: dopo un'ora un `pending_upload` non verrà più completato. */
export const STALE_UPLOAD_MS = 60 * 60_000;
/** Upload orfani cancellati per esecuzione (il cron è giornaliero). */
export const STALE_UPLOAD_BATCH = 500;

export interface MaintenanceDeps {
  maintenance: MaintenanceRepo;
  storage: StoragePort;
  clock: Clock;
}

export function createMaintenanceService(d: MaintenanceDeps) {
  return {
    /**
     * Sblocca gli scontrini rimasti in `processing` (es. funzione interrotta dalla piattaforma
     * prima di poter segnare l'errore), cancella gli upload mai completati con i loro file e
     * i contatori del rate limit scaduti.
     * Idempotente: si può rilanciare.
     */
    async cleanup() {
      const now = d.clock.now().getTime();
      const failed = await d.maintenance.failStaleProcessing(
        new Date(now - STALE_PROCESSING_MS),
        "TIMEOUT",
      );
      const stale = await d.maintenance.staleUploads(
        new Date(now - STALE_UPLOAD_MS),
        STALE_UPLOAD_BATCH,
      );
      const paths = stale.flatMap((r) => (r.storagePath ? [r.storagePath] : []));
      // Prima i file: se la cancellazione fallisce, le righe restano e il prossimo giro riprova.
      if (paths.length > 0) await d.storage.remove(paths);
      const deletedUploads = await d.maintenance.deletePendingUploads(stale.map((r) => r.id));
      // I contatori scadono dopo un minuto: un'ora di margine basta.
      const purgedRateLimits = await d.maintenance.purgeRateLimits(new Date(now - 60 * 60_000));
      return { failedProcessing: failed.length, deletedUploads, purgedRateLimits };
    },
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
