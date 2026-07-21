import type { FinishRecord } from './types';

/**
 * Result hashing.
 *
 * The hash covers the finishing order, each racer's status, and their times.
 * It deliberately does NOT cover the event log: two builds that produce the
 * same finishing order to the millisecond but differ in how many lockups they
 * logged are, for sharing purposes, the same race, and we would rather not
 * invalidate every published link over a change to incident bookkeeping.
 *
 * Times are quantized to whole milliseconds before hashing. Nothing in the
 * tick uses `Math.sin`/`Math.log`/`Math.pow` — the transcendentals ECMAScript
 * leaves implementation-approximated — but `Math.sqrt` is unavoidable for the
 * cornering limit, and track baking uses geodesy. Quantizing means a last-ulp
 * disagreement between two engines cannot flip a published hash, while a real
 * behavioral change still will.
 */

/** Times are compared and hashed at this resolution. */
export const HASH_TIME_QUANTUM_S = 0.001;

const quantize = (seconds: number): number =>
  Math.round(seconds / HASH_TIME_QUANTUM_S);

/**
 * FNV-1a, 64-bit, implemented on two 32-bit halves so it stays in exactly
 * specified integer arithmetic. Not a cryptographic hash — this detects
 * accidental divergence, not tampering.
 */
const fnv1a64 = (input: string): string => {
  // Offset basis 14695981039346656037 split into high/low 32-bit words.
  let high = 0xcbf2_9ce4;
  let low = 0x8422_2325;

  for (let i = 0; i < input.length; i++) {
    low ^= input.charCodeAt(i) & 0xffff;

    // Multiply by the FNV prime 1099511628211 = 2^40 + 2^8 + 0x b3.
    // Done as 16-bit limb arithmetic so no intermediate exceeds 2^53.
    const l0 = low & 0xffff;
    const l1 = low >>> 16;
    const h0 = high & 0xffff;
    const h1 = high >>> 16;

    // prime = 0x00000100_000001b3
    const p0 = 0x01b3;
    const p1 = 0x0000;
    const p2 = 0x0100;

    let c0 = l0 * p0;
    let c1 = (c0 >>> 16) + l1 * p0 + l0 * p1;
    let c2 = (c1 >>> 16) + h0 * p0 + l1 * p1 + l0 * p2;
    const c3 = (c2 >>> 16) + h1 * p0 + h0 * p1 + l1 * p2;

    c0 &= 0xffff;
    c1 &= 0xffff;
    c2 &= 0xffff;

    low = ((c1 << 16) | c0) >>> 0;
    high = (((c3 & 0xffff) << 16) | (c2 & 0xffff)) >>> 0;
  }

  return (
    high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0')
  );
};

/**
 * Canonical string form of a result. Exported because when a golden test fails
 * this is the thing you want to diff, not two opaque hashes.
 */
export const canonicalResultString = (finishers: readonly FinishRecord[]): string => {
  const lines = finishers.map((f) => {
    const total = f.totalTimeS === undefined ? 'dnf' : String(quantize(f.totalTimeS));
    const best = f.bestLapS === undefined ? 'none' : String(quantize(f.bestLapS));
    return [f.position, f.racerId, f.status, total, f.lapsCompleted, best].join('|');
  });
  return lines.join('\n');
};

export const hashResult = (finishers: readonly FinishRecord[]): string =>
  fnv1a64(canonicalResultString(finishers));
