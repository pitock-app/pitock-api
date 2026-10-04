import { createClient } from "@supabase/supabase-js";
import type { UserAdminPort } from "../../ports/user-admin.port.js";

export interface SupabaseUserAdminOptions {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

/** Adapter Supabase Auth Admin. Gli errori del provider non escono: messaggi generici. */
export function createSupabaseUserAdmin(opts: SupabaseUserAdminOptions): UserAdminPort {
  const client = createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: opts.fetch ?? fetch },
  });

  return {
    async deleteUser(userId) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error && error.status !== 404) throw new Error("auth: deleteUser fallita");
    },
  };
}
