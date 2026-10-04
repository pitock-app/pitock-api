import { z } from "zod";
import type { StatsService } from "../modules/stats/stats.service.js";

/** Payload di `stats/recompute`: arriva da Inngest, quindi passa da Zod. */
export const StatsRecomputeEvent = z.object({ userId: z.uuid() });

export type RecomputeOutcome = { status: "recomputed"; rows: number } | { status: "skipped" };

export function recomputeStatsJob(stats: StatsService) {
  return async (data: unknown): Promise<RecomputeOutcome> => {
    const parsed = StatsRecomputeEvent.safeParse(data);
    if (!parsed.success) return { status: "skipped" };
    return { status: "recomputed", rows: await stats.recompute(parsed.data.userId) };
  };
}
