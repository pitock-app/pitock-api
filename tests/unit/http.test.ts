import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { parseEnv } from "../../src/config/env.js";
import { isAllowedOrigin } from "../../src/middleware/cors.js";
import { testEnv } from "../helpers/test-env.js";

describe("CORS", () => {
  const env = testEnv({ ALLOWED_ORIGINS: "http://localhost:3000,https://pitock.app" });
  const app = createApp(env);
  const preflight = (origin: string) =>
    app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });

  it.each([
    ["http://localhost:3000", true],
    ["https://pitock.app", true],
    ["https://pitock-web-git-feat-x.vercel.app", true],
    ["https://evil.example", false],
    ["https://pitock-web-x.vercel.app.evil.example", false],
    ["http://pitock-web-x.vercel.app", false],
  ])("%s ammessa: %s", async (origin, allowed) => {
    expect(isAllowedOrigin(env, origin)).toBe(allowed);
    const res = await preflight(origin);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(allowed ? origin : null);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("header e request id", () => {
  const app = createApp(testEnv());

  it("applica i secure headers", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("riusa un X-Request-Id valido e rigenera quelli non validi", async () => {
    const ok = await app.request("/health", { headers: { "X-Request-Id": "abc12345-req" } });
    expect(ok.headers.get("X-Request-Id")).toBe("abc12345-req");
    const bad = await app.request("/health", { headers: { "X-Request-Id": "<script>" } });
    expect(bad.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("404 nel formato comune", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBeTruthy();
  });
});

describe("avvio senza servizi configurati", () => {
  const app = createApp(parseEnv({ NODE_ENV: "test" }));

  it("/health risponde, le rotte /v1 rispondono 503", async () => {
    expect((await app.request("/health")).status).toBe(200);
    const res = await app.request("/v1/me", { headers: { Authorization: "Bearer x.y.z" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
