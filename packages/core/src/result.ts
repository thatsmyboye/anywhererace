/**
 * Typed results. Per CLAUDE.md, the sim and the provider layer return these;
 * exceptions are reserved for the app boundary.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Map the success value, passing errors through untouched. */
export const mapResult = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Chain a fallible step. */
export const flatMapResult = <T, U, E>(
  r: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> => (r.ok ? f(r.value) : r);

/**
 * Collect an array of results into a result of an array, failing on the first
 * error. Used wherever we route several legs or look up several elevations.
 */
export const allResults = <T, E>(results: readonly Result<T, E>[]): Result<T[], E> => {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
};

/**
 * Escape hatch for the app boundary and for tests: throw on error.
 * Never call this inside packages/sim or packages/track.
 */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on an error result: ${JSON.stringify(r.error)}`);
};
