import type { SeparationPoint, UnitSystem } from '@anywhererace/core';
import { formatShortDistanceM, formatSpanM } from '@anywhererace/core';

/**
 * The one-line description of a separation point.
 *
 * This used to be baked into the track by the sweep. It lives here now because
 * it is the only part of a separation point that depends on the reader: the
 * measurements are the same course whoever looks at it, but "1.2 km at 6%" and
 * "0.7 mi at 6%" are the same fact told two ways, and a sentence frozen at bake
 * time can only ever be one of them.
 *
 * The copy stays a claim about the *road*. The sim reads these points as a
 * reason for a racer to attack, never as an instruction to split, so nothing
 * here says a race will come apart — only that it could.
 */
export const describeSeparation = (point: SeparationPoint, system: UnitSystem): string => {
  const { detail } = point;
  // Tracks saved before the sweep emitted measurements carry the sentence
  // itself. Metric, as it was baked; there is nothing left to convert from.
  if (typeof detail === 'string') return detail;

  const length = formatSpanM(point.endM - point.startM, system);

  switch (detail.kind) {
    case 'climb':
      return `${(detail.meanGradient * 100).toFixed(1)}% for ${length}, ${formatShortDistanceM(detail.gainM, system)} of climbing`;
    case 'narrows':
      return `down to ${formatShortDistanceM(detail.tightestWidthM, system, 1)} wide for ${length}`;
    case 'technical':
      return `${detail.featureCount} corners and junctions in ${length}`;
    case 'surface':
      return `${length} of ${detail.assumed ? 'assumed ' : ''}${detail.surface}`;
    case 'exposed':
      return `${length} on one bearing — echelon country if there is a crosswind`;
  }
};
