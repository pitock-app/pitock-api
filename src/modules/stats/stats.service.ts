import { CATEGORIES, type Category } from "../extraction/extraction.schema.js";
import { parseIsoInTimeZone, parseRangeEnd } from "../../shared/dates.js";
import { AppError } from "../../shared/errors.js";
import type { StatsRepo } from "./stats.repo.js";
import type { StatsQuery } from "./stats.schemas.js";

export interface StatsDeps {
  stats: StatsRepo;
}

/** Esercenti restituiti da `topMerchants`. */
export const TOP_MERCHANTS = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;

const asCategory = (c: string): Category =>
  (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : "altro";

/** Statistiche di spesa (`/v1/stats`) e ricalcolo di `stats_monthly`. */
export function createStatsService(d: StatsDeps) {
  return {
    async summary(userId: string, q: StatsQuery) {
      const from = q.from ? parseIsoInTimeZone(q.from) : undefined;
      const to = q.to ? parseRangeEnd(q.to) : undefined;
      if (from === null || to === null || (from && to && from >= to)) {
        throw new AppError("VALIDATION_ERROR", "Intervallo di date non valido");
      }
      const s = await d.stats.summary(
        userId,
        { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        q.granularity,
        TOP_MERCHANTS,
      );

      // Categorie fuori elenco (dati storici) confluiscono in "altro".
      const byCategory = new Map<Category, { total: number; nReceipts: number }>();
      for (const r of s.byCategory) {
        const key = asCategory(r.category);
        const prev = byCategory.get(key) ?? { total: 0, nReceipts: 0 };
        byCategory.set(key, {
          total: prev.total + r.total,
          nReceipts: prev.nReceipts + r.nReceipts,
        });
      }
      const amounts = <T extends { total: number }>(r: T) => ({ ...r, total: round2(r.total) });

      return {
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        granularity: q.granularity,
        totals: {
          total: round2(s.totals.total),
          nReceipts: s.totals.nReceipts,
          average: s.totals.nReceipts > 0 ? round2(s.totals.total / s.totals.nReceipts) : 0,
        },
        byCategory: [...byCategory]
          .map(([category, v]) => amounts({ category, ...v }))
          .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
        byPeriod: s.byPeriod.map(amounts),
        topMerchants: s.topMerchants.map(amounts),
        bySource: s.bySource.map(amounts),
      };
    },

    /** Riscrive `stats_monthly` dell'utente. */
    recompute: (userId: string) => d.stats.recompute(userId),

    /** Ricalcolo di tutti gli utenti (cron). Un errore su un utente non ferma gli altri. */
    async recomputeAll() {
      const users = await d.stats.listUserIds();
      let failed = 0;
      for (const userId of users) {
        try {
          await d.stats.recompute(userId);
        } catch {
          failed += 1;
        }
      }
      return { users: users.length, failed };
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
