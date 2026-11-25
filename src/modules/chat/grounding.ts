/**
 * Controllo dei numeri nelle risposte dell'assistente: ogni numero del testo deve comparire
 * nei dati (risultati e argomenti degli strumenti, messaggi dell'utente), al più arrotondato.
 */

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Interpretazioni possibili di un numero scritto all'italiana o all'inglese ("1.234,5", "12.50"). */
export function readings(token: string): number[] {
  const dot = token.lastIndexOf(".");
  const comma = token.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    // Entrambi i separatori: l'ultimo è quello decimale.
    const decimal = dot > comma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    return [Number(token.split(thousands).join("").replace(decimal, "."))];
  }
  const sep = dot >= 0 ? "." : comma >= 0 ? "," : null;
  if (!sep) return [Number(token)];
  const parts = token.split(sep);
  const out: number[] = [];
  if (parts.length === 2) out.push(Number(parts.join(".")));
  if (parts.slice(1).every((p) => p.length === 3)) out.push(Number(parts.join("")));
  return out;
}

const numbersIn = (text: string) => (text.match(NUMBER) ?? []).flatMap(readings);

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

// shortcut: gli interi fino a 10 passano sempre (conteggi a parole, "3 prodotti"); restringere se l'assistente li inventa.
const SMALL_INTEGER = 10;

/** Numeri del testo che non hanno riscontro nelle fonti (vuoto = risposta verificata). */
export function ungroundedNumbers(text: string, sources: string[]): string[] {
  const allowed = sources.flatMap(numbersIn);
  const grounded = (value: number) =>
    (Number.isInteger(value) && value <= SMALL_INTEGER) ||
    allowed.some((a) => [0, 1, 2].some((d) => Math.abs(round(a, d) - value) < 1e-9));
  return [...new Set((text.match(NUMBER) ?? []).filter((t) => !readings(t).some(grounded)))];
}
