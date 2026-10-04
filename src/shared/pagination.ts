import { z } from "@hono/zod-openapi";
import { AppError } from "./errors.js";

export const PaginationQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Cursor {
  createdAt: Date;
  id: string;
}

const CursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

/** Cursore opaco: base64url di `{ t: createdAt, id }`, ordinamento (created_at desc, id desc). */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.createdAt.toISOString(), id: c.id })).toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAt: new Date(parsed.t), id: parsed.id };
  } catch {
    throw new AppError("VALIDATION_ERROR", "Cursore non valido");
  }
}

/** Da `limit + 1` righe ricava la pagina e il cursore successivo. */
export function toPage<T extends Cursor>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last) : null;
  return { items, nextCursor };
}
