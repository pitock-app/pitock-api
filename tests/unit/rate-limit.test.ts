import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimitRule } from "../../src/app.js";
import { onError } from "../../src/middleware/error-handler.js";
import { createLogger } from "../../src/middleware/logger.js";
import { rateLimit } from "../../src/middleware/rate-limit.js";
import type { AppEnv } from "../../src/types.js";

function setup(limit: number) {
  let t = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    c.set("logger", createLogger("silent"));
    c.set("userId", c.req.header("x-user") ?? "u1");
    await next();
  });
  app.use("*", rateLimit({ rule: () => ({ bucket: "b", limit }), now: () => t }));
  app.get("*", (c) => c.text("ok"));
  app.onError(onError);
  return { app, advance: (ms: number) => (t += ms) };
}

describe("rate limit in memoria", () => {
  it("blocca oltre il limite per utente con 429 e Retry-After, poi si azzera", async () => {
    const { app, advance } = setup(2);
    expect((await app.request("/a")).status).toBe(200);
    expect((await app.request("/a")).status).toBe(200);
    const blocked = await app.request("/a");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    // Un altro utente non è toccato.
    expect((await app.request("/a", { headers: { "x-user": "u2" } })).status).toBe(200);
    advance(60_000);
    expect((await app.request("/a")).status).toBe(200);
  });

  it("60/min su /v1/settings/ai* e 120/min sul resto", () => {
    expect(rateLimitRule("/v1/settings/ai")).toEqual({ bucket: "settings", limit: 60 });
    expect(rateLimitRule("/v1/settings/ai/keys/openai")).toEqual({ bucket: "settings", limit: 60 });
    expect(rateLimitRule("/v1/settings/aix")).toEqual({ bucket: "default", limit: 120 });
    expect(rateLimitRule("/v1/receipts")).toEqual({ bucket: "default", limit: 120 });
  });
});
