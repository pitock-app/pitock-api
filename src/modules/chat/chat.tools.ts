import { z } from "zod";
import type { LlmTool } from "../../ports/llm.port.js";
import { parseIsoInTimeZone, parseRangeEnd } from "../../shared/dates.js";
import { AVOIDABILITY, CATEGORIES } from "../extraction/extraction.schema.js";
import { BREAKDOWN_LIMIT, type StatsRange, type StatsRepo } from "../stats/stats.repo.js";

export const CHART_TYPES = ["bar", "line", "pie"] as const;

export interface ChatChart {
  type: (typeof CHART_TYPES)[number];
  title: string;
  points: { label: string; value: number }[];
}

/** Ogni chiamata, con argomenti e risultato: è la base del controllo dei numeri. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  output: unknown;
}

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Data YYYY-MM-DD (Europe/Rome)");
const Period = {
  from: Day.describe("Primo giorno incluso, YYYY-MM-DD"),
  to: Day.describe("Ultimo giorno incluso, YYYY-MM-DD"),
};

const toRange = (p: { from: string; to: string }): StatsRange | null => {
  const from = parseIsoInTimeZone(p.from);
  const to = parseRangeEnd(p.to);
  return from && to && from < to ? { from, to } : null;
};

const ProductsInput = z.object({
  ...Period,
  category: z.enum(CATEGORIES).optional().describe("Solo i prodotti di questa categoria"),
});

const SpendingInput = z.object({
  ...Period,
  groupBy: z
    .enum(["none", "category", "month", "merchant", "product"])
    .describe("Come dividere il totale; none = un solo totale"),
  category: z.enum(CATEGORIES).optional(),
  merchant: z.string().min(1).max(100).optional().describe("Parte del nome del negozio"),
  avoidability: z.enum(AVOIDABILITY).optional(),
  products: z
    .array(z.string().min(1).max(200))
    .max(200)
    .optional()
    .describe("Nomi esatti presi da list_products: somma solo queste righe prodotto"),
  chart: z
    .enum(["none", ...CHART_TYPES])
    .describe(
      "Grafico da mostrare: line per l'andamento nel tempo (groupBy month), pie per la " +
        "ripartizione di un totale in poche parti, bar per confrontare gruppi; none se basta il numero",
    ),
  chartTitle: z.string().max(80).optional().describe("Titolo breve del grafico, senza numeri"),
});

const ReceiptsInput = z.object({
  ...Period,
  merchant: z.string().min(1).max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
});

const INVALID_PERIOD = { error: "Periodo non valido: from e to sono YYYY-MM-DD con from <= to" };

/**
 * Strumenti di sola lettura sui dati di un utente. `userId` è chiuso qui dentro: il modello
 * non può sceglierlo. Ogni chiamata finisce in `calls`, ogni grafico richiesto in `charts`.
 */
export function createChatTools(stats: StatsRepo, userId: string) {
  const calls: ToolCallRecord[] = [];
  const charts: ChatChart[] = [];

  const define = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.infer<S>) => Promise<unknown>,
  ): LlmTool => ({
    description,
    inputSchema: schema,
    async execute(raw) {
      const parsed = schema.safeParse(raw);
      const output = parsed.success
        ? await run(parsed.data)
        : {
            error: "Argomenti non validi",
            issues: parsed.error.issues.map((i) => i.path.join(".")),
          };
      calls.push({ tool: name, input: raw, output });
      return output;
    },
  });

  const tools: Record<string, LlmTool> = {
    list_products: define(
      "list_products",
      "Elenca i prodotti comprati nel periodo (nome, volte, spesa). Usalo prima di spending " +
        "quando la domanda riguarda un tipo di prodotto che non è una categoria (es. carne, latte).",
      ProductsInput,
      async (q) => {
        const range = toRange(q);
        if (!range) return INVALID_PERIOD;
        return { products: await stats.productNames(userId, range, q.category) };
      },
    ),

    spending: define(
      "spending",
      "Calcola la spesa del periodo con filtri e raggruppamento. È l'unica fonte dei numeri: " +
        "totali, conteggi e quote percentuali (share) arrivano già calcolati.",
      SpendingInput,
      async (q) => {
        const range = toRange(q);
        if (!range) return INVALID_PERIOD;
        const rows = await stats.breakdown(userId, { ...q, range });
        const sum = rows.reduce((acc, r) => acc + r.total, 0);
        const withShare = rows.map((r) => ({
          ...r,
          share: sum > 0 ? Math.round((r.total / sum) * 1000) / 10 : 0,
        }));
        if (q.chart !== "none" && q.groupBy !== "none" && rows.length >= 2) {
          charts.push({
            type: q.chart,
            title: q.chartTitle ?? "Spesa",
            points: rows.map((r) => ({ label: r.label, value: r.total })),
          });
        }
        return {
          level: q.products !== undefined || q.groupBy === "product" ? "righe" : "scontrini",
          rows: withShare,
          ...(rows.length > 1 ? { sumOfRows: Math.round(sum * 100) / 100 } : {}),
          truncated: rows.length === BREAKDOWN_LIMIT,
        };
      },
    ),

    find_receipts: define(
      "find_receipts",
      "Elenca gli scontrini del periodo (data, negozio, totale), dal più recente, al massimo 20.",
      ReceiptsInput,
      async (q) => {
        const range = toRange(q);
        if (!range) return INVALID_PERIOD;
        return { receipts: await stats.receiptList(userId, range, q) };
      },
    ),
  };

  return { tools, calls, charts };
}
