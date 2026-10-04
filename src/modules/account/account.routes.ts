import { createRoute, z } from "@hono/zod-openapi";
import { commonErrors, jsonResponse, security } from "../../shared/openapi.js";
import { createRouter } from "../../shared/router.js";

const MeResponse = z
  .object({
    userId: z.uuid(),
    email: z.string().nullable(),
    ai: z.object({
      mode: z.enum(["platform", "byok"]),
      provider: z.string().nullable(),
      model: z.string().nullable(),
    }),
    platformQuota: z.object({ used: z.number().int(), limit: z.number().int() }),
  })
  .openapi("Me");

const me = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["account"],
  security,
  summary: "Utente corrente, impostazioni AI e quota della piattaforma",
  responses: { 200: jsonResponse(MeResponse, "Utente corrente"), ...commonErrors },
});

export const DeleteAccountInput = z
  .object({
    confirm: z
      .literal("ELIMINA")
      .openapi({ description: "Conferma esplicita della cancellazione" }),
  })
  .openapi("DeleteAccountInput");

const deleteAccount = createRoute({
  method: "delete",
  path: "/v1/account",
  tags: ["account"],
  security,
  summary: "Cancella l'utente, i suoi file e tutti i suoi dati",
  request: {
    body: { required: true, content: { "application/json": { schema: DeleteAccountInput } } },
  },
  responses: { 204: { description: "Account cancellato" }, ...commonErrors },
});

export const accountRoutes = () =>
  createRouter()
    .openapi(me, async (c) => {
      const res = await c.get("container").account.me(c.get("userId"), c.get("email"));
      return c.json(res, 200);
    })
    .openapi(deleteAccount, async (c) => {
      await c.get("container").account.deleteAccount(c.get("userId"));
      return c.body(null, 204);
    });
