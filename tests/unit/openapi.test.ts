import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { CATEGORIES, PAYMENT_METHODS } from "../../src/modules/extraction/extraction.schema.js";
import { testEnv } from "../helpers/test-env.js";

interface Doc {
  paths: Record<string, Record<string, { security?: unknown[] }>>;
  components: { schemas: Record<string, { enum?: string[] }> };
}

describe("contratto OpenAPI", async () => {
  const res = await createApp(testEnv()).request("/openapi.json");
  const doc = (await res.json()) as Doc;

  it("è un documento OpenAPI 3.1 valido", async () => {
    const result = await new Validator().validate(doc as unknown as Record<string, unknown>);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("contiene le rotte di B2 e B4 con i metodi attesi", () => {
    const methods = Object.fromEntries(
      Object.entries(doc.paths).map(([p, ops]) => [p, Object.keys(ops).sort()]),
    );
    expect(methods).toMatchObject({
      "/v1/me": ["get"],
      "/v1/receipts/upload-url": ["post"],
      "/v1/receipts/{id}/complete": ["post"],
      "/v1/receipts/manual": ["post"],
      "/v1/receipts": ["get"],
      "/v1/receipts/{id}": ["delete", "get"],
      "/v1/receipts/{id}/extractions": ["get"],
      "/v1/extractions/{id}": ["patch"],
      "/v1/receipts/{id}/reextract": ["post"],
      "/v1/settings/ai": ["get", "put"],
      "/v1/settings/ai/keys/{provider}": ["delete", "put"],
      "/v1/settings/ai/test": ["post"],
      "/v1/settings/ai/models": ["get"],
      "/v1/usage": ["get"],
      "/v1/usage/calls": ["get"],
    });
  });

  it("ogni rotta /v1 dichiara l'autenticazione bearer", () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!path.startsWith("/v1/")) continue;
      for (const op of Object.values(ops)) expect(op.security).toEqual([{ bearerAuth: [] }]);
    }
  });

  it("espone CATEGORIES e PAYMENT_METHODS come enum", () => {
    expect(doc.components.schemas.Category?.enum).toEqual([...CATEGORIES]);
    expect(doc.components.schemas.PaymentMethod?.enum).toEqual([...PAYMENT_METHODS]);
  });
});
