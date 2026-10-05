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

const appendNote = (notes: string | null, note: string) => (notes ? `${notes}\n${note}` : note);

/** Normalizza l'output del modello e ne abbassa la confidenza se i conti non tornano. */
export function postprocess(out: ReceiptExtraction): PostprocessResult {
  let confidence = out.confidence;
  let notes = out.notes || null;
  const total = round(out.total, 2);

  const amounts = out.items.map((i) => i.amount).filter((a): a is number => a !== null);
  if (total !== null && amounts.length > 0) {
    const sum = amounts.reduce((acc, a) => acc + a, 0);
    if (Math.abs(sum - total) > SUM_TOLERANCE) {
      confidence = Math.min(confidence, LOW_CONFIDENCE);
      notes = appendNote(
        notes,
        `La somma delle righe (${sum.toFixed(2)}) non coincide con il totale (${total.toFixed(2)}).`,
      );
    }
  }

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
      currency: out.currency.toUpperCase(),
      total,
      taxTotal: round(out.tax_total, 2),
      paymentMethod: out.payment_method,
      category: out.category,
      notes,
    },
    items: out.items.map((i) => ({
      description: i.description,
      quantity: round(i.quantity, 3),
      unitPrice: round(i.unit_price, 2),
      amount: round(i.amount, 2),
      vatRate: round(i.vat_rate, 2),
      category: i.category,
      normalizedName: clean(i.normalized_name),
      brand: clean(i.brand),
      size: i.size && i.size > 0 ? round(i.size, 3) : null,
      sizeUnit: i.size && i.size > 0 ? (i.size_unit ?? null) : null,
    })),
  };
}
