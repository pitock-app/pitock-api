import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "../../src/ports/llm.port.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { detail, runJobs, uploaded, usageRows, type Detail } from "../helpers/extraction.js";
import { usage, validOutput } from "../helpers/fakes.js";
import { seedAiSettings } from "../helpers/seed.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(() => h.close());
beforeEach(() => {
  h.queue.clear();
  h.llm.reset();
});

describe("AI router: BYOK", () => {
  const userKey = "sk-user-openai-key-1234567890";

  it("usa la chiave decifrata e il modello dell'utente", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, {
      mode: "byok",
      provider: "openai",
      model: "user-model",
      apiKey: userKey,
    });
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    expect(h.llm.requests[0]).toMatchObject({
      provider: "openai",
      model: "user-model",
      apiKey: userKey,
    });
    expect((await detail(h, user, receiptId)).extraction).toMatchObject({ keySource: "user" });
    // Le estrazioni con la chiave dell'utente non consumano la quota della piattaforma.
    const me = await json<{ platformQuota: { used: number } }>(await h.call(user, "GET", "/v1/me"));
    expect(me.platformQuota.used).toBe(0);
  });

  it("chiave non valida senza fallback → failed con USER_KEY_INVALID", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, {
      mode: "byok",
      provider: "openai",
      model: "user-model",
      apiKey: userKey,
    });
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(new LlmError("auth", "401"));
    await runJobs(h);
    expect(h.llm.requests).toHaveLength(1);
    expect((await detail(h, user, receiptId)).receipt).toMatchObject({
      status: "failed",
      errorCode: "USER_KEY_INVALID",
    });
    expect((await usageRows(h, receiptId))[0]).toMatchObject({
      key_source: "user",
      success: false,
      error_code: "USER_KEY_INVALID",
    });
  });

  it("quota della chiave esaurita senza fallback → failed con USER_KEY_QUOTA", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, {
      mode: "byok",
      provider: "openai",
      model: "user-model",
      apiKey: userKey,
    });
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(new LlmError("quota", "429"));
    await runJobs(h);
    expect((await detail(h, user, receiptId)).receipt.errorCode).toBe("USER_KEY_QUOTA");
  });

  it("chiave non valida con fallback → riprova sulla piattaforma e registra entrambe le chiamate", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, {
      mode: "byok",
      provider: "openai",
      model: "user-model",
      apiKey: userKey,
      fallbackToPlatform: true,
    });
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(new LlmError("auth", "401"), { output: validOutput(), usage: usage() });
    await runJobs(h);
    expect(h.llm.requests.map((r) => [r.provider, r.apiKey])).toEqual([
      ["openai", userKey],
      ["anthropic", "test-platform-key"],
    ]);
    expect((await detail(h, user, receiptId)).extraction).toMatchObject({
      keySource: "platform",
      model: "fake-model",
    });
    const rows = await usageRows(h, receiptId);
    expect(rows.map((r) => [r.key_source, r.success])).toEqual([
      ["user", false],
      ["platform", true],
    ]);
  });

  it("BYOK senza chiave salvata → failed con USER_KEY_MISSING, senza chiamate", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, { mode: "byok", provider: "openai", model: "m" });
    const { receiptId } = await uploaded(h, user);
    await runJobs(h);
    expect(h.llm.requests).toHaveLength(0);
    expect((await detail(h, user, receiptId)).receipt.errorCode).toBe("USER_KEY_MISSING");
  });
});

describe("AI router: quota della piattaforma", () => {
  const used = async (app: TestApp, userId: string) =>
    (await json<{ platformQuota: { used: number } }>(await app.call(userId, "GET", "/v1/me")))
      .platformQuota.used;

  it("cancellare gli scontrini non restituisce quota", async () => {
    const q = await createTestApp({ PLATFORM_MONTHLY_RECEIPT_LIMIT: "1" });
    try {
      const user = await q.t.createUser();
      const first = await uploaded(q, user, "jpeg");
      q.llm.respond({ output: validOutput(), usage: usage() });
      await runJobs(q);
      expect((await q.call(user, "DELETE", `/v1/receipts/${first.receiptId}`)).status).toBe(204);
      expect(await used(q, user)).toBe(1);

      await uploaded(q, user, "jpeg");
      expect(await runJobs(q)).toEqual([
        { status: "failed", errorCode: "PLATFORM_QUOTA_EXCEEDED" },
      ]);
      expect(q.llm.requests).toHaveLength(1);
    } finally {
      await q.close();
    }
  });

  it("anche le chiamate fallite consumano quota", async () => {
    const user = await h.t.createUser();
    await uploaded(h, user);
    h.llm.respond(
      { output: { is_receipt: "forse" }, usage: usage() },
      { output: validOutput({ is_receipt: false }), usage: usage() },
    );
    expect(await runJobs(h)).toEqual([{ status: "failed", errorCode: "NOT_A_RECEIPT" }]);
    expect(await used(h, user)).toBe(2);
  });

  it("quota superata → failed con PLATFORM_QUOTA_EXCEEDED, senza chiamate al modello", async () => {
    const q = await createTestApp({ PLATFORM_MONTHLY_RECEIPT_LIMIT: "1" });
    try {
      const user = await q.t.createUser();
      const first = await uploaded(q, user, "jpeg");
      q.llm.respond({ output: validOutput(), usage: usage() });
      expect((await runJobs(q))[0]?.status).toBe("extracted");

      const second = await uploaded(q, user, "jpeg");
      expect(await runJobs(q)).toEqual([
        { status: "failed", errorCode: "PLATFORM_QUOTA_EXCEEDED" },
      ]);
      expect(q.llm.requests).toHaveLength(1);
      const d = await json<Detail>(await q.call(user, "GET", `/v1/receipts/${second.receiptId}`));
      expect(d.receipt).toMatchObject({ status: "failed", errorCode: "PLATFORM_QUOTA_EXCEEDED" });
      expect(first.receiptId).not.toBe(second.receiptId);
    } finally {
      await q.close();
    }
  });

  it("il fallback sulla piattaforma rispetta la quota", async () => {
    const q = await createTestApp({ PLATFORM_MONTHLY_RECEIPT_LIMIT: "0" });
    try {
      const user = await q.t.createUser();
      await seedAiSettings(q.t.db, q.env, user, {
        mode: "byok",
        provider: "openai",
        model: "user-model",
        apiKey: "sk-user-openai-key-1234567890",
        fallbackToPlatform: true,
      });
      await uploaded(q, user, "jpeg");
      q.llm.respond(new LlmError("quota", "429"));
      expect(await runJobs(q)).toEqual([
        { status: "failed", errorCode: "PLATFORM_QUOTA_EXCEEDED" },
      ]);
      expect(q.llm.requests).toHaveLength(1);
    } finally {
      await q.close();
    }
  });
});

describe("reextract", () => {
  it("crea una nuova estrazione corrente e lascia la vecchia nello storico", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    const before = await detail(h, user, receiptId);

    const res = await h.call(user, "POST", `/v1/receipts/${receiptId}/reextract`, {
      model: "modello-costoso",
    });
    expect(res.status).toBe(202);
    h.llm.respond({ output: validOutput({ merchant_name: "Rossi SRL" }), usage: usage() });
    await runJobs(h);

    // Con la chiave della piattaforma il modello resta DEFAULT_MODEL.
    expect(h.llm.requests[1]?.model).toBe("fake-model");
    const after = await detail(h, user, receiptId);
    expect(after.receipt.status).toBe("extracted");
    expect(after.extraction?.merchantName).toBe("Rossi SRL");
    expect(after.extraction?.id).not.toBe(before.extraction?.id);

    const history = await json<{ items: { id: string; isCurrent: boolean }[] }>(
      await h.call(user, "GET", `/v1/receipts/${receiptId}/extractions`),
    );
    expect(history.items.map((e) => [e.id, e.isCurrent])).toEqual([
      [after.extraction?.id, true],
      [before.extraction?.id, false],
    ]);
    const ops = (await usageRows(h, receiptId)).map((r) => r.operation).sort();
    expect(ops).toEqual(["extract", "reextract"]);
  });

  it("con provider e modello di una chiave dell'utente usa quella chiave", async () => {
    const user = await h.t.createUser();
    await seedAiSettings(h.t.db, h.env, user, {
      mode: "platform",
      provider: "openrouter",
      apiKey: "sk-or-user-key-1234567890",
    });
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    await h.call(user, "POST", `/v1/receipts/${receiptId}/reextract`, {
      provider: "openrouter",
      model: "vendor/vision-model",
    });
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    expect(h.llm.requests[1]).toMatchObject({
      provider: "openrouter",
      model: "vendor/vision-model",
      apiKey: "sk-or-user-key-1234567890",
    });
    expect((await detail(h, user, receiptId)).extraction?.keySource).toBe("user");
  });

  it("dopo un fallimento la rielaborazione può riuscire", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(new LlmError("unavailable", "500"));
    expect(await runJobs(h)).toEqual([{ status: "failed", errorCode: "LLM_UNAVAILABLE" }]);
    expect((await h.call(user, "POST", `/v1/receipts/${receiptId}/reextract`, {})).status).toBe(
      202,
    );
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    expect((await detail(h, user, receiptId)).receipt).toMatchObject({
      status: "extracted",
      errorCode: null,
    });
  });
});
