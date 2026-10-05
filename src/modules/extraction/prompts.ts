export const PROMPT_VERSION = "v2";

export const EXTRACTION_INSTRUCTIONS =
  "Sei un estrattore di dati da scontrini e ricevute italiane. Ricevi un'immagine, un PDF o più immagini consecutive dello stesso scontrino. " +
  "Restituisci solo i dati richiesti dallo schema. Non inventare: se un dato non è leggibile usa null. " +
  "Gli importi sono numeri con il punto decimale. " +
  "Se il documento non è uno scontrino o una ricevuta imposta is_receipt=false. " +
  "`confidence` indica quanto sei sicuro dell'intera lettura. " +
  "Uno scontrino lungo può arrivare fotografato a pezzi e unito in verticale, con una fascia " +
  "grigia tra un pezzo e l'altro: le righe ripetute subito sopra e sotto la fascia sono la " +
  "stessa riga e vanno riportate una sola volta.";

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
