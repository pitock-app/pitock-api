export const DEFAULT_TIME_ZONE = "Europe/Rome";

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Offset in minuti del fuso rispetto a UTC all'istante dato (es. +120 per Roma d'estate). */
function offsetMinutes(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * ISO 8601 → Date. Senza fuso (data sola o data/ora locale) vale l'ora di Europe/Rome.
 * Restituisce `null` se la stringa non è una data valida.
 */
export function parseIsoInTimeZone(value: string, timeZone = DEFAULT_TIME_ZONE): Date | null {
  if (!ISO.test(value)) return null;
  // Rifiuta date inesistenti (es. 2026-02-30), che Date farebbe slittare al mese dopo.
  const [y, mo, d] = value.slice(0, 10).split("-").map(Number);
  const check = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 0));
  if (check.getUTCMonth() !== (mo ?? 1) - 1 || check.getUTCDate() !== d) return null;
  if (HAS_OFFSET.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const local = DATE_ONLY.test(value) ? `${value}T00:00:00` : value;
  const asUtc = new Date(`${local}Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  // Due passaggi: l'offset dipende dall'istante, che dipende dall'offset (cambio dell'ora).
  const first = new Date(asUtc.getTime() - offsetMinutes(timeZone, asUtc) * 60_000);
  return new Date(asUtc.getTime() - offsetMinutes(timeZone, first) * 60_000);
}

/** Primo istante del mese corrente nel fuso dato. */
export function startOfMonth(now: Date, timeZone = DEFAULT_TIME_ZONE): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return parseIsoInTimeZone(`${parts.year ?? "1970"}-${parts.month ?? "01"}-01`, timeZone) ?? now;
}

/**
 * Fine esclusiva di un intervallo: con la sola data (`2026-10-04`) comprende l'intera giornata
 * nel fuso dato (inizio del giorno dopo); con data e ora vale l'istante successivo.
 */
export function parseRangeEnd(value: string, timeZone = DEFAULT_TIME_ZONE): Date | null {
  if (!DATE_ONLY.test(value)) {
    const at = parseIsoInTimeZone(value, timeZone);
    return at ? new Date(at.getTime() + 1) : null;
  }
  if (!parseIsoInTimeZone(value, timeZone)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const next = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 0) + 1)).toISOString().slice(0, 10);
  return parseIsoInTimeZone(next, timeZone);
}
