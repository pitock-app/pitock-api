import { createRoute } from "@hono/zod-openapi";
import { commonErrors, ErrorResponse, jsonResponse, security } from "../../shared/openapi.js";
import { createRouter } from "../../shared/router.js";
import { ChatRequest, ChatResponse } from "./chat.schemas.js";

const chat = createRoute({
  method: "post",
  path: "/v1/chat",
  tags: ["chat"],
  security,
  summary: "Domanda in linguaggio naturale sulle proprie spese",
  request: {
    body: { required: true, content: { "application/json": { schema: ChatRequest } } },
  },
  responses: {
    200: jsonResponse(ChatResponse, "Risposta dell'assistente"),
    409: jsonResponse(ErrorResponse, "Nessuna chiave salvata per il provider (USER_KEY_MISSING)"),
    422: jsonResponse(ErrorResponse, "Chiave utente non valida o senza credito"),
    502: jsonResponse(ErrorResponse, "Provider LLM non disponibile"),
    ...commonErrors,
  },
});

export const chatRoutes = () =>
  createRouter().openapi(chat, async (c) => {
    const { messages } = c.req.valid("json");
    const res = await c.get("container").chat.ask(c.get("userId"), messages);
    return c.json(res, 200);
  });
