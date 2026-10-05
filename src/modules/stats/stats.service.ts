import {
  CATEGORIES,
  SIZE_UNITS,
  type Category,
  type SizeUnit,
} from "../extraction/extraction.schema.js";
import { harmonizeMerchants, type MerchantSource } from "./merchants.js";
import { parseIsoInTimeZone, parseRangeEnd } from "../../shared/dates.js";
import { AppError } from "../../shared/errors.js";
import type { StatsRepo } from "./stats.repo.js";
import type { StatsDatasetQuery, StatsQuery } from "./stats.schemas.js";

export interface StatsDeps {
  stats: StatsRepo;
}

/** Esercenti restituiti da `topMerchants`. */
export const TOP_MERCHANTS = 10;

/** Massimo di scontrini e di righe restituiti da `/v1/stats/dataset`. */
export const DATASET_LIMIT = 5000;

const round2 = (n: number) => Math.round(n * 100) / 100;

const asSizeUnit = (u: string | null): SizeUnit | null =>
  (SIZE_UNITS as readonly string[]).includes(u ?? "") ? (u as SizeUnit) : null;

const asCategory = (c: string): Category =>
  (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : "altro";

type MerchantNames = (source: MerchantSource) => string | null;

const variantKey = (s: MerchantSource) => JSON.stringify([s.name, s.brand, s.vat]);

/**
 * Nomi armonizzati calcolati su tutte le varianti dell'utente: lo stesso negozio ha lo stesso
 * nome in ogni periodo, così filtri e totali di richieste diverse coincidono.
 */
async function merchantNames(repo: StatsRepo, userId: string): Promise<MerchantNames> {
  const variants = await repo.merchantVariants(userId);
  const names = harmonizeMerchants(variants);
  const byVariant = new Map(variants.map((v, i) => [variantKey(v), names[i] ?? null]));
  return (source) => byVariant.get(variantKey(source)) ?? harmonizeMerchants([source])[0] ?? null;
}

/** Classifica dei negozi con i nomi armonizzati (vedi `merchants.ts`). */
function topMerchants(
  rows: (MerchantSource & { total: number; nReceipts: number })[],
  nameOf: MerchantNames,
) {
  const byName = new Map<string, { total: number; nReceipts: number }>();
  for (const row of rows) {
    const name = nameOf(row);
    if (!name) continue;
    const current = byName.get(name) ?? { total: 0, nReceipts: 0 };
    byName.set(name, {
      total: current.total + row.total,
      nReceipts: current.nReceipts + row.nReceipts,
    });
  }
  return [...byName]
    .map(([merchantName, v]) => ({ merchantName, ...v }))
    .sort((a, b) => b.total - a.total || a.merchantName.localeCompare(b.merchantName))
    .slice(0, TOP_MERCHANTS);
}

/** Intervallo della query: `to` diventa esclusivo. Errore se le date non sono valide. */
function parseRange(q: { from?: string; to?: string }) {
  const from = q.from ? parseIsoInTimeZone(q.from) : undefined;
  const to = q.to ? parseRangeEnd(q.to) : undefined;
  if (from === null || to === null || (from && to && from >= to)) {
    throw new AppError("VALIDATION_ERROR", "Intervallo di date non valido");
  }
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** Statistiche di spesa (`/v1/stats`, `/v1/stats/dataset`) e ricalcolo di `stats_monthly`. */
export function createStatsService(d: StatsDeps) {
  return {
    async summary(userId: string, q: StatsQuery) {
      const range = parseRange(q);
      const { from, to } = range;
      const [s, nameOf] = await Promise.all([
        d.stats.summary(userId, range, q.granularity),
        merchantNames(d.stats, userId),
      ]);

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
        topMerchants: topMerchants(s.merchants, nameOf).map(amounts),
        bySource: s.bySource.map(amounts),
      };
    },

    /** Scontrini e righe prodotto del periodo, per le analisi di convenienza della dashboard. */
    async dataset(userId: string, q: StatsDatasetQuery) {
      const range = parseRange(q);
      const [s, nameOf] = await Promise.all([
        d.stats.dataset(userId, range, DATASET_LIMIT),
        merchantNames(d.stats, userId),
      ]);
      return {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        truncated: s.receipts.length >= DATASET_LIMIT || s.items.length >= DATASET_LIMIT,
        receipts: s.receipts.map((r) => ({
          id: r.id,
          date: r.date.toISOString(),
          merchantName: nameOf({
            name: r.merchantName,
            brand: r.merchantBrand,
            vat: r.merchantVat,
          }),
          merchantOriginal: r.merchantName,
          total: r.total,
          category: asCategory(r.category ?? "altro"),
          source: r.source,
        })),
        items: s.items.map((i) => ({
          ...i,
          category: asCategory(i.category ?? "altro"),
          sizeUnit: asSizeUnit(i.sizeUnit),
        })),
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
