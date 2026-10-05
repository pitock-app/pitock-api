import {
  CATEGORIES,
  PAYMENT_METHODS,
  SIZE_UNITS,
  type Category,
  type PaymentMethod,
  type SizeUnit,
} from "../extraction/extraction.schema.js";
import type { ExtractionWithItems, ItemFields, ItemRow } from "../extraction/extractions.repo.js";
import type { ItemInput } from "./receipts.schemas.js";
import type { ReceiptRow } from "./receipts.repo.js";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** Valori del DB fuori lista diventano null: il contratto espone solo gli enum. */
export const asCategory = (v: string | null): Category | null =>
  (CATEGORIES as readonly string[]).includes(v ?? "") ? (v as Category) : null;
export const asPaymentMethod = (v: string | null): PaymentMethod | null =>
  (PAYMENT_METHODS as readonly string[]).includes(v ?? "") ? (v as PaymentMethod) : null;

export const toReceipt = (r: ReceiptRow) => ({
  id: r.id,
  source: r.source,
  status: r.status,
  originalFilename: r.originalFilename,
  sha256: r.sha256,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
  capturedAt: isoOrNull(r.capturedAt),
  errorCode: r.errorCode,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

export const toItem = (i: ItemRow) => ({
  id: i.id,
  position: i.position,
  description: i.description,
  quantity: i.quantity,
  unitPrice: i.unitPrice,
  amount: i.amount,
  vatRate: i.vatRate,
  category: asCategory(i.category),
  normalizedName: i.normalizedName,
  brand: i.brand,
  size: i.size,
  sizeUnit: asSizeUnit(i.sizeUnit),
});

const asSizeUnit = (v: string | null): SizeUnit | null =>
  (SIZE_UNITS as readonly string[]).includes(v ?? "") ? (v as SizeUnit) : null;

/** Riga in ingresso (form manuale o correzione) → colonne di `receipt_items`. */
export const toItemFields = (i: ItemInput): ItemFields => ({
  description: i.description,
  quantity: i.quantity ?? null,
  unitPrice: i.unitPrice ?? null,
  amount: i.amount ?? null,
  vatRate: i.vatRate ?? null,
  category: i.category ?? null,
  normalizedName: i.normalizedName?.trim() || null,
  brand: i.brand?.trim() || null,
  size: i.size ?? null,
  sizeUnit: i.size ? (i.sizeUnit ?? null) : null,
});

export const toExtraction = (e: ExtractionWithItems) => ({
  id: e.id,
  receiptId: e.receiptId,
  method: e.method,
  provider: e.provider,
  model: e.model,
  keySource: e.keySource,
  promptVersion: e.promptVersion,
  merchantName: e.merchantName,
  merchantBrand: e.merchantBrand,
  merchantVat: e.merchantVat,
  merchantAddress: e.merchantAddress,
  purchasedAt: isoOrNull(e.purchasedAt),
  currency: e.currency,
  total: e.total,
  taxTotal: e.taxTotal,
  paymentMethod: asPaymentMethod(e.paymentMethod),
  category: asCategory(e.category),
  confidence: e.confidence,
  notes: e.notes,
  isCurrent: e.isCurrent,
  editedByUser: e.editedByUser,
  createdAt: iso(e.createdAt),
  items: e.items.map(toItem),
});

export type ReceiptDto = ReturnType<typeof toReceipt>;
export type ExtractionDto = ReturnType<typeof toExtraction>;
