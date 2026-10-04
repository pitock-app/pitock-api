import { and, desc, eq, gte, ilike, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import { extractions, receiptsRaw } from "../../infra/db/schema/index.js";
import { timestamptz } from "../../infra/db/timestamptz.js";
import type { Cursor } from "../../shared/pagination.js";

export type ReceiptRow = typeof receiptsRaw.$inferSelect;
export type NewFileReceipt = Omit<typeof receiptsRaw.$inferInsert, "userId" | "createdAt">;

export interface ReceiptListFilters {
  from?: Date;
  to?: { at: Date; exclusive: boolean };
  status?: ReceiptRow["status"];
  source?: ReceiptRow["source"];
  category?: string;
  q?: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Unico accesso a `receipts_raw`: ogni query filtra per `userId`. */
export function createReceiptsRepo(db: Db) {
  const byOwner = (userId: string, id: string) =>
    and(eq(receiptsRaw.userId, userId), eq(receiptsRaw.id, id));

  return {
    async findById(userId: string, id: string): Promise<ReceiptRow | undefined> {
      const [row] = await db.select().from(receiptsRaw).where(byOwner(userId, id));
      return row;
    },

    async findBySha256(userId: string, sha256: string): Promise<ReceiptRow | undefined> {
      const [row] = await db
        .select()
        .from(receiptsRaw)
        .where(and(eq(receiptsRaw.userId, userId), eq(receiptsRaw.sha256, sha256)));
      return row;
    },

    /** `createdAt` arriva dal Clock con precisione al millisecondo, come i cursori. */
    async insert(userId: string, createdAt: Date, values: NewFileReceipt): Promise<ReceiptRow> {
      const [row] = await db
        .insert(receiptsRaw)
        .values({ ...values, userId, createdAt })
        .returning();
      if (!row) throw new Error("insert receipts_raw senza risultato");
      return row;
    },

    async update(
      userId: string,
      id: string,
      patch: Partial<Pick<ReceiptRow, "status" | "errorCode">>,
      /** Aggiorna solo se lo stato attuale è tra questi (transizione atomica). */
      fromStatuses?: ReceiptRow["status"][],
    ): Promise<ReceiptRow | undefined> {
      const cond = fromStatuses
        ? and(byOwner(userId, id), or(...fromStatuses.map((s) => eq(receiptsRaw.status, s))))
        : byOwner(userId, id);
      const [row] = await db.update(receiptsRaw).set(patch).where(cond).returning();
      return row;
    },

    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(receiptsRaw)
        .where(byOwner(userId, id))
        .returning({ id: receiptsRaw.id });
      return rows.length > 0;
    },

    /** Scontrini con i campi principali dell'estrazione corrente, ordinati per creazione. */
    async list(userId: string, f: ReceiptListFilters, cursor: Cursor | null, limit: number) {
      const when = sql`coalesce(${extractions.purchasedAt}, ${receiptsRaw.createdAt})`;
      const conds: (SQL | undefined)[] = [eq(receiptsRaw.userId, userId)];
      if (f.status) conds.push(eq(receiptsRaw.status, f.status));
      if (f.source) conds.push(eq(receiptsRaw.source, f.source));
      if (f.category) conds.push(eq(extractions.category, f.category));
      if (f.from) conds.push(gte(when, timestamptz(f.from)));
      if (f.to)
        conds.push(
          f.to.exclusive ? lt(when, timestamptz(f.to.at)) : lte(when, timestamptz(f.to.at)),
        );
      if (f.q) {
        const pattern = `%${escapeLike(f.q)}%`;
        conds.push(
          or(
            ilike(extractions.merchantName, pattern),
            ilike(receiptsRaw.originalFilename, pattern),
          ),
        );
      }
      if (cursor) {
        conds.push(
          sql`(${receiptsRaw.createdAt}, ${receiptsRaw.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      return db
        .select({
          id: receiptsRaw.id,
          source: receiptsRaw.source,
          status: receiptsRaw.status,
          createdAt: receiptsRaw.createdAt,
          merchantName: extractions.merchantName,
          purchasedAt: extractions.purchasedAt,
          total: extractions.total,
          currency: extractions.currency,
          category: extractions.category,
        })
        .from(receiptsRaw)
        .leftJoin(
          extractions,
          and(
            eq(extractions.receiptId, receiptsRaw.id),
            eq(extractions.userId, receiptsRaw.userId),
            eq(extractions.isCurrent, true),
          ),
        )
        .where(and(...conds))
        .orderBy(desc(receiptsRaw.createdAt), desc(receiptsRaw.id))
        .limit(limit + 1);
    },
  };
}

export type ReceiptsRepo = ReturnType<typeof createReceiptsRepo>;
