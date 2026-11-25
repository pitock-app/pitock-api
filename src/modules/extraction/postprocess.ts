import { parseIsoInTimeZone } from "../../shared/dates.js";
import type { ExtractionFields, ItemFields } from "./extractions.repo.js";
import type { ReceiptExtraction } from "./extraction.schema.js";

/** Scarto massimo tra somma delle righe e totale (sezione 7). */
export const SUM_TOLERANCE = 0.05;
export const LOW_CONFIDENCE = 0.5;

export interface PostprocessResult {
  isReceipt: boolean;
  fields: ExtractionFields;
  items: ItemFields[];
  confidence: number;
}

const round = (n: number | null, digits: number) =>
  n === null || !Number.isFinite(n) ? null : Number(n.toFixed(digits));

/** Testo ripulito; null se vuoto o assente. */
const clean = (text: string | null | undefined) => text?.trim() || null;

// ponytail: cambi fissi e approssimativi, da aggiornare a mano; un'API dei cambi se serve precisione.
/** Euro per un'unità di valuta estera. */
export const EUR_RATES: Record<string, number> = { USD: 0.86, GBP: 1.15, CHF: 1.07 };

const appendNote = (notes: string | null, note: string) => (notes ? `${notes}\n${note}` : note);

/** Righe di scorporo del totale (IVA, accise, sconti...): non sono prodotti e non si tracciano. */
const BREAKDOWN_LINE =
  /^\W*(i\.?v\.?a|vat|accise|imponibile|sub\s?totale|totale|sconto|sconti|abbuono)(?![a-z])/i;

export const isBreakdownLine = (description: string) => BREAKDOWN_LINE.test(description);

/** Normalizza l'output del modello e ne abbassa la confidenza se i conti non tornano. */
export function postprocess(out: ReceiptExtraction): PostprocessResult {
  let confidence = out.confidence;
  let notes = out.notes || null;
  const total = round(out.total, 2);
  const taxTotal = round(out.tax_total, 2);
  const products = out.items.filter((i) => !isBreakdownLine(i.description));

  const amounts = products.map((i) => i.amount).filter((a): a is number => a !== null);
  /** Fattore per portare le righe a IVA inclusa; 1 se sono già importi pagati. */
  let gross = 1;
  if (total !== null && amounts.length > 0) {
    const sum = amounts.reduce((acc, a) => acc + a, 0);
    const matches = (s: number) => Math.abs(s - total) <= SUM_TOLERANCE;
    // Righe al netto IVA (fatture) che tornano col totale solo aggiungendo `tax_total`: si salva
    // il prezzo pagato, ripartendo l'IVA sulle righe in proporzione al loro importo.
    if (!matches(sum) && taxTotal !== null && sum > 0 && matches(sum + taxTotal)) {
      gross = total / sum;
    } else if (!matches(sum)) {
      confidence = Math.min(confidence, LOW_CONFIDENCE);
      notes = appendNote(
        notes,
        `La somma delle righe (${sum.toFixed(2)}) non coincide con il totale (${total.toFixed(2)}).`,
      );
    }
  }

  const currency = out.currency.toUpperCase();
  const rate = EUR_RATES[currency];
  if (rate && total !== null) {
    notes = appendNote(
      notes,
      `Importo originale ${total.toFixed(2)} ${currency}, convertito in EUR al cambio indicativo ${rate}.`,
    );
  }
  /** Importo in euro se la valuta ha un cambio noto, altrimenti invariato. */
  const eur = (n: number | null) => (rate && n !== null ? n * rate : n);

  return {
    isReceipt: out.is_receipt,
    confidence,
    fields: {
      merchantName: out.merchant_name,
      merchantBrand: clean(out.merchant_brand),
      merchantVat: out.merchant_vat,
      merchantAddress: out.merchant_address,
      // Senza fuso vale Europe/Rome; una data illeggibile diventa null.
      purchasedAt: out.purchased_at ? parseIsoInTimeZone(out.purchased_at) : null,
      currency: rate ? "EUR" : currency,
      total: round(eur(total), 2),
      taxTotal: round(eur(taxTotal), 2),
      paymentMethod: out.payment_method,
      category: out.category,
      avoidability: out.avoidability ?? null,
      notes,
    },
    items: products.map((i) => ({
      description: i.description,
      quantity: round(i.quantity, 3),
      unitPrice: round(eur(i.unit_price === null ? null : i.unit_price * gross), 2),
      amount: round(eur(i.amount === null ? null : i.amount * gross), 2),
      vatRate: round(i.vat_rate, 2),
      category: i.category,
      normalizedName: clean(i.normalized_name),
      brand: clean(i.brand),
      size: i.size && i.size > 0 ? round(i.size, 3) : null,
      sizeUnit: i.size && i.size > 0 ? (i.size_unit ?? null) : null,
      avoidability: i.avoidability ?? null,
    })),
  };
}
