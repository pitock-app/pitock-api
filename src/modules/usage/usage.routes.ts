import { createRoute } from "@hono/zod-openapi";
import { commonErrors, jsonResponse, security } from "../../shared/openapi.js";
import { createRouter } from "../../shared/router.js";
import { UsageCallsQuery, UsageCallsResponse, UsageQuery, UsageSummary } from "./usage.schemas.js";

const tags = ["usage"];

const summary = createRoute({
  method: "get",
  path: "/v1/usage",
  tags,
  security,
  summary: "Consumo LLM: totali, serie per giorno o per modello, dettaglio per modello",
  request: { query: UsageQuery },
  responses: { 200: jsonResponse(UsageSummary, "Consumo nel periodo"), ...commonErrors },
});

const calls = createRoute({
  method: "get",
  path: "/v1/usage/calls",
  tags,
  security,
  summary: "Ultime chiamate LLM con il nome dell'esercente collegato",
  request: { query: UsageCallsQuery },
  responses: { 200: jsonResponse(UsageCallsResponse, "Pagina di chiamate"), ...commonErrors },
});

export const usageRoutes = () =>
  createRouter()
    .openapi(summary, async (c) => {
      const res = await c.get("container").usage.summary(c.get("userId"), c.req.valid("query"));
      return c.json(res, 200);
    })
    .openapi(calls, async (c) => {
      const res = await c.get("container").usage.calls(c.get("userId"), c.req.valid("query"));
      return c.json(res, 200);
    });
