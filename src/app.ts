import { createRoute, z } from "@hono/zod-openapi";
import { secureHeaders } from "hono/secure-headers";
import type { Inngest } from "inngest";
import { serve } from "inngest/hono";
import type { Logger } from "pino";
import type { Env } from "./config/env.js";
import { createContainer, type Container } from "./container.js";
import { createInngest, inngestServable } from "./infra/queue/inngest.client.js";
import { createInngestFunctions } from "./infra/queue/inngest.functions.js";
import { requireAuth } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { onError, onNotFound } from "./middleware/error-handler.js";
import { createLogger, requestLogger } from "./middleware/logger.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requestId } from "./middleware/request-id.js";
import { accountRoutes } from "./modules/account/account.routes.js";
import { receiptsRoutes } from "./modules/receipts/receipts.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { statsCronRoutes, statsRoutes } from "./modules/stats/stats.routes.js";
import { usageRoutes } from "./modules/usage/usage.routes.js";
import { AppError } from "./shared/errors.js";
import { createRouter } from "./shared/router.js";

const HealthResponse = z
  .object({
    ok: z.literal(true),
    version: z.string().openapi({ example: "0.1.0" }),
  })
  .openapi("Health");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "Stato del servizio",
  responses: {
    200: {
      description: "Il servizio è attivo",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

/** Limiti per utente al minuto (sezione 8). */
export const RATE_LIMITS = { settings: 60, default: 120 } as const;

export const rateLimitRule = (path: string) =>
  /^\/v1\/settings\/ai(\/|$)/.test(path)
    ? { bucket: "settings", limit: RATE_LIMITS.settings }
    : { bucket: "default", limit: RATE_LIMITS.default };

export interface AppOptions {
  container?: Container;
  inngest?: Inngest;
  logger?: Logger;
}

export function createApp(env: Env, opts: AppOptions = {}) {
  const logger = opts.logger ?? createLogger(env.NODE_ENV === "test" ? "silent" : "info");
  const inngest = opts.inngest ?? createInngest(env, logger);
  const container = opts.container ?? createContainer(env, inngest);
  const app = createRouter();

  app.use("*", requestId());
  app.use("*", requestLogger(logger));
  app.use("*", secureHeaders());
  app.use("*", cors(env));
  app.use("*", async (c, next) => {
    c.set("container", container);
    await next();
  });

  app.use("/v1/*", requireAuth());
  app.use("/v1/*", rateLimit({ rule: rateLimitRule }));

  app.onError(onError);
  app.notFound(onNotFound);

  // Handler Inngest: fuori da /v1, autenticato dalla firma di Inngest (INNGEST_SIGNING_KEY).
  const inngestHandler = serve({
    client: inngest,
    functions: createInngestFunctions(inngest, container),
  });
  app.on(["GET", "POST", "PUT"], "/api/inngest", (c) => {
    if (!inngestServable(env)) {
      throw new AppError("SERVICE_UNAVAILABLE", "Inngest non configurato");
    }
    return inngestHandler(c);
  });

  app.openapi(healthRoute, (c) => c.json({ ok: true as const, version: env.APP_VERSION }, 200));
  app.route("/", accountRoutes());
  app.route("/", receiptsRoutes());
  app.route("/", settingsRoutes());
  app.route("/", usageRoutes());
  app.route("/", statsRoutes());
  app.route("/", statsCronRoutes(env.CRON_SECRET));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "access_token di Supabase Auth",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Pitock API", version: env.APP_VERSION },
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
