import { createRoute } from "@hono/zod-openapi";
import { commonErrors, jsonResponse, security } from "../../shared/openapi.js";
import { requireCronSecret } from "../../middleware/cron-auth.js";
import { createRouter } from "../../shared/router.js";
import { StatsQuery, StatsResponse } from "./stats.schemas.js";

const stats = createRoute({
  method: "get",
  path: "/v1/stats",
  tags: ["stats"],
  security,
  summary: "Statistiche di spesa: totali, per categoria, per periodo, esercenti e sorgente",
  request: { query: StatsQuery },
  responses: { 200: jsonResponse(StatsResponse, "Statistiche nel periodo"), ...commonErrors },
});

export const statsRoutes = () =>
  createRouter().openapi(stats, async (c) => {
    const res = await c.get("container").stats.summary(c.get("userId"), c.req.valid("query"));
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
