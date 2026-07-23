import { ARCHETYPES } from '@anywhererace/sim';
import type { RacerAppearance } from '../../palette';
import type { RosterEntry } from '../../useRaceSetup';
import { PatternSwatch } from '../PatternSwatch';

/**
 * The roster.
 *
 * Name, colour, personality and skill, exactly as CLAUDE.md specifies — with
 * the caveat that colour is shown rather than chosen. It comes from the OkLCH
 * palette by position, which is what guarantees no two racers in a field are
 * hard to tell apart; letting a user pick freely would quietly break that for
 * the colourblind viewers it exists to protect. Reordering the palette is the
 * right way to offer control, and is not built yet.
 */

export type RosterTableProps = {
  roster: readonly RosterEntry[];
  palette: readonly RacerAppearance[];
  onChange: (id: string, patch: Partial<Omit<RosterEntry, 'id'>>) => void;
};

export const RosterTable = ({ roster, palette, onChange }: RosterTableProps) => (
  // On a phone the table scrolls sideways rather than crushing the name column
  // to nothing; every desktop container is wider than the minimum, so there the
  // layout is untouched.
  <div className="overflow-x-auto rounded-lg border border-[#2b3543]">
    <table className="w-full min-w-[36rem] border-collapse text-sm">
      <thead>
        <tr className="border-b border-[#2b3543] bg-[#1f2632] text-left text-[11px] uppercase tracking-wide text-[#8d9bb0]">
          <th className="w-10 px-2 py-1.5 font-semibold">#</th>
          <th className="px-2 py-1.5 font-semibold">Racer</th>
          <th className="w-44 px-2 py-1.5 font-semibold">Personality</th>
          <th className="w-52 px-2 py-1.5 font-semibold">Skill</th>
        </tr>
      </thead>
      <tbody>
        {roster.map((entry, index) => {
          const appearance = palette[index];
          return (
            <tr key={entry.id} className="border-b border-[#2b3543]/50 last:border-b-0">
              <td className="px-2 py-1">
                {appearance === undefined ? (
                  index + 1
                ) : (
                  <PatternSwatch appearance={appearance} label={String(index + 1)} />
                )}
              </td>
              <td className="px-2 py-1">
                <input
                  value={entry.name}
                  onChange={(event) => onChange(entry.id, { name: event.target.value })}
                  aria-label={`Name for racer ${index + 1}`}
                  className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[#e6ebf2] outline-none hover:border-[#2b3543] focus:border-[#4da3ff] focus:bg-[#0b0e13]"
                />
              </td>
              <td className="px-2 py-1">
                <select
                  value={entry.personality}
                  onChange={(event) => onChange(entry.id, { personality: event.target.value })}
                  aria-label={`Personality for ${entry.name}`}
                  className="w-full rounded border border-[#2b3543] bg-[#0b0e13] px-1.5 py-1 text-xs text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
                >
                  {ARCHETYPES.map((archetype) => (
                    <option key={archetype.id} value={archetype.id} title={archetype.blurb}>
                      {archetype.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-2 py-1">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    // Skill is a 0-1 scalar internally; percent is simply easier
                    // to talk about, and the conversion stays at the boundary.
                    value={Math.round(entry.skill * 100)}
                    onChange={(event) => onChange(entry.id, { skill: Number(event.target.value) / 100 })}
                    aria-label={`Skill for ${entry.name}`}
                    className="h-1 flex-1 cursor-pointer appearance-none rounded bg-[#2b3543] accent-[#4da3ff]"
                  />
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-[#8d9bb0]">
                    {Math.round(entry.skill * 100)}
                  </span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
