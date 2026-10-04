import { createRoute } from "@hono/zod-openapi";
import {
  commonErrors,
  DuplicateErrorResponse,
  ErrorResponse,
  IdParam,
  jsonResponse,
  notFoundError,
  security,
} from "../../shared/openapi.js";
import { createRouter } from "../../shared/router.js";
import {
  CompleteResponse,
  ExtractionDetail,
  ExtractionHistory,
  ExtractionPatch,
  ManualReceiptInput,
  ReceiptDetail,
  ReceiptListQuery,
  ReceiptListResponse,
  ReextractBody,
  type ReextractBody as ReextractInput,
  UploadUrlBody,
  UploadUrlResponse,
} from "./receipts.schemas.js";

const tags = ["receipts"];
const body = <T>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const conflict = { 409: jsonResponse(ErrorResponse, "Stato non compatibile") } as const;

const uploadUrl = createRoute({
  method: "post",
  path: "/v1/receipts/upload-url",
  tags,
  security,
  summary: "Crea lo scontrino e restituisce un URL firmato di upload (2 minuti)",
  request: { body: body(UploadUrlBody) },
  responses: {
    201: jsonResponse(UploadUrlResponse, "URL di upload creato"),
    409: jsonResponse(DuplicateErrorResponse, "Scontrino già caricato (stesso sha256)"),
    413: jsonResponse(ErrorResponse, "File troppo grande"),
    ...commonErrors,
  },
});

const complete = createRoute({
  method: "post",
  path: "/v1/receipts/{id}/complete",
  tags,
  security,
  summary: "Conferma l'upload: ricontrolla il file e accoda l'estrazione",
  request: { params: IdParam },
  responses: {
    202: jsonResponse(CompleteResponse, "Upload accettato, estrazione in coda"),
    422: jsonResponse(ErrorResponse, "Il file caricato non corrisponde a quanto dichiarato"),
    ...conflict,
    ...notFoundError,
    ...commonErrors,
  },
});

const manual = createRoute({
  method: "post",
  path: "/v1/receipts/manual",
  tags,
  security,
  summary: "Inserimento manuale (nessuna chiamata LLM)",
  request: { body: body(ManualReceiptInput) },
  responses: { 201: jsonResponse(ReceiptDetail, "Scontrino creato"), ...commonErrors },
});

const list = createRoute({
  method: "get",
  path: "/v1/receipts",
  tags,
  security,
  summary: "Elenco paginato degli scontrini",
  request: { query: ReceiptListQuery },
  responses: { 200: jsonResponse(ReceiptListResponse, "Pagina di scontrini"), ...commonErrors },
});

const get = createRoute({
  method: "get",
  path: "/v1/receipts/{id}",
  tags,
  security,
  summary: "Dettaglio con estrazione corrente e URL firmato del file (10 minuti)",
  request: { params: IdParam },
  responses: {
    200: jsonResponse(ReceiptDetail, "Dettaglio"),
    ...notFoundError,
    ...commonErrors,
  },
});

const history = createRoute({
  method: "get",
  path: "/v1/receipts/{id}/extractions",
  tags,
  security,
  summary: "Storico delle estrazioni, dalla più recente",
  request: { params: IdParam },
  responses: {
    200: jsonResponse(ExtractionHistory, "Storico"),
    ...notFoundError,
    ...commonErrors,
  },
});

const patchExtraction = createRoute({
  method: "patch",
  path: "/v1/extractions/{id}",
  tags,
  security,
  summary: "Corregge l'estrazione corrente (items sostituisce tutte le righe)",
  request: { params: IdParam, body: body(ExtractionPatch) },
  responses: {
    200: jsonResponse(ExtractionDetail, "Estrazione aggiornata"),
    ...conflict,
    ...notFoundError,
    ...commonErrors,
  },
});

const reextract = createRoute({
  method: "post",
  path: "/v1/receipts/{id}/reextract",
  tags,
  security,
  summary: "Rielabora lo scontrino creando una nuova estrazione (non per source=manual)",
  request: {
    params: IdParam,
    body: { required: false, content: { "application/json": { schema: ReextractBody } } },
  },
  responses: {
    202: jsonResponse(CompleteResponse, "Rielaborazione in coda"),
    ...conflict,
    ...notFoundError,
    ...commonErrors,
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/receipts/{id}",
  tags,
  security,
  summary: "Cancella file, estrazioni e righe",
  request: { params: IdParam },
  responses: { 204: { description: "Cancellato" }, ...notFoundError, ...commonErrors },
});

export const receiptsRoutes = () =>
  createRouter()
    .openapi(uploadUrl, async (c) => {
      const res = await c
        .get("container")
        .receipts.createUploadUrl(c.get("userId"), c.req.valid("json"));
      return c.json(res, 201);
    })
    .openapi(complete, async (c) => {
      const res = await c
        .get("container")
        .receipts.complete(c.get("userId"), c.req.valid("param").id);
      return c.json(res, 202);
    })
    .openapi(manual, async (c) => {
      const res = await c
        .get("container")
        .receipts.createManual(c.get("userId"), c.req.valid("json"));
      return c.json(res, 201);
    })
    .openapi(list, async (c) => {
      const res = await c.get("container").receipts.list(c.get("userId"), c.req.valid("query"));
      return c.json(res, 200);
    })
    .openapi(get, async (c) => {
      const res = await c
        .get("container")
        .receipts.detail(c.get("userId"), c.req.valid("param").id);
      return c.json(res, 200);
    })
    .openapi(history, async (c) => {
      const res = await c
        .get("container")
        .receipts.extractionHistory(c.get("userId"), c.req.valid("param").id);
      return c.json(res, 200);
    })
    .openapi(patchExtraction, async (c) => {
      const res = await c
        .get("container")
        .extractionEdit.update(c.get("userId"), c.req.valid("param").id, c.req.valid("json"));
      return c.json(res, 200);
    })
    .openapi(reextract, async (c) => {
      const opts = c.req.valid("json") as ReextractInput | undefined;
      const res = await c
        .get("container")
        .receipts.reextract(c.get("userId"), c.req.valid("param").id, opts ?? {});
      return c.json(res, 202);
    })
    .openapi(remove, async (c) => {
      await c.get("container").receipts.remove(c.get("userId"), c.req.valid("param").id);
      return c.body(null, 204);
    });
