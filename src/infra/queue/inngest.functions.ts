import type { Inngest } from "inngest";
import type { Container } from "../../container.js";
import { extractReceiptJob } from "../../jobs/extract-receipt.job.js";
import { recomputeStatsJob } from "../../jobs/recompute-stats.job.js";

/** Funzioni servite su `/api/inngest`. */
export function createInngestFunctions(inngest: Inngest, container: Container) {
  const extract = extractReceiptJob(container.extraction);
  const recompute = recomputeStatsJob(container.stats);

  return [
    inngest.createFunction(
      {
        id: "extract-receipt",
        triggers: [{ event: "receipt/uploaded" }],
        // Il job gestisce da sé i fallimenti (scontrino `failed`): un nuovo tentativo non servirebbe.
        retries: 0,
        // Un job per utente alla volta: il controllo della quota non può essere superato in parallelo.
        concurrency: { key: "event.data.userId", limit: 1 },
      },
      async ({ event, step }) => step.run("extract", () => extract(event.data)),
    ),
    inngest.createFunction(
      {
        id: "recompute-stats",
        triggers: [{ event: "stats/recompute" }],
        // Raffiche di eventi dello stesso utente (es. upload multipli): basta l'ultimo ricalcolo.
        debounce: { key: "event.data.userId", period: "10s" },
        concurrency: { key: "event.data.userId", limit: 1 },
      },
      async ({ event, step }) => step.run("recompute", () => recompute(event.data)),
    ),
  ];
}
