import { inArray } from "drizzle-orm";
import { createDb } from "../src/infra/db/client.js";
import { receiptItems } from "../src/infra/db/schema/index.js";
import { isBreakdownLine } from "../src/modules/extraction/postprocess.js";

/**
 * Una tantum: cancella da `receipt_items` le righe di scorporo del totale (IVA, accise, sconti)
 * lette prima del prompt v9. Il totale dello scontrino non cambia.
 *
 *   pnpm tsx --env-file=.env scripts/strip-breakdown-lines.ts           # elenca soltanto
 *   pnpm tsx --env-file=.env scripts/strip-breakdown-lines.ts --apply   # cancella
 */
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("DATABASE_URL mancante.");
  process.exit(1);
}

const { db } = createDb(DATABASE_URL);
const rows = await db
  .select({
    id: receiptItems.id,
    description: receiptItems.description,
    amount: receiptItems.amount,
  })
  .from(receiptItems);
const hits = rows.filter((r) => isBreakdownLine(r.description));
console.table(hits);

if (process.argv.includes("--apply") && hits.length > 0) {
  await db.delete(receiptItems).where(
    inArray(
      receiptItems.id,
      hits.map((h) => h.id),
    ),
  );
  console.log(`${hits.length} righe cancellate.`);
} else {
  console.log(`${hits.length} righe trovate. Aggiungi --apply per cancellarle.`);
}
process.exit(0);
