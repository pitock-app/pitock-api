import { createMiddleware } from "hono/factory";
import pino, { type Logger } from "pino";
import { redact } from "../shared/redact.js";
import type { AppEnv } from "../types.js";

export function createLogger(level: string = "info"): Logger {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: ["*.authorization", "*.headers.authorization", "*.apiKey"],
      censor: "[REDACTED]",
    },
    formatters: {
      // Ogni record passa da redact(): chiavi API e token non arrivano mai nei log.
      log: (obj) => redact(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, redact(args) as Parameters<typeof method>);
      },
    },
  });
}

/** Logger figlio con il request id e una riga per richiesta (senza query string né header). */
export const requestLogger = (root: Logger) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const logger = root.child({ requestId: c.get("requestId") });
    c.set("logger", logger);
    const start = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });
