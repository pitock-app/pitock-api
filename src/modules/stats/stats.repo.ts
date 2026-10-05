import { and, asc, desc, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import {
  extractions,
  receiptItems,
  receiptsRaw,
  statsMonthly,
} from "../../infra/db/schema/index.js";
import { timestamptz } from "../../infra/db/timestamptz.js";
import { DEFAULT_TIME_ZONE } from "../../shared/dates.js";

export interface StatsRange {
  from?: Date;
  /** Esclusivo. */
  to?: Date;
}

export type Granularity = "month" | "year";

/** Data dello scontrino: quella d'acquisto o, se manca, quella di caricamento. */
const when = sql`coalesce(${extractions.purchasedAt}, ${receiptsRaw.createdAt})`;
const localWhen = sql`(${when} at time zone ${sql.raw(`'${DEFAULT_TIME_ZONE}'`)})`;
const category = sql<string>`coalesce(${extractions.category}, 'altro')`;

const aggregates = {
  total: sql<number>`coalesce(sum(${extractions.total}), 0)`.mapWith(Number),
  nReceipts: sql<number>`count(*)`.mapWith(Number),
};

const periodOf = (g: Granularity) =>
  sql<string>`to_char(${localWhen}, ${sql.raw(g === "year" ? "'YYYY'" : "'YYYY-MM'")})`;

const monthStart = sql<string>`to_char(${localWhen}, 'YYYY-MM-01')`;

/**
 * Statistiche calcolate sulle estrazioni correnti degli scontrini `extracted`.
 * Ogni metodo filtra per `userId`, tranne `listUserIds` (solo per il cron).
 */
export function createStatsRepo(db: Db) {
  /** Scontrini estratti con la loro estrazione corrente, sempre dell'utente. */
  const base = (userId: string, range: StatsRange = {}) => {
    const conds: SQL[] = [eq(receiptsRaw.userId, userId), eq(receiptsRaw.status, "extracted")];
    if (range.from) conds.push(gte(when, timestamptz(range.from)));
    if (range.to) conds.push(lt(when, timestamptz(range.to)));
    return {
      join: and(
        eq(extractions.receiptId, receiptsRaw.id),
        eq(extractions.userId, userId),
        eq(extractions.isCurrent, true),
      ),
      where: and(...conds),
    };
  };

  return {
    async summary(userId: string, range: StatsRange, granularity: Granularity) {
      const { join, where } = base(userId, range);
      const from = () => db.select(aggregates).from(receiptsRaw).innerJoin(extractions, join);

      const [totals] = await from().where(where);
      const byCategory = await db
        .select({ category, ...aggregates })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(where)
        .groupBy(category)
        .orderBy(desc(aggregates.total), asc(category));
      const period = periodOf(granularity);
      const byPeriod = await db
        .select({ period, ...aggregates })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(where)
        .groupBy(period)
        .orderBy(asc(period));
      // Totali per variante di nome, insegna e P.IVA: l'unione e la classifica le fa il service.
      const merchants = await db
        .select({
          name: extractions.merchantName,
          brand: extractions.merchantBrand,
          vat: extractions.merchantVat,
          ...aggregates,
        })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(and(where, isNotNull(extractions.merchantName)))
        .groupBy(extractions.merchantName, extractions.merchantBrand, extractions.merchantVat);
      const bySource = await db
        .select({ source: receiptsRaw.source, ...aggregates })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(where)
        .groupBy(receiptsRaw.source)
        .orderBy(asc(receiptsRaw.source));
      return {
        totals: totals ?? { total: 0, nReceipts: 0 },
        byCategory,
        byPeriod,
        merchants,
        bySource,
      };
    },

    /**
     * Tutte le varianti di nome, insegna e P.IVA dell'utente, senza intervallo: i nomi
     * armonizzati non devono cambiare con il periodo richiesto.
     */
    async merchantVariants(userId: string) {
      const { join, where } = base(userId);
      return db
        .selectDistinct({
          name: extractions.merchantName,
          brand: extractions.merchantBrand,
          vat: extractions.merchantVat,
        })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(where);
    },

    /**
     * Scontrini e righe del periodo, una riga per scontrino e una per prodotto, dal più
     * recente. `limit` vale per ciascuno dei due elenchi: chi riceve `limit` righe sa che
     * l'elenco è troncato.
     */
    async dataset(userId: string, range: StatsRange, limit: number) {
      const { join, where } = base(userId, range);
      const receipts = await db
        .select({
          id: receiptsRaw.id,
          // Copia di `when`: `mapWith` modifica l'espressione su cui è chiamato.
          date: sql<Date>`${when}`.mapWith((v: string | Date) => new Date(v)),
          merchantName: extractions.merchantName,
          merchantBrand: extractions.merchantBrand,
          merchantVat: extractions.merchantVat,
          total: extractions.total,
          category: extractions.category,
          source: receiptsRaw.source,
        })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(where)
        .orderBy(desc(when), asc(receiptsRaw.id))
        .limit(limit);
      const items = await db
        .select({
          receiptId: receiptsRaw.id,
          description: receiptItems.description,
          quantity: receiptItems.quantity,
          unitPrice: receiptItems.unitPrice,
          amount: receiptItems.amount,
          category: sql<string | null>`coalesce(${receiptItems.category}, ${extractions.category})`,
          normalizedName: receiptItems.normalizedName,
          brand: receiptItems.brand,
          size: receiptItems.size,
          sizeUnit: receiptItems.sizeUnit,
        })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .innerJoin(
          receiptItems,
          and(eq(receiptItems.extractionId, extractions.id), eq(receiptItems.userId, userId)),
        )
        .where(where)
        .orderBy(desc(when), asc(receiptsRaw.id), asc(receiptItems.position))
        .limit(limit);
      return { receipts, items };
    },

    /**
     * Riscrive `stats_monthly` dell'utente dalle estrazioni correnti, in una transazione.
     * Il lock consultivo serializza i ricalcoli concorrenti dello stesso utente (evento e cron).
     */
    async recompute(userId: string): Promise<number> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stats:${userId}`}))`);
        const { join, where } = base(userId);
        const rows = await tx
          .select({ month: monthStart, category, ...aggregates })
          .from(receiptsRaw)
          .innerJoin(extractions, join)
          .where(where)
          .groupBy(monthStart, category);
        await tx.delete(statsMonthly).where(eq(statsMonthly.userId, userId));
        if (rows.length > 0) {
          await tx.insert(statsMonthly).values(
            rows.map((r) => ({
              userId,
              month: r.month,
              category: r.category,
              total: r.total,
              nReceipts: r.nReceipts,
            })),
          );
        }
        return rows.length;
      });
    },

    async listMonthly(userId: string) {
      return db
        .select({
          month: statsMonthly.month,
          category: statsMonthly.category,
          total: statsMonthly.total,
          nReceipts: statsMonthly.nReceipts,
        })
        .from(statsMonthly)
        .where(eq(statsMonthly.userId, userId))
        .orderBy(asc(statsMonthly.month), asc(statsMonthly.category));
    },

    /** Utenti con scontrini o statistiche da ricalcolare. Unico metodo senza `userId`: serve al cron. */
    async listUserIds(): Promise<string[]> {
      const rows = await db
        .select({ userId: receiptsRaw.userId })
        .from(receiptsRaw)
        .union(db.select({ userId: statsMonthly.userId }).from(statsMonthly));
      return rows.map((r) => r.userId);
    },
  };
}

export type StatsRepo = ReturnType<typeof createStatsRepo>;
