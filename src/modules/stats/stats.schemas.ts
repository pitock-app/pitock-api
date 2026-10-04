import { z } from "@hono/zod-openapi";
import { IsoDateInput } from "../../shared/openapi.js";
import { CategorySchema } from "../extraction/extraction.schema.js";
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
