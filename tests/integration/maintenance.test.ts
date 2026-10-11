import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { uploaded } from "../helpers/extraction.js";

describe("pulizie del cron", () => {
  let h: TestApp;
  let user: string;
  beforeAll(async () => {
    h = await createTestApp();
    user = await h.t.createUser();
  });
  afterAll(() => h.close());

  const statusOf = async (id: string) =>
    (
      await h.t.query<{ status: string; error_code: string | null }>(
        `select status, error_code from receipts_raw where id = '${id}'`,
      )
    )[0];

  it("segna failed gli scontrini bloccati e cancella gli upload mai completati", async () => {
    // Bloccato in processing da 20 minuti, e uno appena partito.
    const stuck = (await uploaded(h, user)).receiptId;
    const running = (await uploaded(h, user)).receiptId;
    await h.t.exec(`
      update receipts_raw set status = 'processing', updated_at = '2026-10-04 09:40:00+00' where id = '${stuck}';
      update receipts_raw set status = 'processing', updated_at = '2026-10-04 09:58:00+00' where id = '${running}';
    `);

    // Upload richiesto 2 ore fa e mai completato (con il file arrivato su Storage), e uno recente.
    const orphan = await h.call(user, "POST", "/v1/receipts/upload-url", {
      source: "file",
      sha256: "a".repeat(64),
      mimeType: "image/jpeg",
      sizeBytes: 100,
    });
    const { receiptId: orphanId, path } = await json<{ receiptId: string; path: string }>(orphan);
    h.storage.put(path, new Uint8Array(100), "image/jpeg");
    const recent = await h.call(user, "POST", "/v1/receipts/upload-url", {
      source: "file",
      sha256: "b".repeat(64),
      mimeType: "image/jpeg",
      sizeBytes: 100,
    });
    const { receiptId: recentId } = await json<{ receiptId: string }>(recent);
    await h.t.exec(
      `update receipts_raw set created_at = '2026-10-04 08:00:00+00' where id = '${orphanId}';
       update receipts_raw set created_at = '2026-10-04 09:30:00+00' where id = '${recentId}';`,
    );

    h.clock.set("2026-10-04T10:00:00.000Z");
    const res = await h.container.maintenance.cleanup();
    expect(res).toMatchObject({ failedProcessing: 1, deletedUploads: 1 });
    expect(await statusOf(stuck)).toEqual({ status: "failed", error_code: "TIMEOUT" });
    expect((await statusOf(running))?.status).toBe("processing");
    expect(await statusOf(orphanId)).toBeUndefined();
    expect(h.storage.objects.has(path)).toBe(false);
    expect((await statusOf(recentId))?.status).toBe("pending_upload");

    // Idempotente.
    expect(await h.container.maintenance.cleanup()).toMatchObject({
      failedProcessing: 0,
      deletedUploads: 0,
    });
  });

  it("cancella i contatori del rate limit scaduti da più di un'ora", async () => {
    await h.t.exec(`
      insert into rate_limits (key, count, reset_at) values
        ('default:old', 3, '2026-10-04 08:00:00+00'),
        ('default:new', 3, '2026-10-04 09:59:00+00');
    `);
    h.clock.set("2026-10-04T10:00:00.000Z");
    await h.container.maintenance.cleanup();
    const keys = await h.t.query<{ key: string }>(
      `select key from rate_limits where key in ('default:old', 'default:new') order by key`,
    );
    expect(keys.map((k) => k.key)).toEqual(["default:new"]);
  });
});
