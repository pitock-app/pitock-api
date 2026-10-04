import { AppError } from "../../shared/errors.js";
import type { Db } from "./client.js";

/** Segnaposto quando `DATABASE_URL` manca: l'app parte, le rotte DB rispondono 503. */
export function unavailableDb(): Db {
  return new Proxy({} as Db, {
    get() {
      throw new AppError("SERVICE_UNAVAILABLE", "Database non configurato");
    },
  });
}
