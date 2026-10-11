import { z } from "zod";
import {
  AVOIDABILITY,
  CATEGORIES,
  SIZE_UNITS,
  type Avoidability,
  type Category,
  type SizeUnit,
} from "../extraction/extraction.schema.js";
import { harmonizeMerchants, type MerchantSource } from "./merchants.js";
import { parseIsoInTimeZone, parseRangeEnd } from "../../shared/dates.js";
import { AppError } from "../../shared/errors.js";
import type { DatasetPosition, StatsRepo } from "./stats.repo.js";
import type { StatsDatasetQuery, StatsQuery } from "./stats.schemas.js";

export interface StatsDeps {
  stats: StatsRepo;
}

/** Esercenti restituiti da `topMerchants`. */
export const TOP_MERCHANTS = 10;

/** `timestamptz::text` di Postgres, es. `2026-09-10 10:00:00.123456+00`. */
const PG_TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
const DatasetCursor = z.object({ at: z.string().regex(PG_TIMESTAMPTZ), id: z.uuid() });

/** Cursore opaco del dataset: base64url di `{ at, id }` (vedi `DatasetPosition`). */
export function encodeDatasetCursor(p: DatasetPosition): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

export function decodeDatasetCursor(raw: string): DatasetPosition {
  try {
    return DatasetCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Cursore non valido");
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const asSizeUnit = (u: string | null): SizeUnit | null =>
  (SIZE_UNITS as readonly string[]).includes(u ?? "") ? (u as SizeUnit) : null;

const asAvoidability = (a: string | null): Avoidability | null =>
  (AVOIDABILITY as readonly string[]).includes(a ?? "") ? (a as Avoidability) : null;

const asCategory = (c: string): Category =>
  (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : "altro";

type MerchantNames = (source: MerchantSource) => string | null;

const variantKey = (s: MerchantSource) => JSON.stringify([s.name, s.brand, s.vat]);

/** Nomi armonizzati di tutte le varianti dell'utente, calcolati sull'intero storico. */
async function harmonizedNames(repo: StatsRepo, userId: string) {
  const variants = await repo.merchantVariants(userId);
  const names = harmonizeMerchants(variants);
  return variants.map((v, i) => ({ variantKey: variantKey(v), name: names[i] ?? null }));
}

/**
 * Nomi armonizzati: lo stesso negozio ha lo stesso nome in ogni periodo, così filtri e totali
 * di richieste diverse coincidono. Si leggono da `merchant_names`, scritta da `recompute`;
 * se una variante richiesta non c'è ancora (scontrino estratto dopo l'ultimo ricalcolo) si
 * ricalcolano sull'intero storico, come prima che la tabella esistesse.
 */
async function merchantNames(
  repo: StatsRepo,
  userId: string,
  stored: Promise<{ variantKey: string; name: string | null }[]>,
  sources: MerchantSource[],
): Promise<MerchantNames> {
  let rows = await stored;
  let byVariant = new Map(rows.map((r) => [r.variantKey, r.name]));
  if (sources.some((source) => !byVariant.has(variantKey(source)))) {
    rows = await harmonizedNames(repo, userId);
    byVariant = new Map(rows.map((r) => [r.variantKey, r.name]));
  }
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
  /** Riscrive `stats_monthly` e i nomi armonizzati dei negozi dell'utente. */
  async function recompute(userId: string) {
    const rows = await d.stats.recompute(userId);
    await d.stats.saveMerchantNames(userId, await harmonizedNames(d.stats, userId));
    return rows;
  }

  return {
    async summary(userId: string, q: StatsQuery) {
      const range = parseRange(q);
      const { from, to } = range;
      const stored = d.stats.storedMerchantNames(userId);
      const s = await d.stats.summary(userId, range, q.granularity);
      const nameOf = await merchantNames(d.stats, userId, stored, s.merchants);

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
      const stored = d.stats.storedMerchantNames(userId);
      const after = q.cursor ? decodeDatasetCursor(q.cursor) : null;
      const s = await d.stats.dataset(userId, range, q.limit, after);
      const nameOf = await merchantNames(
        d.stats,
        userId,
        stored,
        s.receipts.map((r) => ({
          name: r.merchantName,
          brand: r.merchantBrand,
          vat: r.merchantVat,
        })),
      );
      return {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        truncated: s.next !== null,
        nextCursor: s.next ? encodeDatasetCursor(s.next) : null,
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
          avoidability: asAvoidability(r.avoidability),
          source: r.source,
        })),
        items: s.items.map((i) => ({
          ...i,
          category: asCategory(i.category ?? "altro"),
          sizeUnit: asSizeUnit(i.sizeUnit),
          avoidability: asAvoidability(i.avoidability),
        })),
      };
    },

    recompute,

    /** Ricalcolo di tutti gli utenti (cron). Un errore su un utente non ferma gli altri. */
    async recomputeAll() {
      const users = await d.stats.listUserIds();
      let failed = 0;
      for (const userId of users) {
        try {
          await recompute(userId);
        } catch {
          failed += 1;
        }
      }
      return { users: users.length, failed };
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
