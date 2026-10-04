import { describe, expect, it } from "vitest";
import { parseIsoInTimeZone, startOfMonth } from "../../src/shared/dates.js";
import { sniffMimeType } from "../../src/shared/files.js";
import { decodeCursor, encodeCursor, toPage } from "../../src/shared/pagination.js";
import { redact, redactString } from "../../src/shared/redact.js";

describe("redact", () => {
  it("maschera i pattern di chiave e i bearer token", () => {
    const s = redactString(
      "a sk-ant-api03-abcdefghij b sk-or-v1-abcdefghijk c sk-proj-abcdefghij Bearer eyJa.eyJb.sig",
    );
    expect(s).not.toMatch(/sk-|eyJ|abcdefghij/);
  });

  it("maschera le chiavi sensibili a qualunque profondità", () => {
    const out = redact({
      headers: { authorization: "Bearer x", Authorization: "y" },
      body: { apiKey: "plain", nested: [{ token: "t" }], note: "ok sk-abcdefghijkl" },
      err: new Error("chiave sk-ant-abcdefghijkl non valida"),
    });
    expect(JSON.stringify(out)).not.toMatch(/Bearer x|"y"|plain|"t"|sk-/);
    expect(JSON.stringify(out)).toContain("ok [REDACTED]");
  });
});

describe("date", () => {
  it("senza fuso usa Europe/Rome (ora legale e solare)", () => {
    expect(parseIsoInTimeZone("2026-07-01")?.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(parseIsoInTimeZone("2026-01-01T10:00")?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    expect(parseIsoInTimeZone("2026-01-01T10:00:00Z")?.toISOString()).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("rifiuta formati e date inesistenti", () => {
    for (const v of ["2026-02-30", "ieri", "2026-13-01", "01/02/2026"]) {
      expect(parseIsoInTimeZone(v)).toBeNull();
    }
  });

  it("inizio del mese nel fuso di Roma", () => {
    expect(startOfMonth(new Date("2026-10-31T23:30:00Z")).toISOString()).toBe(
      "2026-10-31T23:00:00.000Z",
    );
  });
});

describe("magic bytes", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array<number>(16).fill(0)]);
  it("riconosce jpeg, png, webp, pdf e rifiuta il resto", () => {
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMimeType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
      "image/webp",
    );
    expect(sniffMimeType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe("application/pdf");
    expect(sniffMimeType(bytes(0x47, 0x49, 0x46, 0x38))).toBeNull();
    expect(sniffMimeType(new Uint8Array())).toBeNull();
  });
});

describe("cursori", () => {
  it("roundtrip e pagina", () => {
    const c = { createdAt: new Date("2026-10-04T10:00:00.123Z"), id: crypto.randomUUID() };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    const page = toPage([c, c, c], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeCursor(c));
    expect(toPage([c], 2).nextCursor).toBeNull();
  });

  it("cursore manomesso → errore di validazione", () => {
    expect(() => decodeCursor("not-base64")).toThrow(/Cursore/);
  });
});
