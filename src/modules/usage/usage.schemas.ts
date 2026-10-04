import { z } from "@hono/zod-openapi";
import { IsoDateInput } from "../../shared/openapi.js";
import { PaginationQuery } from "../../shared/pagination.js";

export const UsageQuery = z.object({
  from: IsoDateInput.optional().openapi({ description: "Default: primo giorno del mese corrente" }),
  to: IsoDateInput.optional().openapi({
    description: "Incluso; con la sola data comprende l'intera giornata. Default: adesso",
  }),
  groupBy: z.enum(["day", "model"]).default("day"),
});
export type UsageQuery = z.infer<typeof UsageQuery>;

const totalsShape = {
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().openapi({ description: "Somma dei costi noti in USD" }),
  unpricedCalls: z
    .number()
    .int()
    .openapi({ description: "Chiamate senza prezzo in model_prices (costo non incluso)" }),
};

export const UsageTotals = z.object(totalsShape).openapi("UsageTotals");

export const UsageSummary = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    totals: UsageTotals,
    series: z
      .array(
        z.object({
          key: z.string().openapi({
            description: "Giorno (YYYY-MM-DD, Europe/Rome) oppure provider/model secondo groupBy",
          }),
          ...totalsShape,
        }),
      )
      .openapi({ description: "Serie raggruppata secondo groupBy" }),
    byModel: z.array(z.object({ provider: z.string(), model: z.string(), ...totalsShape })),
  })
  .openapi("UsageSummary");

export const UsageCallsQuery = PaginationQuery;

export const UsageCall = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    operation: z.enum(["extract", "reextract", "key_test"]),
    provider: z.string(),
    model: z.string(),
    keySource: z.enum(["platform", "user"]),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    totalTokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
    latencyMs: z.number().int(),
    success: z.boolean(),
    errorCode: z.string().nullable(),
    receiptId: z.uuid().nullable(),
    merchantName: z.string().nullable(),
  })
  .openapi("UsageCall");

export const UsageCallsResponse = z
  .object({ items: z.array(UsageCall), nextCursor: z.string().nullable() })
  .openapi("UsageCallList");
