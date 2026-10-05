export const PROMPT_VERSION = "v3";

export const EXTRACTION_INSTRUCTIONS =
  "Sei un estrattore di dati da scontrini e ricevute italiane. Ricevi un'immagine, un PDF o più immagini consecutive dello stesso scontrino. " +
  "Restituisci solo i dati richiesti dallo schema. Non inventare: se un dato non è leggibile usa null. " +
  "Gli importi sono numeri con il punto decimale. " +
  "Se il documento non è uno scontrino o una ricevuta imposta is_receipt=false. " +
  "`confidence` indica quanto sei sicuro dell'intera lettura. " +
  "Uno scontrino lungo può arrivare fotografato a pezzi e unito in verticale, con una fascia " +
  "grigia tra un pezzo e l'altro: le righe ripetute subito sopra e sotto la fascia sono la " +
  "stessa riga e vanno riportate una sola volta. " +
  "`merchant_name` è il nome come stampato (anche la ragione sociale); `merchant_brand` è l'insegna " +
  'con cui il negozio è conosciuto, scritta nella forma del marchio (es. "Lidl", "IN\'s", "Esselunga", "Eni"), ' +
  "senza forma societaria né località. " +
  "Per ogni riga: `description` è il testo stampato, invariato; `normalized_name` è il prodotto in " +
  'italiano corrente, al singolare, senza marca, formato né abbreviazioni (es. "LATTE PS UHT 1L GRANAROLO" → ' +
  '"Latte parzialmente scremato UHT"), così lo stesso prodotto ha lo stesso nome in negozi diversi; ' +
  '`brand` è la marca se si legge; `size` e `size_unit` sono il formato della confezione (500 g → 500, "g"). ' +
  "Per sconti, buoni, sacchetti e righe non di prodotto lascia null questi quattro campi.";

export const EXTRACTION_PROMPT = "Estrai i dati di questo documento.";

/** Prompt per uno scontrino lungo diviso in fasce sovrapposte. */
export function tiledPrompt(count: number): string {
  return (
    `Lo scontrino è diviso in ${count} immagini consecutive, dall'alto in basso, ` +
    "con una piccola sovrapposizione tra un'immagine e la successiva. " +
    "Leggile come un unico documento: le righe che compaiono in due immagini vicine vanno " +
    "riportate una sola volta. Estrai i dati di questo documento."
  );
}
