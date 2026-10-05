import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_TILES, splitTallImage } from "../../src/modules/extraction/tiles.js";
import { JPEG, PDF } from "../helpers/fakes.js";

/** JPEG vero di `width`×`height`, con una riga scura ogni 100 px per controllare i tagli. */
async function image(width: number, height: number) {
  const stripes = Array.from({ length: Math.floor(height / 100) }, (_, i) => ({
    input: { create: { width, height: 4, channels: 3 as const, background: "#000000" } },
    top: i * 100,
    left: 0,
  }));
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(stripes)
    .jpeg()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), mimeType: "image/jpeg" as const };
}

const sizes = (files: { bytes: Uint8Array }[]) =>
  Promise.all(files.map(async (f) => sharp(f.bytes).metadata()));

describe("fasce degli scontrini lunghi", () => {
  it("lascia intere le immagini normali, i PDF e i file non leggibili", async () => {
    const normal = await image(1000, 1500);
    expect(await splitTallImage(normal)).toEqual([normal]);
    const pdf = { bytes: PDF(), mimeType: "application/pdf" as const };
    expect(await splitTallImage(pdf)).toEqual([pdf]);
    const broken = { bytes: JPEG(), mimeType: "image/jpeg" as const };
    expect(await splitTallImage(broken)).toEqual([broken]);
  });

  it("taglia uno scontrino lungo in fasce sovrapposte che coprono tutta l'altezza", async () => {
    const tiles = await splitTallImage(await image(1000, 6000));
    const meta = await sizes(tiles);
    expect(tiles.length).toBeGreaterThan(3);
    expect(meta.every((m) => m.width === 1000)).toBe(true);
    expect(meta.every((m) => m.height <= 1400)).toBe(true);
    // Con la sovrapposizione la somma delle altezze supera quella dell'originale.
    const total = meta.reduce((sum, m) => sum + m.height, 0);
    expect(total).toBeGreaterThan(6000);
    expect(total).toBeLessThan(6000 * 1.2);
  });

  it("riduce le immagini troppo larghe e non supera il massimo di fasce", async () => {
    const wide = await sizes(await splitTallImage(await image(2400, 9600)));
    expect(wide.every((m) => m.width === 1200)).toBe(true);
    const veryLong = await splitTallImage(await image(500, 30000));
    expect(veryLong.length).toBeLessThanOrEqual(MAX_TILES);
    expect(veryLong.length).toBeGreaterThan(1);
  });
});
