import { z } from "@hono/zod-openapi";
import { PROVIDERS } from "../../config/env.js";
import { ALLOWED_MIME_TYPES } from "../../shared/files.js";
import { IsoDateInput } from "../../shared/openapi.js";
import { PaginationQuery } from "../../shared/pagination.js";
import {
  CategorySchema,
  NullableCategory,
  NullablePaymentMethod,
  PaymentMethodSchema,
} from "../extraction/extraction.schema.js";
import { EXTRACTION_ERROR_CODES } from "../extraction/extraction-errors.js";

export const ReceiptSource = z.enum(["camera", "file", "manual"]).openapi("ReceiptSource");
export const ReceiptStatus = z
  .enum(["pending_upload", "uploaded", "processing", "extracted", "failed"])
  .openapi("ReceiptStatus");
export const MimeTypeSchema = z.enum(ALLOWED_MIME_TYPES).openapi("MimeType");

const MAX_AMOUNT = 9_999_999_999.99;
const amount = () => z.number().min(-MAX_AMOUNT).max(MAX_AMOUNT);
const text = (max: number) => z.string().trim().min(1).max(max);
const currency = () =>
  z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .openapi({ example: "EUR" });

// ---- upload ----

export const UploadUrlBody = z
  .object({
    source: z.enum(["camera", "file"]),
    sha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .transform((v) => v.toLowerCase()),
    mimeType: MimeTypeSchema,
    sizeBytes: z.number().int().positive(),
    capturedAt: IsoDateInput.optional(),
    originalFilename: text(255).optional(),
  })
  .openapi("UploadUrlInput");

export const UploadUrlResponse = z
  .object({
    receiptId: z.uuid(),
    path: z.string(),
    uploadUrl: z.url(),
    token: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .openapi("UploadUrl");

export const CompleteResponse = z
  .object({ status: z.literal("uploaded") })
  .openapi("UploadAccepted");

// ---- manuale ----

const ItemInput = z.object({
  description: text(500),
  quantity: z.number().min(-9_999_999).max(9_999_999).optional(),
  unitPrice: amount().optional(),
  amount: amount().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  category: CategorySchema.optional(),
});

export const ManualReceiptInput = z
  .object({
    merchantName: text(200),
    merchantVat: text(32).optional(),
    purchasedAt: IsoDateInput,
    currency: currency().optional(),
    total: amount(),
    taxTotal: amount().optional(),
    paymentMethod: PaymentMethodSchema,
    category: CategorySchema,
    notes: z.string().max(2000).optional(),
    items: z.array(ItemInput).max(500).optional(),
  })
  .openapi("ManualReceiptInput");

export type ManualReceiptInput = z.infer<typeof ManualReceiptInput>;

// ---- dettaglio ----

export const Receipt = z
  .object({
    id: z.uuid(),
    source: ReceiptSource,
    status: ReceiptStatus,
    originalFilename: z.string().nullable(),
    sha256: z.string().nullable(),
    mimeType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    capturedAt: z.iso.datetime().nullable(),
    errorCode: z
      .string()
      .nullable()
      .openapi({
        description: `Motivo del fallimento quando status=failed. Valori attuali: ${EXTRACTION_ERROR_CODES.join(", ")}.`,
        example: "NOT_A_RECEIPT",
      }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Receipt");

export const ReceiptItem = z
  .object({
    id: z.uuid(),
    position: z.number().int(),
    description: z.string(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    amount: z.number().nullable(),
    vatRate: z.number().nullable(),
    category: NullableCategory,
  })
  .openapi("ReceiptItem");

export const ExtractionDetail = z
  .object({
    id: z.uuid(),
    receiptId: z.uuid(),
    method: z.enum(["llm", "manual"]),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    keySource: z.enum(["platform", "user"]).nullable(),
    promptVersion: z.string().nullable(),
    merchantName: z.string().nullable(),
    merchantVat: z.string().nullable(),
    merchantAddress: z.string().nullable(),
    purchasedAt: z.iso.datetime().nullable(),
    currency: z.string(),
    total: z.number().nullable(),
    taxTotal: z.number().nullable(),
    paymentMethod: NullablePaymentMethod,
    category: NullableCategory,
    confidence: z.number().nullable(),
    notes: z.string().nullable(),
    isCurrent: z.boolean(),
    editedByUser: z.boolean(),
    createdAt: z.iso.datetime(),
    items: z.array(ReceiptItem),
  })
  .openapi("ExtractionDetail");

export const ReceiptDetail = z
  .object({
    receipt: Receipt,
    fileUrl: z.url().optional(),
    extraction: ExtractionDetail.optional(),
    items: z.array(ReceiptItem),
    usage: z
      .object({
        provider: z.string(),
        model: z.string(),
        totalTokens: z.number().int().nullable(),
        costUsd: z.number().nullable(),
      })
      .optional(),
  })
  .openapi("ReceiptDetail");

export const ExtractionHistory = z
  .object({ items: z.array(ExtractionDetail) })
  .openapi("ExtractionHistory");

// ---- lista ----

export const ReceiptListQuery = PaginationQuery.extend({
  from: IsoDateInput.optional(),
  to: IsoDateInput.optional(),
  status: ReceiptStatus.optional(),
  category: CategorySchema.optional(),
  source: ReceiptSource.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export type ReceiptListQuery = z.infer<typeof ReceiptListQuery>;

export const ReceiptListItem = z
  .object({
    id: z.uuid(),
    source: ReceiptSource,
    status: ReceiptStatus,
    merchantName: z.string().nullable(),
    purchasedAt: z.iso.datetime().nullable(),
    total: z.number().nullable(),
    currency: z.string().nullable(),
    category: NullableCategory,
    thumbnailUrl: z.url().optional(),
    createdAt: z.iso.datetime(),
  })
  .openapi("ReceiptListItem");

export const ReceiptListResponse = z
  .object({ items: z.array(ReceiptListItem), nextCursor: z.string().nullable() })
  .openapi("ReceiptList");

// ---- modifica e rielaborazione ----

export const ExtractionPatch = z
  .object({
    merchantName: text(200).nullable(),
    merchantVat: text(32).nullable(),
    merchantAddress: text(500).nullable(),
    purchasedAt: IsoDateInput.nullable(),
    currency: currency(),
    total: amount().nullable(),
    taxTotal: amount().nullable(),
    paymentMethod: NullablePaymentMethod,
    category: NullableCategory,
    notes: z.string().max(2000).nullable(),
    items: z.array(ItemInput).max(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "nessun campo da modificare" })
  .openapi("ExtractionPatch");

export type ExtractionPatch = z.infer<typeof ExtractionPatch>;

export const ReextractBody = z
  .object({
    provider: z.enum(PROVIDERS).optional(),
    model: text(200).optional(),
  })
  .openapi("ReextractInput");

export type ReextractBody = z.infer<typeof ReextractBody>;
