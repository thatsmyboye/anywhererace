import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LapChart, PositionChart } from '@anywhererace/sim';
import { formatDurationS } from '@anywhererace/core';
import { THEME } from '../../palette';
import type { RacerView } from '../../useRaceClient';

/**
 * The two charts CLAUDE.md asks for.
 *
 * Recharts rather than hand-rolled SVG, per the stack table — these need axes,
 * gridlines and tooltips, which is exactly the work a charting library exists
 * to do. The elevation profile in the builder stays hand-rolled because it has
 * none of that.
 *
 * Both charts share one convention: a racer's line is their marker colour, so
 * the chart, the timing tower and the map all agree without a legend to
 * cross-reference. At forty racers a legend would be larger than the chart.
 */

type Racers = ReadonlyMap<string, RacerView>;

const AXIS = { stroke: THEME.textMuted, fontSize: 11 } as const;
const GRID_COLOR = '#232c39';

/**
 * Position over time.
 *
 * The Y axis is reversed, because first place belongs at the top — a chart
 * where winning means "down" reads backwards no matter how it is labelled.
 */
export const PositionOverTime = ({
  chart,
  racers,
}: {
  chart: PositionChart;
  racers: Racers;
}) => {
  if (chart.lapNumbers.length < 2) return null;

  // Recharts wants one row per X value with a column per series.
  const data = chart.lapNumbers.map((lap) => {
    const row: Record<string, number | null> = { lap };
    for (const series of chart.series) {
      const point = series.points.find((candidate) => candidate.lap === lap);
      // `null` breaks the line rather than joining across a retirement.
      row[series.racerId] = point?.position ?? null;
    }
    return row;
  });

  return (
    <ChartFrame title="Position by lap" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -20 }}>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
        <XAxis dataKey="lap" {...AXIS} tickLine={false} />
        <YAxis
          reversed
          domain={[1, chart.fieldSize]}
          allowDecimals={false}
          {...AXIS}
          tickLine={false}
        />
        <Tooltip
          content={({ active, payload, label }) =>
            !active || payload === undefined ? null : (
              <TooltipCard title={label === 0 ? 'Grid' : `Lap ${String(label)}`}>
                {payload
                  .slice()
                  .sort((a, b) => Number(a.value ?? 99) - Number(b.value ?? 99))
                  .map((entry) => (
                    <TooltipRow
                      key={String(entry.dataKey)}
                      color={entry.color ?? THEME.text}
                      label={racers.get(String(entry.dataKey))?.name ?? String(entry.dataKey)}
                      value={`P${String(entry.value)}`}
                    />
                  ))}
              </TooltipCard>
            )
          }
        />
        {chart.series.map((series) => (
          <Line
            key={series.racerId}
            type="linear"
            dataKey={series.racerId}
            stroke={racers.get(series.racerId)?.appearance.color ?? THEME.textMuted}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  );
};

/** Lap times. The shape of a race's pace: who faded, who found it late. */
export const LapTimes = ({ chart, racers }: { chart: LapChart; racers: Racers }) => {
  if (chart.lapNumbers.length < 2) return null;

  const data = chart.lapNumbers.map((lap) => {
    const row: Record<string, number | null> = { lap };
    for (const series of chart.rows) {
      row[series.racerId] = series.laps[lap - 1] ?? null;
    }
    return row;
  });

  return (
    <ChartFrame title="Lap times" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
        <XAxis dataKey="lap" {...AXIS} tickLine={false} />
        <YAxis
          {...AXIS}
          tickLine={false}
          width={52}
          domain={['dataMin - 2', 'dataMax + 2']}
          tickFormatter={(value: number) => formatDurationS(value, 0)}
        />
        <Tooltip
          content={({ active, payload, label }) =>
            !active || payload === undefined ? null : (
              <TooltipCard title={`Lap ${String(label)}`}>
                {payload
                  .slice()
                  .sort((a, b) => Number(a.value ?? 1e9) - Number(b.value ?? 1e9))
                  .slice(0, 8)
                  .map((entry) => (
                    <TooltipRow
                      key={String(entry.dataKey)}
                      color={entry.color ?? THEME.text}
                      label={racers.get(String(entry.dataKey))?.name ?? String(entry.dataKey)}
                      value={formatDurationS(Number(entry.value), 2)}
                    />
                  ))}
              </TooltipCard>
            )
          }
        />
        {chart.rows.map((row) => (
          <Line
            key={row.racerId}
            type="monotone"
            dataKey={row.racerId}
            stroke={racers.get(row.racerId)?.appearance.color ?? THEME.textMuted}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  );
};

const ChartFrame = ({
  title,
  height,
  children,
}: {
  title: string;
  height: number;
  children: React.ReactElement;
}) => (
  <section className="flex flex-col gap-1">
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">{title}</h3>
    <div style={{ height }} className="w-full rounded-lg border border-[#2b3543] bg-[#0b0e13] p-2">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  </section>
);

const TooltipCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded border border-[#2b3543] bg-[#161b24]/95 px-2 py-1.5 text-xs shadow-lg backdrop-blur">
    <p className="mb-1 font-semibold text-[#e6ebf2]">{title}</p>
    <div className="flex flex-col gap-0.5">{children}</div>
  </div>
);

const TooltipRow = ({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) => (
  <p className="flex items-center gap-1.5 text-[#8d9bb0]">
    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
    <span className="min-w-0 flex-1 truncate text-[#e6ebf2]">{label}</span>
    <span className="tabular-nums">{value}</span>
  </p>
);
