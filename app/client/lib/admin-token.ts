// Server administrator token (POST /api/admin/login), kept in sessionStorage for this browser tab only.
// Shared by the /admin page and the « Règles » upload dialog (a missing rulebook uploaded from a table).
const TOKEN_KEY = 'sr.adminToken';

export function readAdminToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function writeAdminToken(tok: string): void {
  try {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}
