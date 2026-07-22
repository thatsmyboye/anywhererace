import type { SeparationKind, SeparationPoint } from '@anywhererace/core';
import { describeSeparation } from '../../separationCopy';
import { useUnits } from '../../units';

/**
 * Where this course could break the field up.
 *
 * Shown at race setup rather than in the builder because this is where it is
 * actionable: the reader is choosing a class, a distance and a field size, and
 * "there is a 7% climb at 2.1km" is the kind of thing that changes those
 * choices. It appears only for the bunch-racing classes, since for a motor race
 * the answer is uninteresting — a field of GT cars is strung out by lap two
 * whatever the road does.
 *
 * The copy is careful to stay a claim about the *road*, never a prediction
 * about the race. The sim does read these points — they raise the odds a racer
 * attacks here — but a reason to go is not a split, and two races over the same
 * course will not necessarily come apart in the same places or at all. Saying
 * "this is where the race will split" would be a promise the sim does not keep.
 */

export type SeparationPointsProps = {
  /** `undefined` means the course was saved before the sweep existed. */
  points: readonly SeparationPoint[] | undefined;
  className?: string;
};

const KIND_LABEL: Record<SeparationKind, string> = {
  climb: 'Climb',
  narrows: 'Narrows',
  technical: 'Technical',
  surface: 'Surface',
  exposed: 'Exposed',
};

export const SeparationPoints = ({ points, className = '' }: SeparationPointsProps) => {
  const units = useUnits();

  if (points === undefined) {
    // Never analyzed is not the same as nothing found, and saying "no selection
    // points" about a course we never looked at would be a lie.
    return (
      <p className={`text-[11px] leading-snug text-[#8d9bb0] ${className}`}>
        This course was saved before selection points were analysed. Rebuilding it would work
        them out.
      </p>
    );
  }

  if (points.length === 0) {
    return (
      <p className={`text-[11px] leading-snug text-[#8d9bb0] ${className}`}>
        Nothing on this course stands out as a place the bunch would come apart — it is flat,
        wide and smooth. Expect a race that stays together and is decided late.
      </p>
    );
  }

  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <div>
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">
          Where the bunch could come apart ({points.length})
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-[#8d9bb0]">
          Read from the road itself, strongest first. Riders are likelier to attack here — but a
          race may split somewhere else, or never split at all.
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {points.map((point) => (
          <li
            key={`${point.kind}-${point.startM}`}
            className="flex items-baseline gap-2 rounded border border-[#2b3543] bg-[#161b24] px-2.5 py-1.5 text-xs"
          >
            <span className="w-14 shrink-0 tabular-nums text-[#8d9bb0]">
              {units.distance(point.startM)}
            </span>
            <span className="w-16 shrink-0 font-semibold uppercase text-[#4da3ff]">
              {KIND_LABEL[point.kind]}
            </span>
            <span className="min-w-0 flex-1 text-[#e6ebf2]">
              {describeSeparation(point, units.system)}
            </span>
            <SeverityBar severity={point.severity} />
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * Severity is only meaningful as a ranking within one course, so it is drawn as
 * a bar rather than printed as a number — a bar invites comparison with its
 * neighbours, while "0.62" invites a reader to believe it means something on
 * its own.
 */
const SeverityBar = ({ severity }: { severity: number }) => (
  <span
    className="h-1 w-10 shrink-0 self-center overflow-hidden rounded-full bg-[#2b3543]"
    aria-hidden="true"
  >
    <span
      className="block h-full rounded-full bg-[#4da3ff]"
      style={{ width: `${Math.round(Math.min(1, Math.max(0, severity)) * 100)}%` }}
    />
  </span>
);
