export interface SignedUpload {
  uploadUrl: string;
  token: string;
  path: string;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  mimeType: string | null;
}

/** Storage dei file raw (bucket privato). L'adapter reale è Supabase Storage. */
export interface StoragePort {
  createSignedUploadUrl(path: string): Promise<SignedUpload>;
  createSignedReadUrl(path: string, expiresInSeconds: number): Promise<string>;
  /** Metadati dell'oggetto realmente caricato; `null` se non esiste. */
  stat(path: string): Promise<StoredObjectInfo | null>;
  /** Primi `length` byte dell'oggetto, per riconoscerne il tipo reale. */
  readHead(path: string, length: number): Promise<Uint8Array>;
  /** Contenuto completo dell'oggetto (per l'estrazione). */
  download(path: string): Promise<Uint8Array>;
  /** Cancella gli oggetti; ignora quelli già assenti. */
  remove(paths: string[]): Promise<void>;
  /** Cancella tutti i file della cartella (senza `/` finale); idempotente. */
  removeFolder(folder: string): Promise<void>;
}
