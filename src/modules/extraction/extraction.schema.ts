import { z } from "@hono/zod-openapi";

export const CATEGORIES = [
  "alimentari",
  "ristorazione",
  "trasporti",
  "carburante",
  "salute",
  "casa",
  "abbigliamento",
  "tecnologia",
  "svago",
  "servizi",
  "altro",
] as const;
export const PAYMENT_METHODS = ["contanti", "carta", "bancomat", "altro", "sconosciuto"] as const;

/** Unità del formato di una confezione. */
export const SIZE_UNITS = ["g", "kg", "ml", "cl", "l", "pz"] as const;

export type Category = (typeof CATEGORIES)[number];
export type SizeUnit = (typeof SIZE_UNITS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CategorySchema = z.enum(CATEGORIES).openapi("Category");
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS).openapi("PaymentMethod");

// `.nullable()` su uno schema registrato altererebbe il componente condiviso nell'OpenAPI
// (aggiungendo null all'enum anche dove è obbligatorio): si usa un'unione esplicita.
export const NullableCategory = z.union([CategorySchema, z.null()]);
export const NullablePaymentMethod = z.union([PaymentMethodSchema, z.null()]);

/** Output strutturato richiesto al modello (sezione 7). */
export const ReceiptExtraction = z.object({
  is_receipt: z.boolean(),
  merchant_name: z.string().nullable(),
  // Campi aggiunti con il prompt v3: facoltativi, così un modello che non li restituisce
  // non fa fallire l'estrazione.
  merchant_brand: z.string().nullable().optional(),
  merchant_vat: z.string().nullable(),
  merchant_address: z.string().nullable(),
  purchased_at: z.string().nullable(), // ISO 8601; se manca il fuso → Europe/Rome
  currency: z.string().length(3),
  total: z.number().nullable(),
  tax_total: z.number().nullable(),
  payment_method: z.enum(PAYMENT_METHODS),
  category: z.enum(CATEGORIES),
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nullable(),
      unit_price: z.number().nullable(),
      amount: z.number().nullable(),
      vat_rate: z.number().nullable(),
      category: z.enum(CATEGORIES).nullable(),
      normalized_name: z.string().nullable().optional(),
      brand: z.string().nullable().optional(),
      size: z.number().nullable().optional(),
      size_unit: z.enum(SIZE_UNITS).nullable().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;
