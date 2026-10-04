import { and, asc, count, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import { extractions, llmUsage, modelPrices } from "../../infra/db/schema/index.js";
import { DEFAULT_TIME_ZONE } from "../../shared/dates.js";
import type { Cursor } from "../../shared/pagination.js";
import type { ModelPrice } from "./pricing.js";

export type NewLlmUsage = Omit<typeof llmUsage.$inferInsert, "id" | "userId">;

export interface UsageRange {
  from: Date;
  /** Esclusivo. */
  to: Date;
}

/**
 * Costo della chiamata: `cost_usd` salvato oppure, se manca, calcolato con i prezzi correnti di
 * `model_prices` (null se manca anche il prezzo o il conteggio dei token).
 */
const cost = sql<
  number | null
>`coalesce(${llmUsage.costUsd}, (${llmUsage.inputTokens}::numeric * ${modelPrices.inputPerMtokUsd} + ${llmUsage.outputTokens}::numeric * ${modelPrices.outputPerMtokUsd}) / 1000000)`;

const aggregates = {
  calls: sql<number>`count(*)`.mapWith(Number),
  inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)`.mapWith(Number),
  outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)`.mapWith(Number),
  costUsd: sql<number>`round(coalesce(sum(${cost}), 0), 6)`.mapWith(Number),
  unpricedCalls: sql<number>`count(*) filter (where ${cost} is null)`.mapWith(Number),
};

const priced = and(
  eq(modelPrices.provider, llmUsage.provider),
  eq(modelPrices.model, llmUsage.model),
);

const day = sql<string>`to_char(${llmUsage.createdAt} at time zone ${sql.raw(`'${DEFAULT_TIME_ZONE}'`)}, 'YYYY-MM-DD')`;

/** Unico accesso a `llm_usage` (sempre filtrata per `userId`) e a `model_prices` (globale). */
export function createUsageRepo(db: Db) {
  return {
    /**
     * Quota della piattaforma: chiamate di estrazione con la chiave della piattaforma da `since`,
     * anche fallite. Si conta su `llm_usage`, che resta anche se lo scontrino viene cancellato.
     */
    async countPlatformCallsSince(userId: string, since: Date): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(llmUsage)
        .where(
          and(
            eq(llmUsage.userId, userId),
            eq(llmUsage.keySource, "platform"),
            inArray(llmUsage.operation, ["extract", "reextract"]),
            gte(llmUsage.createdAt, since),
          ),
        );
      return row?.n ?? 0;
    },

    /** Prezzo per milione di token; `undefined` se il modello non è in `model_prices`. */
    async findPrice(provider: string, model: string): Promise<ModelPrice | undefined> {
      const [row] = await db
        .select({
          inputPerMtokUsd: modelPrices.inputPerMtokUsd,
          outputPerMtokUsd: modelPrices.outputPerMtokUsd,
        })
        .from(modelPrices)
        .where(and(eq(modelPrices.provider, provider), eq(modelPrices.model, model)));
      return row;
    },

    async insertMany(userId: string, rows: NewLlmUsage[]): Promise<void> {
      if (rows.length === 0) return;
      await db.insert(llmUsage).values(rows.map((r) => ({ ...r, userId })));
    },

    /** Ultima chiamata riuscita che ha prodotto l'estrazione. */
    async findForExtraction(userId: string, extractionId: string) {
      const [row] = await db
        .select({
          provider: llmUsage.provider,
          model: llmUsage.model,
          totalTokens: llmUsage.totalTokens,
          costUsd: llmUsage.costUsd,
        })
        .from(llmUsage)
        .where(
          and(
            eq(llmUsage.userId, userId),
            eq(llmUsage.extractionId, extractionId),
            eq(llmUsage.success, true),
          ),
        )
        .orderBy(desc(llmUsage.createdAt))
        .limit(1);
      return row;
    },

    /** Totali, serie per giorno (Europe/Rome) e per modello delle chiamate nell'intervallo. */
    async summary(userId: string, range: UsageRange) {
      const where = and(
        eq(llmUsage.userId, userId),
        gte(llmUsage.createdAt, range.from),
        lt(llmUsage.createdAt, range.to),
      );
      const [totals] = await db
        .select(aggregates)
        .from(llmUsage)
        .leftJoin(modelPrices, priced)
        .where(where);
      const byDay = await db
        .select({ day, ...aggregates })
        .from(llmUsage)
        .leftJoin(modelPrices, priced)
        .where(where)
        .groupBy(day)
        .orderBy(asc(day));
      const byModel = await db
        .select({ provider: llmUsage.provider, model: llmUsage.model, ...aggregates })
        .from(llmUsage)
        .leftJoin(modelPrices, priced)
        .where(where)
        .groupBy(llmUsage.provider, llmUsage.model)
        .orderBy(asc(llmUsage.provider), asc(llmUsage.model));
      return { totals, byDay, byModel };
    },

    /** Ultime chiamate con il nome dell'esercente dell'estrazione corrente dello scontrino. */
    async listCalls(userId: string, cursor: Cursor | null, limit: number) {
      const conds: SQL[] = [eq(llmUsage.userId, userId)];
      if (cursor) {
        conds.push(
          sql`(${llmUsage.createdAt}, ${llmUsage.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      return db
        .select({
          id: llmUsage.id,
          createdAt: llmUsage.createdAt,
          operation: llmUsage.operation,
          provider: llmUsage.provider,
          model: llmUsage.model,
          keySource: llmUsage.keySource,
          inputTokens: llmUsage.inputTokens,
          outputTokens: llmUsage.outputTokens,
          totalTokens: llmUsage.totalTokens,
          costUsd: sql<number | null>`${cost}`.mapWith(Number),
          latencyMs: llmUsage.latencyMs,
          success: llmUsage.success,
          errorCode: llmUsage.errorCode,
          receiptId: llmUsage.receiptId,
          merchantName: extractions.merchantName,
        })
        .from(llmUsage)
        .leftJoin(modelPrices, priced)
        .leftJoin(
          extractions,
          and(
            eq(extractions.receiptId, llmUsage.receiptId),
            eq(extractions.userId, userId),
            eq(extractions.isCurrent, true),
          ),
        )
        .where(and(...conds))
        .orderBy(desc(llmUsage.createdAt), desc(llmUsage.id))
        .limit(limit + 1);
    },
  };
}

export type UsageRepo = ReturnType<typeof createUsageRepo>;
