/** true se l'errore (anche avvolto da Drizzle in `cause`) è una violazione di unicità. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 5; i++) {
    if ("code" in e && e.code === "23505") return true;
    e = "cause" in e ? e.cause : undefined;
  }
  return false;
}
