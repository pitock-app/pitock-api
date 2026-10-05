import { createRoute } from "@hono/zod-openapi";
import { commonErrors, jsonResponse, security } from "../../shared/openapi.js";
import { requireCronSecret } from "../../middleware/cron-auth.js";
import { createRouter } from "../../shared/router.js";
import {
  StatsDatasetQuery,
  StatsDatasetResponse,
  StatsQuery,
  StatsResponse,
} from "./stats.schemas.js";

const stats = createRoute({
  method: "get",
  path: "/v1/stats",
  tags: ["stats"],
  security,
  summary: "Statistiche di spesa: totali, per categoria, per periodo, esercenti e sorgente",
  request: { query: StatsQuery },
  responses: { 200: jsonResponse(StatsResponse, "Statistiche nel periodo"), ...commonErrors },
});

const dataset = createRoute({
  method: "get",
  path: "/v1/stats/dataset",
  tags: ["stats"],
  security,
  summary: "Scontrini e righe prodotto del periodo, per le analisi per prodotto",
  request: { query: StatsDatasetQuery },
  responses: {
    200: jsonResponse(StatsDatasetResponse, "Scontrini e righe del periodo"),
    ...commonErrors,
  },
});

export const statsRoutes = () =>
  createRouter()
    .openapi(stats, async (c) => {
      const res = await c.get("container").stats.summary(c.get("userId"), c.req.valid("query"));
      return c.json(res, 200);
    })
    .openapi(dataset, async (c) => {
      const res = await c.get("container").stats.dataset(c.get("userId"), c.req.valid("query"));
      return c.json(res, 200);
    });

/** `GET /cron/recompute-stats` (Vercel Cron): fuori da `/v1` e dal contratto pubblico. */
export const statsCronRoutes = (cronSecret: string | undefined) =>
  createRouter().get("/cron/recompute-stats", requireCronSecret(cronSecret), async (c) => {
    const res = await c.get("container").stats.recomputeAll();
    if (res.failed > 0)
      c.get("logger").error(res, "recompute-stats: ricalcolo fallito per alcuni utenti");
    return c.json({ ok: res.failed === 0, ...res }, 200);
  });
