import sharp from "sharp";
import type { LlmFile } from "../../ports/llm.port.js";

/** Oltre questo rapporto altezza/larghezza lo scontrino si taglia a fasce. */
export const TALL_RATIO = 2;
/** Altezza di una fascia rispetto alla larghezza: i provider la leggono senza rimpicciolirla. */
const TILE_RATIO = 1.4;
/** Sovrapposizione tra fasce consecutive, perché nessuna riga resti tagliata a metà. */
const OVERLAP = 0.12;
/** Larghezza massima delle fasce: oltre, i provider rimpiccioliscono comunque l'immagine. */
const MAX_TILE_WIDTH = 1200;
/** Massimo di fasce per chiamata: con scontrini più lunghi le fasce diventano più alte. */
export const MAX_TILES = 10;

/**
 * Le immagini molto alte (scontrini lunghi) diventano fasce verticali sovrapposte, dall'alto
 * in basso: mandate intere, i provider le rimpicciolirebbero fino a renderle illeggibili.
 * PDF, immagini normali e file che non si riescono a leggere restano come sono.
 */
export async function splitTallImage(file: LlmFile): Promise<LlmFile[]> {
  if (file.mimeType === "application/pdf") return [file];
  try {
    // `rotate()` applica l'orientamento EXIF: le dimensioni sono quelle che si vedono.
    const image = sharp(file.bytes).rotate();
    const { data, info } = await image
      .resize({ width: MAX_TILE_WIDTH, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (height / width <= TALL_RATIO) return [file];

    let tileHeight = Math.round(width * TILE_RATIO);
    const stepOf = (h: number) => Math.round(h * (1 - OVERLAP));
    const countOf = (h: number) => Math.max(1, Math.ceil((height - h) / stepOf(h)) + 1);
    while (countOf(tileHeight) > MAX_TILES) tileHeight = Math.round(tileHeight * 1.15);
    const step = stepOf(tileHeight);

    const raw = sharp(data, { raw: { width, height, channels } });
    const tiles: LlmFile[] = [];
    for (let top = 0; top < height; top += step) {
      const h = Math.min(tileHeight, height - top);
      const bytes = await raw
        .clone()
        .extract({ left: 0, top, width, height: h })
        .jpeg({ quality: 85 })
        .toBuffer();
      tiles.push({ bytes: new Uint8Array(bytes), mimeType: "image/jpeg" });
      if (top + h >= height) break;
    }
    return tiles;
  } catch {
    // Immagine non decodificabile qui: la si manda intera e decide il provider.
    return [file];
  }
}
