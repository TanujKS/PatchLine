/**
 * Tiny Result<T,E> type. Used at boundaries where we want to express
 * "expected failure" (e.g. policy reject) without throwing.
 *
 * Throws are reserved for unexpected failures so the queue can retry them.
 */

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}
