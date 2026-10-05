/**
 * Armonizzazione dei negozi: lo stesso esercente scritto in modi diversi ("IN'S SUPERMERCATO",
 * "IN's supermercato", "Lidl Italia S.r.l." / "LIDL") finisce sotto un unico nome.
 *
 * - Il nome di partenza è l'insegna letta dal modello (`merchant_brand`) o, se manca, il nome
 *   stampato.
 * - Stessa chiave normalizzata (minuscole, senza accenti, punteggiatura e forma societaria) →
 *   stesso negozio.
 * - La partita IVA unisce solo se è valida (cifra di controllo) **e** i nomi sono compatibili:
 *   da sola non basta, perché una cifra letta male o la P.IVA di un'altra azienda stampata sullo
 *   scontrino unirebbero negozi diversi.
 *
 * I dati salvati non cambiano: è solo il nome con cui si raggruppa e si mostra.
 */

export interface MerchantSource {
  name: string | null;
  brand: string | null;
  vat: string | null;
}

/** Forme societarie e parole che non distinguono un negozio. */
const LEGAL_FORMS = new Set([
  "srl",
  "srls",
  "spa",
  "snc",
  "sas",
  "sapa",
  "scarl",
  "scrl",
  "sc",
  "soc",
  "societa",
  "cooperativa",
  "unipersonale",
  "ditta",
]);

/** Forme societarie scritte con i punti o separate ("S.r.l.", "S. p. A."): si compattano prima. */
const DOTTED_FORMS =
  /\b(s\s*\.?\s*r\s*\.?\s*l\s*\.?\s*s?|s\s*\.?\s*p\s*\.?\s*a|s\s*\.?\s*n\s*\.?\s*c|s\s*\.?\s*a\s*\.?\s*s)\b\.?/gi;

const stripAccents = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Parole significative del nome, senza forma societaria. Se resterebbe vuoto (un nome fatto
 * solo di parole come "Società"), si tengono tutte.
 */
function tokens(text: string): string[] {
  const words = stripAccents(text.toLowerCase())
    .replace(DOTTED_FORMS, (form) => form.replace(/[\s.]/g, ""))
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const significant = words.filter((word) => !LEGAL_FORMS.has(word));
  return significant.length > 0 ? significant : words;
}

/** Chiave di confronto: "IN'S SUPERMERCATO" e "IN's supermercato" → "ins supermercato". */
export function merchantKey(text: string | null | undefined): string | null {
  const words = tokens(text ?? "");
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * Partita IVA italiana valida (11 cifre con la cifra di controllo giusta), normalizzata; null se
 * non lo è. Toglie "IT", spazi e punteggiatura.
 */
export function validVat(vat: string | null | undefined): string | null {
  const digits = (vat ?? "")
    .toUpperCase()
    .replace(/^\s*IT/, "")
    .replace(/[^0-9]/g, "");
  if (!/^\d{11}$/.test(digits) || /^0+$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const digit = Number(digits[i]);
    if (i % 2 === 0) sum += digit;
    else sum += digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[10]) ? digits : null;
}

/**
 * Nomi compatibili: le parole di uno sono contenute nell'altro ("lidl" in "lidl italia") o ne
 * condividono almeno metà. Serve a confermare un'unione per P.IVA, non a crearla.
 */
export function compatibleKeys(a: string, b: string): boolean {
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  const shared = [...left].filter((word) => right.has(word)).length;
  if (shared === 0) return false;
  return (
    shared === Math.min(left.size, right.size) || shared / Math.max(left.size, right.size) >= 0.5
  );
}

/** Nome leggibile: senza forma societaria; se è tutto maiuscolo, con le iniziali maiuscole. */
export function displayName(text: string): string {
  const withoutForm = text
    .replace(DOTTED_FORMS, "")
    .replace(/\b(srls?|spa|snc|sas)\b\.?/gi, "")
    .replace(/[\s,.-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const clean = withoutForm || text.trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .toLowerCase()
    .split(" ")
    .map((word, index) => {
      // Sigle con cifre ("U2", "A2A") restano maiuscole.
      if (/\d/.test(word)) return word.toUpperCase();
      // Articoli e preposizioni in minuscolo, tranne in testa: "Panetteria di Rago".
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      // Elisioni: "d'asporto" → "d'Asporto"; in testa "L'Angolo".
      const elided = /^([dl])'(\p{L})(.*)$/u.exec(word);
      if (elided && index > 0) {
        const [, article = "", first = "", rest = ""] = elided;
        return `${article}'${first.toUpperCase()}${rest}`;
      }
      return word.replace(
        /(^|[/-])(\p{L})/gu,
        (_, sep: string, letter: string) => sep + letter.toUpperCase(),
      );
    })
    .join(" ");
}

/** Parole che restano minuscole nei nomi riscritti. */
const SMALL_WORDS = new Set([
  "di",
  "da",
  "del",
  "dello",
  "della",
  "dei",
  "degli",
  "delle",
  "e",
  "ed",
  "il",
  "lo",
  "la",
  "i",
  "gli",
  "le",
  "a",
  "al",
  "alla",
  "ai",
  "alle",
  "in",
  "con",
  "per",
  "su",
  "sul",
  "sulla",
]);

/** Union-find minimale sugli indici dei negozi. */
function groups(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  return {
    find,
    union(a: number, b: number) {
      parent[find(a)] = find(b);
    },
  };
}

interface Entry {
  label: string;
  key: string;
  /** Chiave del nome stampato: unisce anche le righe con e senza insegna. */
  nameKey: string | null;
  vat: string | null;
  brand: boolean;
}

interface Variant {
  count: number;
  brand: boolean;
  mixedCase: boolean;
}

/**
 * Nome armonizzato di ogni negozio, nello stesso ordine di `sources`; null se il negozio non ha
 * nome. Per ogni gruppo vince l'insegna, poi la scrittura non tutta maiuscola, poi la più
 * frequente.
 */
export function harmonizeMerchants(sources: MerchantSource[]): (string | null)[] {
  const entries: (Entry | null)[] = sources.map((s) => {
    const label = s.brand?.trim() || s.name?.trim() || null;
    const key = merchantKey(label);
    return label && key
      ? {
          label,
          key,
          nameKey: merchantKey(s.name),
          vat: validVat(s.vat),
          brand: Boolean(s.brand?.trim()),
        }
      : null;
  });
  const uf = groups(sources.length);

  const byKey = new Map<string, number>();
  const byVat = new Map<string, { index: number; key: string }[]>();
  entries.forEach((entry, i) => {
    if (!entry) return;
    // Stessa insegna o stesso nome stampato → stesso negozio.
    for (const key of new Set([entry.key, entry.nameKey])) {
      if (!key) continue;
      const first = byKey.get(key);
      if (first === undefined) byKey.set(key, i);
      else uf.union(i, first);
    }
    if (entry.vat)
      byVat.set(entry.vat, [...(byVat.get(entry.vat) ?? []), { index: i, key: entry.key }]);
  });
  // Stessa P.IVA valida: si uniscono solo i nomi compatibili tra loro.
  for (const same of byVat.values()) {
    same.forEach((a, position) => {
      for (const b of same.slice(position + 1)) {
        if (uf.find(a.index) !== uf.find(b.index) && compatibleKeys(a.key, b.key)) {
          uf.union(a.index, b.index);
        }
      }
    });
  }

  const candidates = new Map<number, Map<string, Variant>>();
  entries.forEach((entry, i) => {
    if (!entry) return;
    const root = uf.find(i);
    const variants = candidates.get(root) ?? new Map<string, Variant>();
    const name = displayName(entry.label);
    const current = variants.get(name) ?? { count: 0, brand: false, mixedCase: false };
    variants.set(name, {
      count: current.count + 1,
      brand: current.brand || entry.brand,
      // Una scrittura con maiuscole e minuscole ("IN's") rispetta il marchio più del tutto maiuscolo.
      mixedCase: current.mixedCase || entry.label !== entry.label.toUpperCase(),
    });
    candidates.set(root, variants);
  });
  const chosen = new Map<number, string>();
  for (const [root, variants] of candidates) {
    const ranked = [...variants].sort(
      ([nameA, a], [nameB, b]) =>
        Number(b.brand) - Number(a.brand) ||
        Number(b.mixedCase) - Number(a.mixedCase) ||
        b.count - a.count ||
        nameA.length - nameB.length ||
        nameA.localeCompare(nameB),
    );
    const best = ranked[0];
    if (best) chosen.set(root, best[0]);
  }
  return entries.map((entry, i) => (entry ? (chosen.get(uf.find(i)) ?? null) : null));
}
