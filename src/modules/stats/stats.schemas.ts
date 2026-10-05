import { z } from "@hono/zod-openapi";
import { IsoDateInput } from "../../shared/openapi.js";
import { CategorySchema, SIZE_UNITS } from "../extraction/extraction.schema.js";
import { ReceiptSource } from "../receipts/receipts.schemas.js";

export const StatsQuery = z.object({
  from: IsoDateInput.optional().openapi({
    description:
      "Data dello scontrino (acquisto o, se manca, caricamento) da cui partire. Default: nessun limite",
  }),
  to: IsoDateInput.optional().openapi({
    description: "Incluso; con la sola data comprende l'intera giornata. Default: nessun limite",
  }),
  granularity: z.enum(["month", "year"]).default("month"),
});
export type StatsQuery = z.infer<typeof StatsQuery>;

const amounts = {
  total: z
    .number()
    .openapi({ description: "Somma dei totali, 2 decimali, senza conversione di valuta" }),
  nReceipts: z.number().int(),
};

export const StatsTotals = z
  .object({
    ...amounts,
    average: z.number().openapi({ description: "Totale medio per scontrino, 2 decimali" }),
  })
  .openapi("StatsTotals");

export const StatsResponse = z
  .object({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable().openapi({
      description:
        "Limite superiore esclusivo, già normalizzato (inizio del giorno dopo se in query c'era la sola data)",
    }),
    granularity: z.enum(["month", "year"]),
    totals: StatsTotals,
    byCategory: z.array(z.object({ category: CategorySchema, ...amounts })),
    byPeriod: z.array(
      z.object({
        period: z
          .string()
          .openapi({ description: "YYYY-MM o YYYY (Europe/Rome)", example: "2026-10" }),
        ...amounts,
      }),
    ),
    topMerchants: z.array(z.object({ merchantName: z.string(), ...amounts })),
    bySource: z.array(z.object({ source: ReceiptSource, ...amounts })),
  })
  .openapi("Stats", {
    description: "Statistiche sulle estrazioni correnti degli scontrini estratti",
  });

export const StatsDatasetQuery = StatsQuery.omit({ granularity: true });
export type StatsDatasetQuery = z.infer<typeof StatsDatasetQuery>;

export const StatsDatasetResponse = z
  .object({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable().openapi({
      description: "Limite superiore esclusivo, già normalizzato come in /v1/stats",
    }),
    truncated: z.boolean().openapi({
      description:
        "Vero se uno dei due elenchi supera il limite ed è stato tagliato ai più recenti",
    }),
    receipts: z.array(
      z
        .object({
          id: z.uuid(),
          date: z.iso.datetime().openapi({
            description: "Data d'acquisto o, se manca, di caricamento",
          }),
          merchantName: z.string().nullable().openapi({
            description:
              "Nome armonizzato del negozio: insegna o nome, unito alle altre scritture dello stesso negozio",
          }),
          merchantOriginal: z.string().nullable().openapi({
            description: "Nome come letto dallo scontrino",
          }),
          total: z.number().nullable(),
          category: CategorySchema,
          source: ReceiptSource,
        })
        .openapi("StatsReceiptFact"),
    ),
    items: z.array(
      z
        .object({
          receiptId: z.uuid(),
          description: z.string(),
          quantity: z.number().nullable(),
          unitPrice: z.number().nullable(),
          amount: z.number().nullable(),
          category: CategorySchema.openapi({
            description: "Categoria della riga o, se manca, dello scontrino",
          }),
          normalizedName: z.string().nullable(),
          brand: z.string().nullable(),
          size: z.number().nullable(),
          sizeUnit: z.union([z.enum(SIZE_UNITS), z.null()]),
        })
        .openapi("StatsItemFact"),
    ),
  })
  .openapi("StatsDataset", {
    description:
      "Scontrini e righe prodotto del periodo (estrazioni correnti degli scontrini estratti), dal più recente",
  });
