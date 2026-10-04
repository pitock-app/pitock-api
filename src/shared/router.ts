import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../types.js";
import { AppError } from "./errors.js";

/** Router con la validazione Zod che produce errori nel formato comune (solo i path, mai i valori). */
export const createRouter = () =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "body"))];
        throw new AppError("VALIDATION_ERROR", `Campi non validi: ${fields.join(", ")}`);
      }
      return undefined;
    },
  });
