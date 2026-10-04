import { and, asc, desc, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import { extractions, receiptsRaw, statsMonthly } from "../../infra/db/schema/index.js";
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
    if (range.from) conds.push(gte(when, range.from));
    if (range.to) conds.push(lt(when, range.to));
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
    async summary(userId: string, range: StatsRange, granularity: Granularity, topN: number) {
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
      const topMerchants = await db
        .select({ merchantName: sql<string>`${extractions.merchantName}`, ...aggregates })
        .from(receiptsRaw)
        .innerJoin(extractions, join)
        .where(and(where, isNotNull(extractions.merchantName)))
        .groupBy(extractions.merchantName)
        .orderBy(desc(aggregates.total), asc(extractions.merchantName))
        .limit(topN);
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
        topMerchants,
        bySource,
      };
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
