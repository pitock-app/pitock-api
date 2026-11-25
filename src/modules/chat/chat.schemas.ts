import { z } from "@hono/zod-openapi";
import { CHART_TYPES } from "./chat.tools.js";

export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 2000;

const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

export const ChatRequest = z
  .object({
    messages: z
      .array(ChatMessage)
      .min(1)
      .max(MAX_MESSAGES)
      .refine((m) => m.at(-1)?.role === "user", "L'ultimo messaggio deve essere dell'utente")
      .openapi({
        description:
          "Conversazione dal più vecchio al più recente; il server non la salva. Ultimo messaggio: utente",
      }),
  })
  .openapi("ChatRequest");

export const ChatChartSchema = z
  .object({
    type: z.enum(CHART_TYPES),
    title: z.string(),
    points: z.array(
      z.object({
        label: z.string().openapi({
          description: "Categoria, mese (YYYY-MM), negozio o prodotto",
        }),
        value: z.number().openapi({ description: "Importo in euro, 2 decimali" }),
      }),
    ),
  })
  .openapi("ChatChart");

export const ChatResponse = z
  .object({
    answer: z.string(),
    grounded: z.boolean().openapi({
      description:
        "true se ogni numero della risposta viene dai dati; false = risposta di ripiego, senza numeri",
    }),
    charts: z.array(ChatChartSchema).openapi({
      description: "Grafici decisi dall'assistente, con i valori calcolati dal database",
    }),
  })
  .openapi("ChatResponse");
