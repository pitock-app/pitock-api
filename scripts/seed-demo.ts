import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb } from "../src/infra/db/client.js";
import { extractions, receiptItems, receiptsRaw } from "../src/infra/db/schema/index.js";
import type {
  Category,
  PaymentMethod,
  SizeUnit,
} from "../src/modules/extraction/extraction.schema.js";
import { createStatsRepo } from "../src/modules/stats/stats.repo.js";
import { parseIsoInTimeZone } from "../src/shared/dates.js";

/**
 * Utente demo con circa un anno di spese di una persona media italiana (single, Bologna,
 * mutuo, auto a benzina). Idempotente: crea l'utente se manca, ne reimposta la password,
 * cancella i suoi scontrini e li rigenera, poi ricalcola `stats_monthly`.
 *
 *   pnpm seed:demo
 *
 * Servono `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Email, password e data
 * finale si cambiano con `DEMO_EMAIL`, `DEMO_PASSWORD` e `DEMO_END` (YYYY-MM-DD, default oggi).
 */

const EMAIL = process.env.DEMO_EMAIL ?? "demo@demo.it";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Passverydiff01=";
const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Servono DATABASE_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

// --- Generatore pseudo-casuale con seme fisso: stessi dati a ogni esecuzione. ---

let seed = 20251006;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const between = (min: number, max: number) => min + rand() * (max - min);
const int = (min: number, max: number) => Math.floor(between(min, max + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Prezzo "da cartellino": finisce in ,x9 o ,x5. */
const shelf = (n: number) => Math.max(0.19, Math.round(n * 10) / 10 - (chance(0.7) ? 0.01 : 0.05));

// --- Esercenti ---

interface Merchant {
  name: string;
  brand: string | null;
  vat: string;
  address: string;
}

/** Partita IVA con cifra di controllo valida, così l'armonizzazione dei negozi la usa. */
function fakeVat(): string {
  const digits = Array.from({ length: 10 }, () => int(0, 9));
  digits[0] = int(0, 1);
  let sum = 0;
  digits.forEach((d, i) => {
    if (i % 2 === 0) sum += d;
    else sum += d * 2 > 9 ? d * 2 - 9 : d * 2;
  });
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

const m = (name: string, brand: string | null, address: string): Merchant => ({
  name,
  brand,
  vat: fakeVat(),
  address,
});

const M = {
  esselunga: m("ESSELUNGA S.P.A.", "Esselunga", "Via Emilia Levante 12, 40139 Bologna BO"),
  coop: m("COOP ALLEANZA 3.0 SOC. COOP.", "Coop", "Via Massarenti 108, 40138 Bologna BO"),
  conad: m("CONAD CITY - SUPERMERCATI EMILIA SRL", "Conad", "Via San Vitale 45, 40125 Bologna BO"),
  lidl: m("LIDL ITALIA S.R.L.", "Lidl", "Via Mattei 30, 40138 Bologna BO"),
  carrefour: m("GS S.P.A.", "Carrefour Express", "Via Mazzini 88, 40137 Bologna BO"),
  forno: m("FORNO BRISA DI ROSSI SNC", "Forno Brisa", "Via San Felice 91, 40122 Bologna BO"),
  mercato: m("ORTOFRUTTA BERTI MARCO", null, "Mercato di Via Albani, 40129 Bologna BO"),
  macelleria: m("MACELLERIA GIOVANNINI SRL", null, "Via Mazzini 52, 40137 Bologna BO"),
  bar: m("BAR CENTRALE DI LUCA E ANNA SNC", "Bar Centrale", "Via Mazzini 61, 40137 Bologna BO"),
  barUfficio: m("CAFFÈ ROVERI SRL", "Caffè Roveri", "Via Stalingrado 37, 40128 Bologna BO"),
  pranzo: m("LA PAUSA SRLS", "La Pausa Bistrot", "Via Stalingrado 41, 40128 Bologna BO"),
  piadineria: m("PIADINERIA DA MIRKO", null, "Via Libia 22, 40138 Bologna BO"),
  pizzeria: m("PIZZERIA DA ROCCO SAS", "Da Rocco", "Via Fondazza 18, 40125 Bologna BO"),
  trattoria: m("TRATTORIA DEL ROSSO SRL", "Trattoria del Rosso", "Via Righi 30, 40126 Bologna BO"),
  sushi: m("SAKURA SUSHI SRL", "Sakura", "Via Saragozza 64, 40123 Bologna BO"),
  burger: m("MOLLY BURGER SRLS", null, "Via Zamboni 11, 40126 Bologna BO"),
  deliveroo: m("DELIVEROO ITALY S.R.L.", "Deliveroo", "Via Carlo Bo 11, 20143 Milano MI"),
  gelateria: m(
    "GELATERIA LA SORBETTERIA SNC",
    "La Sorbetteria",
    "Via Castiglione 44, 40124 Bologna BO",
  ),
  eni: m("ENILIVE STATION BOLOGNA EST", "Enilive", "Via Emilia Levante 210, 40139 Bologna BO"),
  q8: m("KUWAIT PETROLEUM ITALIA SPA", "Q8", "Via Massarenti 300, 40138 Bologna BO"),
  ip: m("ITALIANA PETROLI SPA", "IP", "Viale Lenin 40, 40138 Bologna BO"),
  tamoil: m("TAMOIL ITALIA SPA", "Tamoil", "Via Marco Polo 15, 40131 Bologna BO"),
  mutuo: m("INTESA SANPAOLO S.P.A.", "Intesa Sanpaolo", "Piazza San Carlo 156, 10121 Torino TO"),
  condominio: m("STUDIO AMMINISTRAZIONI BERTOCCHI", null, "Via Libia 5, 40138 Bologna BO"),
  enel: m("ENEL ENERGIA S.P.A.", "Enel Energia", "Viale Regina Margherita 125, 00198 Roma RM"),
  hera: m("HERA COMM S.P.A.", "Hera Comm", "Via Molino Rosso 8, 40026 Imola BO"),
  heraAcqua: m("HERA S.P.A. - SERVIZIO IDRICO", "Hera", "Viale Berti Pichat 2/4, 40127 Bologna BO"),
  tari: m("COMUNE DI BOLOGNA - TARI", null, "Piazza Maggiore 6, 40124 Bologna BO"),
  tim: m("TIM S.P.A.", "TIM", "Via Gaetano Negri 1, 20123 Milano MI"),
  iliad: m("ILIAD ITALIA S.P.A.", "Iliad", "Viale Francesco Restelli 1/A, 20124 Milano MI"),
  assicurazione: m("GENIALLOYD S.P.A.", "Genialloyd", "Piazza Tre Torri 3, 20145 Milano MI"),
  aci: m("ACI - TASSA AUTOMOBILISTICA REGIONALE", null, "Pagamento pagoPA"),
  officina: m("AUTOFFICINA F.LLI MARCHI SNC", null, "Via del Lavoro 14, 40127 Bologna BO"),
  gommista: m("PNEUS SERVICE SRL", null, "Via Larga 9, 40138 Bologna BO"),
  telepass: m("TELEPASS S.P.A.", "Telepass", "Via Laurentina 449, 00142 Roma RM"),
  easypark: m("EASYPARK ITALIA SRL", "EasyPark", "Via Sciesa 13, 20135 Milano MI"),
  autolavaggio: m("AUTOLAVAGGIO STELLA SRL", null, "Via Michelino 60, 40127 Bologna BO"),
  farmacia: m("FARMACIA COMUNALE N. 8", null, "Via Mazzini 102, 40138 Bologna BO"),
  farmacia2: m("FARMACIA SAN VITALE DR. NERI", null, "Via San Vitale 70, 40125 Bologna BO"),
  ausl: m("AZIENDA USL DI BOLOGNA", "AUSL Bologna", "Via Castiglione 29, 40124 Bologna BO"),
  dentista: m("STUDIO DENTISTICO DOTT. FERRARI", null, "Via Murri 48, 40137 Bologna BO"),
  ottico: m("OTTICA VEDO BENE SRL", null, "Via Indipendenza 33, 40121 Bologna BO"),
  zara: m("ZARA ITALIA S.R.L.", "Zara", "Via Rizzoli 9, 40125 Bologna BO"),
  ovs: m("OVS S.P.A.", "OVS", "Via Indipendenza 59, 40121 Bologna BO"),
  decathlon: m("DECATHLON ITALIA S.R.L.", "Decathlon", "Via Roveri 4, 40138 Bologna BO"),
  scarpe: m("FOOT LOCKER ITALY SRL", "Foot Locker", "Via Rizzoli 21, 40125 Bologna BO"),
  amazon: m(
    "AMAZON EU S.A R.L., SUCCURSALE ITALIANA",
    "Amazon",
    "Viale Monte Grappa 3/5, 20124 Milano MI",
  ),
  mediaworld: m("MEDIAMARKET S.P.A.", "MediaWorld", "Via Larga 10, 40138 Bologna BO"),
  apple: m("APPLE DISTRIBUTION INTERNATIONAL LTD", "Apple", "Hollyhill Industrial Estate, Cork IE"),
  netflix: m("NETFLIX INTERNATIONAL B.V.", "Netflix", "Karperstraat 8-10, Amsterdam NL"),
  spotify: m("SPOTIFY AB", "Spotify", "Regeringsgatan 19, Stoccolma SE"),
  palestra: m("CENTRO SPORTIVO VIRGIN ACTIVE", "Virgin Active", "Via Larga 6, 40138 Bologna BO"),
  cinema: m("CINEMA ODEON SRL", "Cinema Odeon", "Via Mascarella 3, 40126 Bologna BO"),
  libreria: m(
    "LA FELTRINELLI LIBRI E MUSICA SPA",
    "laFeltrinelli",
    "Piazza Ravegnana 1, 40126 Bologna BO",
  ),
  ticketone: m("TICKETONE S.P.A.", "TicketOne", "Via Vittor Pisani 19, 20124 Milano MI"),
  trenitalia: m("TRENITALIA S.P.A.", "Trenitalia", "Piazza della Croce Rossa 1, 00161 Roma RM"),
  tper: m("TPER S.P.A.", "Tper", "Via di Saliceto 3, 40128 Bologna BO"),
  booking: m("HOTEL BAROCCO LECCE SRL", "Hotel Barocco", "Via Palmieri 12, 73100 Lecce LE"),
  lido: m("LIDO SAN FOCA SRL", null, "Lungomare San Foca, 73026 Melendugno LE"),
  ristoLecce: m("OSTERIA DEGLI SPIRITI", null, "Via Cesare Battisti 4, 73100 Lecce LE"),
  skipass: m("CIMONE SCI S.R.L.", "Skipass Cimone", "Passo del Lupo, 41029 Sestola MO"),
  ikea: m("IKEA ITALIA RETAIL S.R.L.", "IKEA", "Via Lirone 3, 40068 Casalecchio di Reno BO"),
  leroy: m("LEROY MERLIN ITALIA SRL", "Leroy Merlin", "Via Larga 25, 40138 Bologna BO"),
  idraulico: m("TERMOIDRAULICA BASSI LUCA", null, "Via Bentini 30, 40128 Bologna BO"),
  tigota: m("GOTTARDO S.P.A.", "Tigotà", "Via Massarenti 62, 40138 Bologna BO"),
  barbiere: m("BARBERIA DA NINO", null, "Via Mazzini 70, 40137 Bologna BO"),
  lavanderia: m("LAVASECCO MAZZINI", null, "Via Mazzini 33, 40137 Bologna BO"),
  poste: m("POSTE ITALIANE S.P.A.", "Poste Italiane", "Via Mazzini 108, 40138 Bologna BO"),
  caf: m("CAF ACLI BOLOGNA SRL", null, "Via Lame 116, 40122 Bologna BO"),
  regali: m("COIN S.P.A.", "Coin", "Via Rizzoli 2, 40125 Bologna BO"),
  fiorista: m("FIORI DI GIULIA", null, "Via Mazzini 12, 40137 Bologna BO"),
  emergency: m("EMERGENCY ONG ONLUS", "Emergency", "Via Santa Croce 19, 20122 Milano MI"),
} satisfies Record<string, Merchant>;

// --- Righe e scontrini ---

interface Item {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  vatRate: number | null;
  category: Category | null;
  normalizedName?: string | null;
  brand?: string | null;
  size?: number | null;
  sizeUnit?: SizeUnit | null;
}

interface Receipt {
  at: Date;
  merchant: Merchant;
  category: Category;
  payment: PaymentMethod;
  items: Item[];
  notes?: string;
}

const receipts: Receipt[] = [];

const line = (
  description: string,
  amount: number,
  vatRate: number | null,
  category: Category | null = null,
  quantity = 1,
): Item => ({
  description,
  quantity,
  unitPrice: round2(amount / quantity),
  amount: round2(amount),
  vatRate,
  category,
});

function add(
  day: Date,
  time: string,
  merchant: Merchant,
  category: Category,
  payment: PaymentMethod,
  items: Item[],
  notes?: string,
) {
  const at = parseIsoInTimeZone(`${day.toISOString().slice(0, 10)}T${time}`);
  if (!at) throw new Error(`data non valida: ${day.toISOString()} ${time}`);
  receipts.push({ at, merchant, category, payment, items, ...(notes ? { notes } : {}) });
}

/** Prodotto venduto a peso: quantità in kg e prezzo al kg. */
const weighed = (description: string, normalizedName: string, kg: number, perKg: number): Item => {
  const quantity = round2(kg);
  const unitPrice = round2(perKg);
  return {
    description,
    quantity,
    unitPrice,
    amount: round2(quantity * unitPrice),
    vatRate: 4,
    category: "alimentari",
    normalizedName,
    brand: null,
    size: null,
    sizeUnit: null,
  };
};

const hhmm = (fromHour: number, toHour: number) => {
  const minutes = int(fromHour * 60, toHour * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

// --- Spesa alimentare: catalogo con prezzi base, che crescono un po' nel corso dell'anno. ---

interface Product {
  label: string;
  name: string;
  brand: string | null;
  size: number | null;
  unit: SizeUnit | null;
  price: number;
  vat: number;
  category: Category;
  /** Probabilità di finire nella spesa grande. */
  p: number;
  /** Venduto a peso: quantità in kg e prezzo al kg. */
  weighed?: boolean;
}

const P = (
  label: string,
  name: string,
  brand: string | null,
  size: number | null,
  unit: SizeUnit | null,
  price: number,
  p: number,
  extra: Partial<Product> = {},
): Product => ({
  label,
  name,
  brand,
  size,
  unit,
  price,
  vat: 4,
  category: "alimentari",
  p,
  ...extra,
});

const CATALOG: Product[] = [
  P("LATTE PS GRANAROLO 1L", "Latte parzialmente scremato", "Granarolo", 1, "l", 1.69, 0.9),
  P("PANE COMUNE", "Pane comune", null, 0.5, "kg", 2.2, 0.7),
  P("UOVA FRESCHE X6", "Uova", "Coop", 6, "pz", 2.29, 0.5),
  P("PASTA BARILLA SPAGHETTI N5", "Spaghetti", "Barilla", 500, "g", 1.19, 0.6),
  P("PASTA DE CECCO PENNE", "Penne rigate", "De Cecco", 500, "g", 1.69, 0.35),
  P("RISO SCOTTI ARBORIO", "Riso Arborio", "Scotti", 1, "kg", 3.29, 0.15),
  P("PASSATA MUTTI", "Passata di pomodoro", "Mutti", 700, "g", 1.49, 0.55, { vat: 10 }),
  P("OLIO EVO CARAPELLI 1L", "Olio extravergine di oliva", "Carapelli", 1, "l", 9.49, 0.12),
  P("PARMIGIANO REGG. 24M", "Parmigiano Reggiano", null, 300, "g", 6.9, 0.3),
  P("MOZZARELLA S.LUCIA", "Mozzarella", "Galbani", 125, "g", 0.99, 0.5),
  P("YOGURT MULLER BIANCO X2", "Yogurt bianco", "Müller", 250, "g", 1.39, 0.45),
  P("PROSC. COTTO ROVAGNATI", "Prosciutto cotto", "Rovagnati", 120, "g", 2.79, 0.4, { vat: 10 }),
  P("PROSC. CRUDO PARMA", "Prosciutto crudo", null, 100, "g", 3.49, 0.25, { vat: 10 }),
  P("PETTO DI POLLO AIA", "Petto di pollo", "Aia", 500, "g", 5.9, 0.45, { vat: 10 }),
  P("MACINATO BOVINO", "Carne macinata di bovino", null, 400, "g", 5.2, 0.3, { vat: 10 }),
  P("FILETTI DI MERLUZZO FINDUS", "Filetti di merluzzo surgelati", "Findus", 400, "g", 5.49, 0.15, {
    vat: 10,
  }),
  P("TONNO RIO MARE X3", "Tonno all'olio", "Rio Mare", 240, "g", 4.29, 0.35, { vat: 10 }),
  P("BANANE", "Banane", null, null, null, 1.79, 0.7, { weighed: true }),
  P("MELE GOLDEN", "Mele", null, null, null, 2.19, 0.6, { weighed: true }),
  P("ARANCE TAROCCO", "Arance", null, null, null, 1.99, 0.35, { weighed: true }),
  P("POMODORI CILIEGINO", "Pomodori", null, 500, "g", 2.49, 0.5),
  P("INSALATA BONDUELLE", "Insalata in busta", "Bonduelle", 125, "g", 1.89, 0.55),
  P("ZUCCHINE", "Zucchine", null, null, null, 2.49, 0.4, { weighed: true }),
  P("PATATE", "Patate", null, 1.5, "kg", 2.29, 0.3),
  P("CAROTE", "Carote", null, 1, "kg", 1.29, 0.3),
  P("BISCOTTI MULINO BIANCO", "Biscotti", "Mulino Bianco", 350, "g", 2.49, 0.35),
  P("FETTE BISCOTTATE BARILLA", "Fette biscottate", "Barilla", 315, "g", 1.89, 0.2),
  P("CAFFE LAVAZZA ORO 250G", "Caffè macinato", "Lavazza", 250, "g", 4.99, 0.3, { vat: 22 }),
  P("NUTELLA 450G", "Crema spalmabile", "Ferrero", 450, "g", 4.29, 0.12, { vat: 10 }),
  P("ACQUA SANT'ANNA 6X1,5L", "Acqua naturale", "Sant'Anna", 9, "l", 2.34, 0.6, { vat: 22 }),
  P("BIRRA MORETTI 3X33", "Birra", "Moretti", 99, "cl", 3.49, 0.25, { vat: 22 }),
  P("VINO SANGIOVESE DOC", "Vino rosso", "Cantina Forlì", 75, "cl", 5.9, 0.2, { vat: 22 }),
  P("PIZZA SURG. CAMEO", "Pizza surgelata", "Cameo", 390, "g", 3.29, 0.2, { vat: 10 }),
  P("TORTELLINI GIOVANNI RANA", "Tortellini", "Giovanni Rana", 250, "g", 3.19, 0.3),
  P("SUCCO YOGA ACE", "Succo di frutta", "Yoga", 1, "l", 1.59, 0.15, { vat: 10 }),
  P("DETERSIVO DASH LIQ.", "Detersivo lavatrice", "Dash", 1.3, "l", 7.99, 0.12, {
    vat: 22,
    category: "casa",
  }),
  P("CARTA IGIEN. SCOTTEX X4", "Carta igienica", "Scottex", 4, "pz", 3.19, 0.2, {
    vat: 22,
    category: "casa",
  }),
  P("SAPONE PIATTI SVELTO", "Detersivo piatti", "Svelto", 1, "l", 2.29, 0.12, {
    vat: 22,
    category: "casa",
  }),
  P("SACCHI SPAZZATURA", "Sacchi per la spazzatura", null, 20, "pz", 1.99, 0.1, {
    vat: 22,
    category: "casa",
  }),
  P("DENTIFRICIO AZ", "Dentifricio", "AZ", 75, "ml", 2.49, 0.08, { vat: 22, category: "salute" }),
  P("SHOPPER BIODEGRADABILE", "Sacchetto", null, 1, "pz", 0.15, 0.6, {
    vat: 22,
    category: "altro",
  }),
];

/** Fattore di prezzo per insegna (discount più economico). */
const STORE_FACTOR = new Map<Merchant, number>([
  [M.esselunga, 1.05],
  [M.coop, 1.0],
  [M.conad, 1.03],
  [M.lidl, 0.84],
  [M.carrefour, 1.08],
]);

const START = new Date(Date.UTC(2025, 9, 6));
const END = process.env.DEMO_END
  ? new Date(`${process.env.DEMO_END}T00:00:00Z`)
  : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const monthsFromStart = (day: Date) => (day.getTime() - START.getTime()) / (30.4 * 86_400_000);

function groceryItems(day: Date, store: Merchant, size: "big" | "small"): Item[] {
  // Inflazione alimentare ~2,5% annuo.
  const inflation = 1 + 0.0021 * monthsFromStart(day);
  const factor = (STORE_FACTOR.get(store) ?? 1) * inflation;
  const scale = size === "big" ? 1 : 0.3;
  const chosen = CATALOG.filter((p) => chance(Math.min(1, p.p * scale)));
  if (chosen.length === 0) chosen.push(CATALOG[0] as Product);
  return chosen.map((p) => {
    const brand = store === M.lidl && p.brand ? "Lidl" : p.brand;
    const unitPrice = shelf(p.price * factor);
    if (p.weighed) return weighed(p.label, p.name, between(0.6, 1.8), unitPrice);
    const qty = p.price < 2.5 && chance(0.3) ? int(2, 3) : 1;
    return {
      description:
        store === M.lidl && p.brand
          ? p.label.replace(p.brand.toUpperCase(), "").trim() || p.label
          : p.label,
      quantity: qty,
      unitPrice,
      amount: round2(qty * unitPrice),
      vatRate: p.vat,
      category: p.category,
      normalizedName: p.name,
      brand,
      size: p.size,
      sizeUnit: p.unit,
    };
  });
}

// --- Calendario di un anno ---

const BAR_MENU = [
  ["CAFFÈ", 1.3],
  ["CAPPUCCINO", 1.7],
  ["CORNETTO", 1.4],
  ["SPREMUTA", 3.5],
  ["CAFFÈ DECAF.", 1.4],
] as const;

let nextFuel = new Date(START.getTime() + 3 * 86_400_000);
let nextHaircut = new Date(START.getTime() + 12 * 86_400_000);
let nextPharmacy = new Date(START.getTime() + 9 * 86_400_000);

/** Bollette con importi stagionali: gas alto d'inverno, luce più alta d'estate (condizionatore). */
const GAS_BY_MONTH: Record<number, number> = { 0: 238, 2: 196, 4: 92, 6: 41, 8: 36, 10: 128 };
const POWER_BY_MONTH: Record<number, number> = { 1: 96, 3: 82, 5: 88, 7: 124, 9: 92, 11: 98 };

for (let day = new Date(START); day <= END; day = new Date(day.getTime() + 86_400_000)) {
  const dow = day.getUTCDay(); // 0 domenica
  const dom = day.getUTCDate();
  const month = day.getUTCMonth();
  const weekday = dow >= 1 && dow <= 5;
  const onHoliday = month === 7 && dom >= 9 && dom <= 18; // ferie in Puglia
  const inflation = 1 + 0.0021 * monthsFromStart(day);

  // Casa: mutuo, condominio.
  if (dom === 1) {
    add(
      day,
      "08:00",
      M.mutuo,
      "casa",
      "altro",
      [line(`Rata mutuo prima casa n. ${128 + Math.round(monthsFromStart(day))}`, 612.37, null)],
      "Addebito automatico su conto corrente",
    );
  }
  if (dom === 10 && [0, 3, 6, 9].includes(month)) {
    add(
      day,
      "10:00",
      M.condominio,
      "casa",
      "altro",
      [
        line("Quota condominiale trimestrale", 186, null),
        line("Fondo manutenzione straordinaria", month === 3 ? 120 : 0, null),
      ].filter((i) => i.amount > 0),
      "Bonifico",
    );
  }

  // Bollette.
  if (dom === 16 && GAS_BY_MONTH[month] !== undefined) {
    const total = round2((GAS_BY_MONTH[month] ?? 0) * between(0.92, 1.08));
    add(
      day,
      "09:00",
      M.hera,
      "servizi",
      "altro",
      [
        line("Fornitura gas naturale - bolletta bimestrale", round2(total * 0.82), 10),
        line("Oneri di sistema e trasporto", round2(total * 0.18), 10),
      ],
      "Addebito SEPA",
    );
  }
  if (dom === 20 && POWER_BY_MONTH[month] !== undefined) {
    const total = round2((POWER_BY_MONTH[month] ?? 0) * between(0.92, 1.08));
    add(
      day,
      "09:00",
      M.enel,
      "servizi",
      "altro",
      [
        line("Spesa per la materia energia", round2(total * 0.62), 10),
        line("Trasporto e gestione contatore", round2(total * 0.24), 10),
        line("Oneri di sistema", round2(total * 0.14), 10),
      ],
      "Addebito SEPA",
    );
  }
  if (dom === 25 && [1, 4, 7, 10].includes(month)) {
    add(
      day,
      "09:00",
      M.heraAcqua,
      "servizi",
      "altro",
      [line("Servizio idrico integrato - trimestre", round2(between(48, 66)), 10)],
      "Addebito SEPA",
    );
  }
  if ((month === 4 && dom === 31) || (month === 10 && dom === 30)) {
    add(
      day,
      "11:00",
      M.tari,
      "servizi",
      "altro",
      [line(`TARI ${month === 4 ? "acconto" : "saldo"} 2026`, month === 4 ? 112 : 108, null)],
      "Pagamento pagoPA",
    );
  }
  if (dom === 5) {
    add(
      day,
      "07:30",
      M.tim,
      "servizi",
      "altro",
      [line("TIM WiFi Power Fibra - canone mensile", 29.9, 22)],
      "Addebito SEPA",
    );
  }
  if (dom === 14) {
    add(day, "07:30", M.iliad, "servizi", "carta", [
      line("Offerta Giga 150 - rinnovo mensile", 9.99, 22),
    ]);
  }

  // Abbonamenti.
  if (dom === 8)
    add(day, "06:00", M.netflix, "svago", "carta", [
      line(
        "Netflix Standard - abbonamento mensile",
        month >= 2 || day.getUTCFullYear() > 2025 ? 13.99 : 12.99,
        22,
      ),
    ]);
  if (dom === 22)
    add(day, "06:00", M.spotify, "svago", "carta", [line("Spotify Premium Individual", 11.99, 22)]);
  if (dom === 3)
    add(day, "06:00", M.apple, "tecnologia", "carta", [line("iCloud+ 50 GB", 0.99, 22)]);
  if (dom === 2 && month !== 7)
    add(day, "07:00", M.palestra, "svago", "carta", [
      line("Quota mensile abbonamento Club", 59, 22),
    ]);

  // Auto: carburante ogni 9-13 giorni, Telepass, scadenze annuali.
  if (day >= nextFuel && !onHoliday) {
    const station = pick([M.eni, M.eni, M.q8, M.ip, M.tamoil]);
    const pricePerLiter = round2(
      between(1.74, 1.86) + (month === 7 ? 0.05 : 0) + 0.003 * monthsFromStart(day),
    );
    const euros = pick([40, 50, 50, 55, 60, 60, 65]);
    const liters = Math.round((euros / pricePerLiter) * 100) / 100;
    add(day, hhmm(7, 20), station, "carburante", chance(0.8) ? "carta" : "bancomat", [
      {
        description: "BENZINA SELF",
        quantity: liters,
        unitPrice: pricePerLiter,
        amount: euros,
        vatRate: 22,
        category: "carburante",
        normalizedName: "Benzina",
        brand: null,
        size: null,
        sizeUnit: "l",
      },
    ]);
    nextFuel = new Date(day.getTime() + int(9, 13) * 86_400_000);
  }
  if (dom === 12) {
    const tolls = round2(between(12, 38) + (month === 7 ? 64 : 0) + (month === 1 ? 18 : 0));
    add(
      day,
      "08:00",
      M.telepass,
      "trasporti",
      "altro",
      [
        line("Pedaggi autostradali periodo precedente", tolls, null),
        line("Canone Telepass", 3.9, 22),
      ],
      "Addebito su conto",
    );
  }
  if (month === 10 && dom === 15) {
    add(day, "10:12", M.assicurazione, "trasporti", "carta", [
      line("Polizza RC Auto - rinnovo annuale (Fiat Panda 1.2)", 486.5, null),
      line("Garanzia assistenza stradale", 28, null),
    ]);
  }
  if (month === 1 && dom === 27) {
    add(day, "18:40", M.aci, "trasporti", "carta", [
      line("Tassa automobilistica - bollo auto 2026", 197.84, null),
      line("Commissione pagoPA", 1.5, null),
    ]);
  }
  if ((month === 10 && dom === 8) || (month === 3 && dom === 11)) {
    add(day, "09:15", M.gommista, "trasporti", "bancomat", [
      line(
        month === 10
          ? "Cambio gomme invernali e equilibratura"
          : "Cambio gomme estive e equilibratura",
        50,
        22,
      ),
      line("Deposito pneumatici stagionale", 30, 22),
    ]);
  }
  if (month === 3 && dom === 23) {
    add(day, "08:30", M.officina, "trasporti", "carta", [
      line("Tagliando con olio motore 5W40", 168, 22),
      line("Filtro olio e filtro aria", 46, 22),
      line("Pastiglie freno anteriori", 92, 22),
      line("Manodopera", 65, 22),
    ]);
  }
  if (month === 5 && dom === 17) {
    add(day, "14:30", M.officina, "trasporti", "bancomat", [
      line("Revisione periodica veicolo", 79.02, 22),
    ]);
  }
  if (dow === 6 && chance(0.12)) {
    add(day, hhmm(10, 17), M.autolavaggio, "trasporti", "contanti", [
      line("Lavaggio esterno e interni", pick([10, 12, 15]), 22),
    ]);
  }
  if (weekday && chance(0.1)) {
    add(day, hhmm(9, 19), M.easypark, "trasporti", "carta", [
      line("Sosta strisce blu - Zona centro", round2(between(1.5, 6)), 22),
    ]);
  }
  if (!onHoliday && weekday && chance(0.03)) {
    add(day, hhmm(7, 9), M.tper, "trasporti", "carta", [
      line("Biglietto urbano 75 minuti", 2.3, 10, null, 2),
    ]);
  }

  // Spesa alimentare.
  if (!onHoliday && dow === 6) {
    const store = pick([M.esselunga, M.esselunga, M.coop, M.conad, M.lidl]);
    add(
      day,
      hhmm(9, 12),
      store,
      "alimentari",
      pick(["carta", "carta", "bancomat"]),
      groceryItems(day, store, "big"),
    );
  }
  if (!onHoliday && dow === 3 && chance(0.65)) {
    const store = pick([M.lidl, M.carrefour, M.conad]);
    add(
      day,
      hhmm(18, 20),
      store,
      "alimentari",
      pick(["carta", "bancomat", "contanti"]),
      groceryItems(day, store, "small"),
    );
  }
  if (!onHoliday && dow === 2 && chance(0.3)) {
    add(day, hhmm(8, 13), M.mercato, "alimentari", "contanti", [
      weighed("FRUTTA DI STAGIONE", "Frutta", between(1, 2.5), 2.5 * inflation),
      weighed("VERDURA MISTA", "Verdura", between(0.8, 2), 2.9 * inflation),
    ]);
  }
  if (!onHoliday && (dow === 0 || dow === 4) && chance(0.35)) {
    add(day, hhmm(8, 11), M.forno, "alimentari", pick(["contanti", "carta"]), [
      {
        description: "PANE A LIEVITO MADRE",
        quantity: 1,
        unitPrice: shelf(3.8 * inflation),
        amount: shelf(3.8 * inflation),
        vatRate: 4,
        category: "alimentari",
        normalizedName: "Pane a lievito madre",
        brand: null,
        size: 0.5,
        sizeUnit: "kg",
      },
      ...(chance(0.5) ? [line("FOCACCIA", 3.5, 10, "alimentari")] : []),
    ]);
  }
  if (!onHoliday && dow === 5 && chance(0.18)) {
    add(day, hhmm(17, 19), M.macelleria, "alimentari", "bancomat", [
      line("FETTINE DI VITELLO", round2(between(7, 12)), 10, "alimentari"),
      line("SALSICCIA", round2(between(4, 6)), 10, "alimentari"),
    ]);
  }

  // Bar e pranzi in settimana.
  if (weekday && !onHoliday && chance(0.5)) {
    const items = [pick(BAR_MENU), ...(chance(0.6) ? [BAR_MENU[2]] : [])].map(([d, price]) =>
      line(d, price, 10),
    );
    add(
      day,
      hhmm(7, 9),
      pick([M.bar, M.bar, M.barUfficio]),
      "ristorazione",
      chance(0.6) ? "contanti" : "carta",
      items,
    );
  }
  if (weekday && !onHoliday && chance(0.22)) {
    const place = pick([M.pranzo, M.pranzo, M.piadineria]);
    const items =
      place === M.piadineria
        ? [line("PIADINA CRUDO SQUACQUERONE RUCOLA", 7.5, 10), line("ACQUA NATURALE 0,5L", 1.2, 10)]
        : [
            line(pick(["PRIMO DEL GIORNO", "INSALATONA", "PIATTO UNICO"]), pick([9, 10, 11]), 10),
            line("ACQUA", 1.5, 10),
            line("CAFFÈ", 1.3, 10),
          ];
    add(day, hhmm(12.5, 14), place, "ristorazione", "carta", items);
  }

  // Cene fuori e consegne.
  if (!onHoliday && (dow === 5 || dow === 6) && chance(0.4)) {
    const place = pick([M.pizzeria, M.pizzeria, M.trattoria, M.sushi, M.burger]);
    const people = int(1, 2);
    const menu: Record<string, [string, number][]> = {
      [M.pizzeria.name]: [
        ["PIZZA MARGHERITA", 7.5],
        ["PIZZA DIAVOLA", 9],
        ["BIRRA MEDIA", 5.5],
        ["COPERTO", 2],
      ],
      [M.trattoria.name]: [
        ["TAGLIATELLE AL RAGÙ", 13],
        ["TORTELLINI IN BRODO", 15],
        ["COTOLETTA ALLA BOLOGNESE", 18],
        ["CALICE SANGIOVESE", 5],
        ["COPERTO", 2.5],
      ],
      [M.sushi.name]: [
        ["MENU ALL YOU CAN EAT CENA", 27.9],
        ["BEVANDA", 3],
        ["COPERTO", 2],
      ],
      [M.burger.name]: [
        ["CHEESEBURGER CON PATATINE", 13.5],
        ["BIRRA ARTIGIANALE", 6],
      ],
    };
    const items = (menu[place.name] ?? []).map(([d, price]) =>
      line(d, round2(price * people * inflation), 10, null, people),
    );
    add(day, hhmm(20, 21.5), place, "ristorazione", "carta", items);
  }
  if (!onHoliday && (dow === 0 || dow === 3) && chance(0.1)) {
    add(day, hhmm(19.5, 21), M.deliveroo, "ristorazione", "carta", [
      line(
        pick(["Poke bowl salmone", "Menu kebab", "Pizza margherita + patatine", "Ramen tonkotsu"]),
        round2(between(12, 19)),
        10,
      ),
      line("Costi di consegna e servizio", 3.49, 22),
    ]);
  }
  if (month >= 4 && month <= 8 && !onHoliday && dow === 0 && chance(0.45)) {
    add(day, hhmm(16, 22), M.gelateria, "ristorazione", "contanti", [
      line("COPPETTA 2 GUSTI", 3.5, 10),
    ]);
  }

  // Salute.
  if (day >= nextPharmacy) {
    const shop = pick([M.farmacia, M.farmacia, M.farmacia2]);
    const options: [string, number, string][] = [
      ["TACHIPIRINA 500MG 20 CPR", 5.2, "Paracetamolo"],
      ["MOMENT 200MG 12 CPR", 8.9, "Ibuprofene"],
      ["ENTEROGERMINA 10 FLAC.", 11.5, "Fermenti lattici"],
      ["BENAGOL PASTIGLIE", 7.9, "Pastiglie per la gola"],
      ["CEROTTI HANSAPLAST", 4.5, "Cerotti"],
      ["SPRAY NASALE RINAZINA", 7.4, "Spray nasale"],
      ["MAGNESIO SUPRADYN", 12.9, "Integratore magnesio e potassio"],
      ["CREMA SOLARE SPF50", 16.9, "Crema solare"],
    ];
    const chosen = [pick(options), ...(chance(0.4) ? [pick(options)] : [])];
    add(
      day,
      hhmm(9, 19.5),
      shop,
      "salute",
      "carta",
      chosen.map(([d, price, name]) => ({ ...line(d, price, 10, "salute"), normalizedName: name })),
      "Scontrino parlante con codice fiscale",
    );
    nextPharmacy = new Date(day.getTime() + int(14, 30) * 86_400_000);
  }
  const visits: Record<string, [Merchant, string, number, number | null]> = {
    "2025-11-18": [M.ausl, "Ticket visita dermatologica", 23, null],
    "2026-01-21": [M.dentista, "Igiene dentale professionale", 90, null],
    "2026-03-09": [
      M.ausl,
      "Ticket esami del sangue (emocromo, glicemia, colesterolo)",
      36.15,
      null,
    ],
    "2026-04-14": [M.ottico, "Occhiali da vista - montatura e lenti progressive", 245, 4],
    "2026-06-03": [M.dentista, "Otturazione molare", 120, null],
    "2026-07-22": [M.dentista, "Igiene dentale professionale", 90, null],
    "2026-09-16": [M.ausl, "Ticket visita oculistica", 23, null],
  };
  const visit = visits[day.toISOString().slice(0, 10)];
  if (visit)
    add(day, hhmm(9, 17), visit[0], "salute", "bancomat", [line(visit[1], visit[2], visit[3])]);

  // Cura della persona e servizi.
  if (day >= nextHaircut) {
    add(day, hhmm(9, 18), M.barbiere, "servizi", "contanti", [
      line("Taglio uomo", 20, 22),
      ...(chance(0.4) ? [line("Barba", 8, 22)] : []),
    ]);
    nextHaircut = new Date(day.getTime() + int(28, 40) * 86_400_000);
  }
  if (weekday && chance(0.02))
    add(day, hhmm(9, 18), M.lavanderia, "servizi", "contanti", [
      line("Lavaggio giacca/cappotto", pick([9, 12, 15]), 22),
    ]);
  if (day.toISOString().startsWith("2026-05-28"))
    add(day, "10:30", M.caf, "servizi", "carta", [
      line("Assistenza compilazione modello 730/2026", 55, 22),
    ]);
  if (weekday && chance(0.012))
    add(day, hhmm(9, 13), M.poste, "servizi", "contanti", [
      line(
        pick([
          "Raccomandata A/R",
          "Spedizione pacco ordinario",
          "Bollettino postale - commissione",
        ]),
        pick([2.5, 6.9, 9.5]),
        null,
      ),
    ]);
  if (chance(0.03))
    add(day, hhmm(10, 19), M.tigota, "casa", "carta", [
      line("Detersivo lavatrice", 5.9, 22, "casa"),
      line("Shampoo", 3.49, 22, "salute"),
      line("Spugne cucina x3", 1.99, 22, "casa"),
    ]);

  // Svago.
  if (!onHoliday && (dow === 5 || dow === 6 || dow === 0) && chance(0.06)) {
    add(day, hhmm(17, 21), M.cinema, "svago", "carta", [
      line("Biglietto intero", 9, 10, null, int(1, 2)),
      line("Popcorn medio", 5.5, 10),
    ]);
  }
  if (chance(0.025))
    add(day, hhmm(11, 19), M.libreria, "svago", "carta", [
      line(
        pick(["Romanzo - narrativa italiana", "Saggio", "Guida turistica Puglia", "Fumetto"]),
        pick([12.9, 16, 18.5, 20]),
        4,
      ),
    ]);

  // Date speciali.
  const iso = day.toISOString().slice(0, 10);
  const special: Record<string, () => void> = {
    "2025-10-25": () => {
      add(day, "16:20", M.zara, "abbigliamento", "carta", [
        line("Giacca imbottita uomo", 69.95, 22),
        line("Maglione girocollo", 35.95, 22),
      ]);
    },
    "2025-11-02": () => {
      add(day, "15:40", M.ikea, "casa", "carta", [
        line("Lampada da terra HEKTAR", 39.99, 22),
        line("Set 4 bicchieri", 6.99, 22),
        line("Plaid", 14.99, 22),
        line("Hot dog + bibita", 2.5, 10, "ristorazione"),
      ]);
    },
    "2025-11-28": () => {
      add(day, "21:15", M.amazon, "tecnologia", "carta", [
        line("Cuffie wireless Sony WH-CH720N (Black Friday)", 79.99, 22),
        line("Caricatore USB-C 30W", 19.99, 22),
      ]);
    },
    "2025-12-06": () => {
      add(day, "11:00", M.ticketone, "svago", "carta", [
        line("Biglietto concerto Unipol Arena", 59.8, 10),
        line("Diritti di prevendita", 8.97, 22),
      ]);
    },
    "2025-12-13": () => {
      add(day, "17:30", M.regali, "altro", "carta", [
        line("Regali di Natale: profumo, sciarpa, set candele", 142.5, 22),
      ]);
    },
    "2025-12-20": () => {
      add(day, "16:00", M.amazon, "altro", "carta", [
        line("Regali di Natale: gioco da tavolo, libro, tazze", 74.4, 22),
      ]);
    },
    "2025-12-23": () => {
      add(day, "09:10", M.trenitalia, "trasporti", "carta", [
        line("Frecciarossa Bologna C.le - Roma Termini A/R", 89.8, 10),
      ]);
    },
    "2025-12-24": () => {
      add(day, "10:40", M.fiorista, "altro", "contanti", [line("Stella di Natale", 18, 10)]);
    },
    "2025-12-30": () => {
      add(day, "19:00", M.esselunga, "alimentari", "carta", [
        line("Panettone Motta", 6.9, 10, "alimentari"),
        line("Spumante Ferrari Brut", 22.9, 22, "alimentari"),
        line("Lenticchie", 1.9, 4, "alimentari"),
        line("Cotechino Modena IGP", 6.5, 10, "alimentari"),
      ]);
    },
    "2026-01-05": () => {
      add(day, "15:30", M.ovs, "abbigliamento", "carta", [
        line("Pantaloni chino (saldi -30%)", 20.97, 22),
        line("Camicia Oxford (saldi)", 17.47, 22),
        line("Calze x5", 7.99, 22),
      ]);
    },
    "2026-01-17": () => {
      add(day, "11:20", M.decathlon, "abbigliamento", "carta", [
        line("Scarponcini trekking", 59.99, 22),
        line("Pile Quechua", 14.99, 22),
      ]);
    },
    "2026-02-07": () => {
      add(day, "08:40", M.skipass, "svago", "carta", [line("Skipass giornaliero Cimone", 46, 10)]);
    },
    "2026-02-14": () => {
      add(day, "20:45", M.trattoria, "ristorazione", "carta", [
        line("Cena San Valentino x2", 92, 10),
        line("Bottiglia Lambrusco", 18, 10),
      ]);
    },
    "2026-03-14": () => {
      add(day, "10:00", M.leroy, "casa", "carta", [
        line("Pittura lavabile bianca 10L", 34.9, 22),
        line("Rullo e pennelli", 12.9, 22),
        line("Nastro carta", 3.5, 22),
      ]);
    },
    "2026-03-26": () => {
      add(day, "18:00", M.idraulico, "casa", "contanti", [
        line("Riparazione perdita rubinetto cucina", 90, 22),
        line("Ricambio cartuccia miscelatore", 25, 22),
      ]);
    },
    "2026-04-04": () => {
      add(day, "16:10", M.scarpe, "abbigliamento", "carta", [
        line("Sneakers Nike Air Max", 129.99, 22),
      ]);
    },
    "2026-04-30": () => {
      add(day, "12:00", M.emergency, "altro", "carta", [line("Donazione", 30, null)]);
    },
    "2026-05-16": () => {
      add(day, "15:00", M.ikea, "casa", "carta", [
        line("Tenda oscurante", 24.99, 22),
        line("Scaffale KALLAX", 49.99, 22),
      ]);
    },
    "2026-06-20": () => {
      add(day, "16:00", M.zara, "abbigliamento", "carta", [
        line("Camicia lino", 35.95, 22),
        line("Bermuda", 29.95, 22),
      ]);
    },
    "2026-07-04": () => {
      add(day, "11:00", M.decathlon, "svago", "carta", [
        line("Ombrellone da spiaggia", 24.99, 22),
        line("Telo mare", 12.99, 22),
        line("Maschera snorkeling", 19.99, 22),
      ]);
    },
    "2026-07-08": () => {
      add(day, "15:30", M.ovs, "abbigliamento", "carta", [
        line("T-shirt cotone x3 (saldi)", 23.97, 22),
        line("Costume da bagno", 19.99, 22),
      ]);
    },
    "2026-07-12": () => {
      add(day, "22:10", M.booking, "svago", "carta", [
        line("Hotel Barocco Lecce - 9 notti camera doppia uso singola (acconto)", 260, 10),
      ]);
    },
    "2026-08-09": () => {
      add(
        day,
        "06:50",
        M.eni,
        "carburante",
        "carta",
        [
          {
            description: "BENZINA SELF",
            quantity: 38.9,
            unitPrice: 1.9,
            amount: 73.91,
            vatRate: 22,
            category: "carburante",
            normalizedName: "Benzina",
            brand: null,
            size: null,
            sizeUnit: "l",
          },
        ],
        "Partenza per le ferie",
      );
    },
    "2026-08-10": () => {
      add(day, "20:30", M.ristoLecce, "ristorazione", "carta", [
        line("Cena tipica salentina", 34, 10),
      ]);
    },
    "2026-08-12": () => {
      add(day, "18:00", M.lido, "svago", "contanti", [
        line("Ombrellone + 2 lettini", 25, 22),
        line("Bar lido", 6.5, 10, "ristorazione"),
      ]);
    },
    "2026-08-13": () => {
      add(day, "19:45", M.ristoLecce, "ristorazione", "carta", [
        line("Orecchiette e polpo", 29, 10),
      ]);
    },
    "2026-08-14": () => {
      add(day, "18:10", M.lido, "svago", "contanti", [line("Ombrellone + 2 lettini", 25, 22)]);
    },
    "2026-08-15": () => {
      add(day, "21:00", M.ristoLecce, "ristorazione", "carta", [
        line("Cena di Ferragosto", 55, 10),
      ]);
    },
    "2026-08-16": () => {
      add(day, "12:10", M.carrefour, "alimentari", "carta", [
        line("Acqua, frutta e snack", 18.6, 10, "alimentari"),
      ]);
    },
    "2026-08-18": () => {
      add(day, "10:00", M.booking, "svago", "carta", [
        line("Hotel Barocco Lecce - saldo soggiorno", 430, 10),
        line("Tassa di soggiorno", 18, null),
      ]);
      add(
        day,
        "17:30",
        M.q8,
        "carburante",
        "carta",
        [
          {
            description: "BENZINA SELF",
            quantity: 34.7,
            unitPrice: 1.93,
            amount: 66.97,
            vatRate: 22,
            category: "carburante",
            normalizedName: "Benzina",
            brand: null,
            size: null,
            sizeUnit: "l",
          },
        ],
        "Rientro dalle ferie",
      );
    },
    "2026-09-05": () => {
      add(day, "17:20", M.mediaworld, "tecnologia", "carta", [
        line("Smartphone Samsung Galaxy A56 128GB", 329, 22),
        line("Cover e pellicola", 24.98, 22),
      ]);
    },
    "2026-09-26": () => {
      add(day, "16:40", M.zara, "abbigliamento", "carta", [
        line("Felpa", 29.95, 22),
        line("Jeans slim", 39.95, 22),
      ]);
    },
  };
  special[iso]?.();
  if (onHoliday && chance(0.6)) {
    add(day, hhmm(12.5, 14), M.lido, "ristorazione", "contanti", [
      line(
        pick(["Frisella al pomodoro", "Panino e bibita", "Insalata di mare"]),
        pick([7, 8.5, 12]),
        10,
      ),
    ]);
  }
}

// --- Scrittura su database ---

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { db, close } = createDb(DATABASE_URL);

async function findUserId(email: string): Promise<string | undefined> {
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (user) return user.id;
    if (data.users.length < perPage) return undefined;
  }
}

try {
  let userId = await findUserId(EMAIL);
  if (userId) {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`Utente ${EMAIL} esistente (${userId}): password reimpostata.`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Utente ${EMAIL} creato (${userId}).`);
  }
  const uid = userId;

  const rows = receipts
    .filter((r) => r.items.length > 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((r) => {
      const receiptId = randomUUID();
      const extractionId = randomUUID();
      const total = round2(r.items.reduce((s, i) => s + i.amount, 0));
      const taxTotal = round2(
        r.items.reduce(
          (s, i) => s + (i.vatRate ? i.amount - i.amount / (1 + i.vatRate / 100) : 0),
          0,
        ),
      );
      // Inserito a mano poco dopo l'acquisto (bollette: entro qualche giorno).
      const createdAt = new Date(r.at.getTime() + int(5, 600) * 60_000);
      const raw = {
        merchantName: r.merchant.name,
        merchantBrand: r.merchant.brand,
        merchantVat: r.merchant.vat,
        purchasedAt: r.at.toISOString(),
        currency: "EUR",
        total,
        taxTotal,
        paymentMethod: r.payment,
        category: r.category,
        notes: r.notes ?? null,
        items: r.items,
      };
      return {
        receipt: {
          id: receiptId,
          userId: uid,
          source: "manual" as const,
          status: "extracted" as const,
          createdAt,
          updatedAt: createdAt,
        },
        extraction: {
          id: extractionId,
          receiptId,
          userId: uid,
          method: "manual" as const,
          rawJson: raw,
          merchantName: r.merchant.name,
          merchantBrand: r.merchant.brand,
          merchantVat: r.merchant.vat,
          merchantAddress: r.merchant.address,
          purchasedAt: r.at,
          currency: "EUR",
          total,
          taxTotal,
          paymentMethod: r.payment,
          category: r.category,
          confidence: 1,
          notes: r.notes ?? null,
          createdAt,
        },
        items: r.items.map((i, position) => ({
          extractionId,
          userId: uid,
          position,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          amount: i.amount,
          vatRate: i.vatRate,
          category: i.category ?? r.category,
          normalizedName: i.normalizedName ?? null,
          brand: i.brand ?? null,
          size: i.size ?? null,
          sizeUnit: i.sizeUnit ?? null,
        })),
      };
    });

  const chunks = <T>(list: T[], size = 300) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
      list.slice(i * size, (i + 1) * size),
    );

  await db.transaction(async (tx) => {
    // Estrazioni e righe spariscono a cascata.
    await tx.delete(receiptsRaw).where(eq(receiptsRaw.userId, uid));
    for (const c of chunks(rows.map((r) => r.receipt))) await tx.insert(receiptsRaw).values(c);
    for (const c of chunks(rows.map((r) => r.extraction))) await tx.insert(extractions).values(c);
    for (const c of chunks(rows.flatMap((r) => r.items))) await tx.insert(receiptItems).values(c);
  });
  const months = await createStatsRepo(db).recompute(uid);

  const total = rows.reduce((s, r) => s + r.extraction.total, 0);
  const byCategory = new Map<string, number>();
  for (const r of rows)
    byCategory.set(
      r.extraction.category,
      (byCategory.get(r.extraction.category) ?? 0) + r.extraction.total,
    );
  console.log(
    `${rows.length} scontrini, ${rows.reduce((s, r) => s + r.items.length, 0)} righe, ${months} righe in stats_monthly.`,
  );
  console.log(
    `Totale ${total.toFixed(2)} € dal ${START.toISOString().slice(0, 10)} al ${END.toISOString().slice(0, 10)}.`,
  );
  for (const [category, amount] of [...byCategory].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(14)} ${amount.toFixed(2).padStart(10)} €`);
  }
} finally {
  await close();
}
