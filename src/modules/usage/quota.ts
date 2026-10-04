import type { Clock } from "../../ports/clock.port.js";
import { startOfMonth } from "../../shared/dates.js";
import type { UsageRepo } from "./usage.repo.js";

/** Quota mensile della piattaforma (dal primo del mese in Europe/Rome), come la conta l'AI router. */
export async function platformQuota(usage: UsageRepo, clock: Clock, userId: string, limit: number) {
  const used = await usage.countPlatformCallsSince(userId, startOfMonth(clock.now()));
  return { used, limit };
}
