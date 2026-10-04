/** Amministrazione degli utenti di Supabase Auth. L'adapter reale usa la service role key. */
export interface UserAdminPort {
  /** Cancella l'utente; ignora un utente già assente. */
  deleteUser(userId: string): Promise<void>;
}
