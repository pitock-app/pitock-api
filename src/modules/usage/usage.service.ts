import type { Clock } from "../../ports/clock.port.js";
import { parseIsoInTimeZone, parseRangeEnd, startOfMonth } from "../../shared/dates.js";
import { AppError } from "../../shared/errors.js";
import { decodeCursor, toPage } from "../../shared/pagination.js";
import type { UsageRepo } from "./usage.repo.js";
import type { UsageQuery } from "./usage.schemas.js";

export interface UsageDeps {
  usage: UsageRepo;
  clock: Clock;
}

const invalid = () => new AppError("VALIDATION_ERROR", "Intervallo di date non valido");

/** Consumo LLM dell'utente (`/v1/usage*`): tutto viene da `llm_usage`. */
export function createUsageService(d: UsageDeps) {
  return {
    async summary(userId: string, q: UsageQuery) {
      const now = d.clock.now();
      const from = q.from ? parseIsoInTimeZone(q.from) : startOfMonth(now);
      const to = q.to ? parseRangeEnd(q.to) : new Date(now.getTime() + 1);
      if (!from || !to || from >= to) throw invalid();

      const { totals, byDay, byModel } = await d.usage.summary(userId, { from, to });
      const empty = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0 };
      const series =
        q.groupBy === "model"
          ? byModel.map(({ provider, model, ...t }) => ({ key: `${provider}/${model}`, ...t }))
          : byDay.map(({ day, ...t }) => ({ key: day, ...t }));
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        totals: totals ?? empty,
        series,
        byModel,
      };
    },

    async calls(userId: string, q: { cursor?: string | undefined; limit: number }) {
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const page = toPage(await d.usage.listCalls(userId, cursor, q.limit), q.limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      };
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
