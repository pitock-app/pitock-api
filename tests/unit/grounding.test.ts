import { describe, expect, it } from "vitest";
import { readings, ungroundedNumbers } from "../../src/modules/chat/grounding.js";

describe("readings", () => {
  it("legge i formati italiano e inglese", () => {
    expect(readings("1.234,56")).toEqual([1234.56]);
    expect(readings("1,234.56")).toEqual([1234.56]);
    expect(readings("12,50")).toEqual([12.5]);
    expect(readings("12.50")).toEqual([12.5]);
    expect(readings("1.234")).toEqual([1.234, 1234]);
    expect(readings("2026")).toEqual([2026]);
  });
});

describe("ungroundedNumbers", () => {
  const sources = [JSON.stringify({ rows: [{ total: 10.7, share: 33.3 }, { total: 1234.56 }] })];

  it("accetta i numeri dei dati, anche arrotondati e scritti all'italiana", () => {
    expect(
      ungroundedNumbers("Hai speso 10,70 € (33,3%), circa 11 €, e 1.234,56 € in tutto", sources),
    ).toEqual([]);
  });

  it("segnala i numeri inventati o calcolati", () => {
    expect(ungroundedNumbers("Hai speso 999 € e 1.245,26 €", sources)).toEqual(["999", "1.245,26"]);
  });

  it("lascia passare i piccoli interi dei conteggi", () => {
    expect(ungroundedNumbers("Ho trovato 3 prodotti", sources)).toEqual([]);
  });
});
