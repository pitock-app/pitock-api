import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgRateLimitStore } from "../../src/infra/db/rate-limit-store.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

describe("rate limit su Postgres", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("conta in modo condiviso tra istanze diverse e riparte a finestra scaduta", async () => {
    // Due store sullo stesso DB: come due istanze Vercel.
    const a = createPgRateLimitStore(t.db);
    const b = createPgRateLimitStore(t.db);
    const now = Date.parse("2026-10-11T10:00:00Z");
    expect((await a.hit("default:u1", 60_000, now)).count).toBe(1);
    expect((await b.hit("default:u1", 60_000, now + 1_000)).count).toBe(2);
    const third = await a.hit("default:u1", 60_000, now + 2_000);
    expect(third.count).toBe(3);
    expect(third.resetAt).toBe(now + 60_000);
    // Altro utente, contatore separato.
    expect((await b.hit("default:u2", 60_000, now)).count).toBe(1);
    // Finestra scaduta: si riparte da 1 con una nuova scadenza.
    const fresh = await b.hit("default:u1", 60_000, now + 60_000);
    expect(fresh).toEqual({ count: 1, resetAt: now + 120_000 });
  });
});
