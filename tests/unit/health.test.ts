import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { testEnv } from "../helpers/test-env.js";

describe("GET /health", () => {
  const app = createApp(testEnv({ APP_VERSION: "1.2.3" }));

  it("risponde ok con la versione", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("pubblica /openapi.json con /health", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("restituisce 404 su rotte sconosciute", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
