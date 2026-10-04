import { createClient } from "@supabase/supabase-js";
import type { SignedUpload, StoragePort, StoredObjectInfo } from "../../ports/storage.port.js";

export const RECEIPTS_BUCKET = "receipts";

const FOLDER_PAGE_SIZE = 100;
const MAX_FOLDER_PAGES = 1000;

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  bucket?: string;
  fetch?: typeof fetch;
}

/** Adapter Supabase Storage. Gli errori del provider non escono: messaggi generici. */
export function createSupabaseStorage(opts: SupabaseStorageOptions): StoragePort {
  const fetchFn = opts.fetch ?? fetch;
  const client = createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchFn },
  });
  const bucket = () => client.storage.from(opts.bucket ?? RECEIPTS_BUCKET);

  const signedReadUrl = async (path: string, expiresIn: number) => {
    const { data, error } = await bucket().createSignedUrl(path, expiresIn);
    if (error) throw new Error("storage: createSignedUrl fallita");
    return data.signedUrl;
  };

  return {
    async createSignedUploadUrl(path): Promise<SignedUpload> {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error) throw new Error("storage: createSignedUploadUrl fallita");
      return { uploadUrl: data.signedUrl, token: data.token, path: data.path };
    },

    createSignedReadUrl: signedReadUrl,

    async stat(path): Promise<StoredObjectInfo | null> {
      const { data, error } = await bucket().info(path);
      if (error) {
        if (error.status === 404 || error.statusCode === "404" || error.statusCode === "NoSuchKey")
          return null;
        throw new Error("storage: info fallita");
      }
      if (typeof data.size !== "number") return null;
      return { sizeBytes: data.size, mimeType: data.contentType ?? null };
    },

    async readHead(path, length) {
      const url = await signedReadUrl(path, 60);
      const res = await fetchFn(url, { headers: { Range: `bytes=0-${length - 1}` } });
      if (!res.ok) throw new Error("storage: lettura fallita");
      return new Uint8Array(await res.arrayBuffer()).slice(0, length);
    },

    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error) throw new Error("storage: download fallito");
      return new Uint8Array(await data.arrayBuffer());
    },

    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket().remove(paths);
      if (error) throw new Error("storage: remove fallita");
    },

    async removeFolder(folder) {
      // Ogni pagina viene cancellata, quindi si rilegge sempre dall'inizio.
      for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
        const { data, error } = await bucket().list(folder, { limit: FOLDER_PAGE_SIZE });
        if (error) throw new Error("storage: list fallita");
        // Le voci senza id sono sottocartelle: la struttura `{user_id}/{id}.{ext}` non ne prevede.
        const files = data.filter((o) => o.id !== null).map((o) => `${folder}/${o.name}`);
        if (files.length === 0) return;
        const removed = await bucket().remove(files);
        if (removed.error) throw new Error("storage: remove fallita");
      }
      throw new Error("storage: troppi file nella cartella");
    },
  };
}
