/**
 * The message of a thrown value. A `catch` binding is `unknown`, and casting it
 * to `Error` turns a thrown string or object into `undefined` on the way to the
 * operator. Narrowing keeps a diagnostic in every case.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
