import { computeStandings } from '@anywhererace/championship';
import type { Championship } from '@anywhererace/championship';
import { SIM_VERSION, isRetirement } from '@anywhererace/sim';

/**
 * The standings table.
 *
 * The columns lead with whatever the scoring mode ranks on — time for `time`
 * and `hybrid`, points for `points` — and show the other as a muted secondary,
 * because in every mode the loser of the tiebreak is still worth seeing. The
 * per-leg cells sit between, one column per leg, so the shape of the
 * championship is legible at a glance: who won where, who fell out.
 *
 * A leg raced under a since-changed sim is flagged rather than trusted, the
 * same honesty the rest of the app applies to a stored race whose hash no
 * longer matches.
 */

export type ChampionshipStandingsProps = {
  championship: Championship;
};

export const ChampionshipStandings = ({ championship }: ChampionshipStandingsProps) => {
  const standings = computeStandings(championship);
  const { scoring } = championship;
  const timeLeads = scoring !== 'points';

  const staleLegs = championship.legs.filter(
    (leg) => leg.result !== undefined && leg.result.simVersion !== SIM_VERSION,
  ).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-[#2b3543]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[#2b3543] bg-[#1f2632] text-left text-[11px] uppercase tracking-wide text-[#8d9bb0]">
              <th className="w-10 px-2 py-1.5 text-right font-semibold">#</th>
              <th className="px-2 py-1.5 font-semibold">Racer</th>
              {championship.legs.map((leg, index) => (
                <th
                  key={leg.id}
                  className="px-2 py-1.5 text-center font-semibold"
                  title={leg.trackName}
                >
                  L{index + 1}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-semibold">
                {timeLeads ? 'Time' : 'Points'}
              </th>
              <th className="px-2 py-1.5 text-right font-semibold text-[#8d9bb0]/70">
                {timeLeads ? 'Pts' : 'Time'}
              </th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row) => {
              const racer = championship.racers.find((r) => r.id === row.racerId);
              return (
                <tr key={row.racerId} className="border-b border-[#2b3543]/50 last:border-b-0">
                  <td className="px-2 py-1 text-right tabular-nums text-[#8d9bb0]">{row.rank}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: racer?.color ?? '#888888' }}
                      />
                      <span className="truncate">{row.name}</span>
                      {row.wins > 0 ? (
                        <span
                          className="shrink-0 rounded bg-[#3ddc97]/15 px-1 text-[10px] font-semibold text-[#3ddc97]"
                          title={`${row.wins} leg ${row.wins === 1 ? 'win' : 'wins'}`}
                        >
                          {row.wins}★
                        </span>
                      ) : null}
                    </div>
                  </td>
                  {row.perLeg.map((cell, index) => (
                    <td
                      key={championship.legs[index]?.id ?? index}
                      className="px-2 py-1 text-center tabular-nums"
                    >
                      {cell === undefined ? (
                        <span className="text-[#3a4453]">—</span>
                      ) : isRetirement(cell.status) ? (
                        <span className="text-[#ff8f6b]" title="Retired">
                          DNF
                        </span>
                      ) : (
                        <span className={cell.position === 1 ? 'text-[#3ddc97]' : 'text-[#c3ccd9]'}>
                          {cell.position}
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-medium tabular-nums">
                    {timeLeads
                      ? formatDuration(row.cumulativeTimeS)
                      : row.points}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-[#8d9bb0]/70">
                    {timeLeads ? row.points : formatDuration(row.cumulativeTimeS)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-[#8d9bb0]">
        {describeScoring(scoring)}
      </p>

      {staleLegs > 0 ? (
        <p className="rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-2 py-1 text-[11px] text-[#ffb020]">
          {staleLegs === 1 ? 'One leg was' : `${staleLegs} legs were`} raced with an earlier
          version of the simulation. Re-race {staleLegs === 1 ? 'it' : 'them'} to bring the
          standings fully up to date.
        </p>
      ) : null}
    </div>
  );
};

const describeScoring = (scoring: Championship['scoring']): string => {
  if (scoring === 'points') return 'Ranked by championship points; cumulative time breaks a tie.';
  if (scoring === 'hybrid') return 'Ranked by cumulative time; championship points break a tie.';
  return 'Ranked by cumulative time; leg wins break a tie.';
};

/** H:MM:SS, or M:SS under an hour. Zero shows as a dash — nothing raced yet. */
const formatDuration = (totalS: number): string => {
  if (totalS <= 0) return '—';
  const rounded = Math.round(totalS);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};
