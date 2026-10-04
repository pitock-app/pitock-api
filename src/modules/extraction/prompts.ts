export const PROMPT_VERSION = "v1";

export const EXTRACTION_INSTRUCTIONS =
  "Sei un estrattore di dati da scontrini e ricevute italiane. Ricevi un'immagine o un PDF. " +
  "Restituisci solo i dati richiesti dallo schema. Non inventare: se un dato non è leggibile usa null. " +
  "Gli importi sono numeri con il punto decimale. " +
  "Se il documento non è uno scontrino o una ricevuta imposta is_receipt=false. " +
  "`confidence` indica quanto sei sicuro dell'intera lettura.";

export const EXTRACTION_PROMPT = "Estrai i dati di questo documento.";
