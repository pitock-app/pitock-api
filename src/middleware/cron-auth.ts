import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { AppError } from "../shared/errors.js";
import type { AppEnv } from "../types.js";

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Richiede `Authorization: Bearer <CRON_SECRET>` (lo invia Vercel Cron).
 * Confronto a tempo costante sugli hash; senza `CRON_SECRET` risponde 503.
 */
export const requireCronSecret = (secret: string | undefined) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!secret) throw new AppError("SERVICE_UNAVAILABLE", "Cron non configurato");
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(secret))) {
      throw new AppError("UNAUTHORIZED", "Segreto del cron non valido");
    }
    await next();
  });
