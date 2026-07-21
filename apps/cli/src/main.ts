import { parseArgs } from 'node:util';
import {
  createMockElevationProvider,
  createMockRoutingProvider,
  destinationPoint,
  formatDurationS,
  msToKph,
} from '@anywhererace/core';
import type { LatLng, RoutingProfile } from '@anywhererace/core';
import {
  ARCHETYPES,
  VEHICLE_CLASSES,
  createRace,
  eventsOfType,
  getVehicleClass,
} from '@anywhererace/sim';
import type { RaceEvent, RacerSpec } from '@anywhererace/sim';
import { buildTrack } from '@anywhererace/track';

/**
 * A headless race runner.
 *
 * The point of this is tuning. The sim is the hard part of the product and it
 * needs to be watchable long before there is a map to watch it on — so this
 * builds a track from the mock providers, runs a race, and prints the things
 * you would otherwise squint at a UI for: finishing order, lap chart, incident
 * timeline, and the result hash.
 *
 * It uses the mock routing and elevation providers, so it never touches the
 * network and its output is fully reproducible from the seed.
 */

const usage = `
anywhererace — headless race runner

  pnpm race [options]

Options:
  --vehicle <id>       vehicle class            (default: road-cyclist)
  --laps <n>           laps, circuits only      (default: 3)
  --field <n>          number of racers, 2-40   (default: 10)
  --seed <string>      race seed                (default: cli)
  --size <meters>      rough track size         (default: 1200)
  --profile <id>       motor|bicycle|pedestrian (default: motor)
  --mode <id>          circuit|point-to-point   (default: circuit)
  --rain <mm/h>        precipitation            (default: 0)
  --wind <m/s>         wind speed               (default: 0)
  --wind-from <deg>    wind direction           (default: 0)
  --temp <celsius>     temperature              (default: 18)
  --events             print the full event log
  --list               list vehicle classes and personalities
  --help
`.trim();

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      vehicle: { type: 'string', default: 'road-cyclist' },
      laps: { type: 'string', default: '3' },
      field: { type: 'string', default: '10' },
      seed: { type: 'string', default: 'cli' },
      size: { type: 'string', default: '1200' },
      profile: { type: 'string', default: 'motor' },
      mode: { type: 'string', default: 'circuit' },
      rain: { type: 'string', default: '0' },
      wind: { type: 'string', default: '0' },
      'wind-from': { type: 'string', default: '0' },
      temp: { type: 'string', default: '18' },
      events: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (values.list) {
    listCatalog();
    return 0;
  }

  const vehicle = getVehicleClass(values.vehicle ?? '');
  if (vehicle === undefined) {
    console.error(`Unknown vehicle class "${values.vehicle}". Try --list.`);
    return 1;
  }

  const fieldSize = Number(values.field);
  const sizeM = Number(values.size);
  const mode = values.mode === 'point-to-point' ? 'point-to-point' : 'circuit';

  const built = await buildTrack({
    id: 'cli-track',
    name: 'CLI track',
    mode,
    routingProfile: (values.profile ?? 'motor') as RoutingProfile,
    waypoints: squareWaypoints(sizeM),
    routing: createMockRoutingProvider({ seed: `cli-${sizeM}` }),
    elevation: createMockElevationProvider({ seed: `cli-${sizeM}` }),
  });

  if (!built.ok) {
    console.error(`Could not build the track: ${built.error.message}`);
    return 1;
  }
  const track = built.value;

  const created = createRace({
    track,
    config: {
      trackId: track.id,
      laps: Number(values.laps),
      vehicleClassId: vehicle.id,
      weather: {
        kind: 'manual',
        conditions: {
          temperatureC: Number(values.temp),
          precipitationMmPerHour: Number(values.rain),
          windSpeedMs: Number(values.wind),
          windFromDegrees: Number(values['wind-from']),
          cloudCoverFraction: Number(values.rain) > 0 ? 0.9 : 0.2,
          humidityFraction: 0.6,
        },
      },
      fieldSize,
      racers: buildField(fieldSize),
      seed: values.seed ?? 'cli',
      gridOrder: 'by-skill',
    },
  });

  if (!created.ok) {
    console.error(`Could not start the race: ${created.error.message}`);
    return 1;
  }

  const finished = created.value.runToEnd();
  if (!finished.ok) {
    console.error(`Race failed: ${finished.error.message}`);
    return 1;
  }
  const result = finished.value;
  const nameById = new Map(created.value.setup.racers.map((r) => [r.spec.id, r.spec.name]));

  printTrack(track, vehicle.label);
  printClassification(result, nameById);
  printLapChart(result, nameById);
  printIncidents(created.value.events, nameById);
  if (values.events) printEventLog(created.value.events, nameById);

  console.log('');
  console.log(`sim ${result.simVersion}   seed "${result.seed}"   hash ${result.resultHash}`);
  console.log(
    `${result.totalTicks} ticks, ${formatDurationS(result.durationS, 1)} of racing`,
  );
  return 0;
};

/** A square loop, which is the shape a user drawing a city block ends up with. */
const squareWaypoints = (sizeM: number): LatLng[] => {
  const origin: LatLng = { lat: 51.5, lng: -0.12 };
  const east = destinationPoint(origin, 90, sizeM);
  return [origin, east, destinationPoint(east, 0, sizeM), destinationPoint(origin, 0, sizeM)];
};

/**
 * One racer per archetype, cycling, with skills spread evenly. Not random:
 * when a race feels wrong, the field should not be one of the variables.
 */
const buildField = (size: number): RacerSpec[] =>
  Array.from({ length: size }, (_, i) => {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    return {
      id: `r${String(i + 1).padStart(2, '0')}`,
      name: archetype?.label.replace('The ', '') ?? `Racer ${i + 1}`,
      color: '#888888',
      personality: archetype?.id ?? 'metronome',
      skill: size === 1 ? 0.8 : 0.55 + (0.4 * i) / (size - 1),
    };
  });

const listCatalog = (): void => {
  console.log('Vehicle classes:');
  for (const vehicle of VEHICLE_CLASSES) {
    console.log(
      `  ${vehicle.id.padEnd(18)} ${vehicle.label.padEnd(18)} ` +
        `${String(vehicle.topSpeedKph).padStart(3)} kph  ${vehicle.category}`,
    );
  }
  console.log('\nPersonalities:');
  for (const archetype of ARCHETYPES) {
    console.log(`  ${archetype.id.padEnd(14)} ${archetype.label.padEnd(18)} ${archetype.blurb}`);
  }
};

const printTrack = (track: { name: string; lengthMeters: number; nodes: unknown[]; mode: string }, vehicleLabel: string): void => {
  console.log('');
  console.log(
    `${track.name} — ${(track.lengthMeters / 1000).toFixed(2)}km ${track.mode}, ` +
      `${track.nodes.length} nodes, ${vehicleLabel}`,
  );
};

const printClassification = (
  result: { finishers: readonly { position: number; racerId: string; status: string; totalTimeS?: number; gapToWinnerS?: number; bestLapS?: number; lapsCompleted: number }[] },
  nameById: Map<string, string>,
): void => {
  console.log('');
  console.log('  Pos  Racer                 Time          Gap        Best lap');
  console.log('  ---  --------------------  ------------  ---------  ---------');
  for (const record of result.finishers) {
    const time =
      record.totalTimeS === undefined
        ? statusLabel(record.status, record.lapsCompleted)
        : formatDurationS(record.totalTimeS);
    const gap = record.gapToWinnerS === undefined ? '' : `+${record.gapToWinnerS.toFixed(3)}`;
    const best = record.bestLapS === undefined ? '' : formatDurationS(record.bestLapS);
    console.log(
      `  ${String(record.position).padStart(3)}  ` +
        `${(nameById.get(record.racerId) ?? record.racerId).padEnd(20)}  ` +
        `${time.padEnd(12)}  ${gap.padEnd(9)}  ${best}`,
    );
  }
};

const statusLabel = (status: string, laps: number): string =>
  status === 'dnf-crash'
    ? `DNF crash L${laps}`
    : status === 'dnf-timeout'
      ? `DNF time L${laps}`
      : `DNF mech L${laps}`;

const printLapChart = (
  result: { finishers: readonly { racerId: string; laps: readonly { lap: number; timeS: number }[] }[] },
  nameById: Map<string, string>,
): void => {
  const maxLaps = Math.max(0, ...result.finishers.map((f) => f.laps.length));
  if (maxLaps === 0) return;

  console.log('');
  console.log('Lap chart');
  const header = Array.from({ length: maxLaps }, (_, i) => `L${i + 1}`.padStart(9)).join('');
  console.log(`  ${''.padEnd(20)}${header}`);
  for (const record of result.finishers) {
    const cells = Array.from({ length: maxLaps }, (_, i) => {
      const lap = record.laps[i];
      return (lap === undefined ? '—' : lap.timeS.toFixed(2)).padStart(9);
    }).join('');
    console.log(`  ${(nameById.get(record.racerId) ?? record.racerId).padEnd(20)}${cells}`);
  }
};

const printIncidents = (events: readonly RaceEvent[], nameById: Map<string, string>): void => {
  const incidents = events.filter(
    (e) => e.type === 'mistake' || e.type === 'crash' || e.type === 'mechanical',
  );
  if (incidents.length === 0) {
    console.log('\nNo incidents.');
    return;
  }

  console.log('');
  console.log(`Incidents (${incidents.length})`);
  for (const event of incidents) {
    if (event.type === 'mistake') {
      const cause = event.causedByPassAttempt ? ' after a failed move' : '';
      console.log(
        `  ${formatDurationS(event.atS, 1).padStart(9)}  ` +
          `${(nameById.get(event.racerId) ?? event.racerId).padEnd(20)} ` +
          `${event.kind}${cause}, lost ${event.timeLostS.toFixed(1)}s`,
      );
    } else if (event.type === 'crash') {
      console.log(
        `  ${formatDurationS(event.atS, 1).padStart(9)}  ` +
          `${(nameById.get(event.racerId) ?? event.racerId).padEnd(20)} CRASH on lap ${event.lap + 1}`,
      );
    } else if (event.type === 'mechanical') {
      console.log(
        `  ${formatDurationS(event.atS, 1).padStart(9)}  ` +
          `${(nameById.get(event.racerId) ?? event.racerId).padEnd(20)} mechanical on lap ${event.lap + 1}`,
      );
    }
  }

  const passes = eventsOfType(events, 'overtake');
  const failed = eventsOfType(events, 'failed-pass');
  console.log(`\n${passes.length} overtakes, ${failed.length} failed attempts.`);

  // What a bunch-race feed would actually broadcast, against everything it
  // could have. This is the number to watch when tuning `TUNING.groups`: the
  // suppression is doing its job when the second figure is a small fraction of
  // the first, and it has gone too far when the first stops moving at all.
  const moves = eventsOfType(events, 'group');
  const notable = passes.filter((pass) => pass.significance === 'lead-change').length + moves.length;
  console.log(
    `${notable} worth broadcasting: ${moves.length} group moves ` +
      `(${summarizeKinds(moves)}), ` +
      `${passes.filter((p) => p.significance === 'lead-change').length} for the lead. ` +
      `${passes.filter((p) => p.significance === 'in-group').length} were in-bunch shuffling.`,
  );
};

const summarizeKinds = (moves: readonly { kind: string }[]): string => {
  const counts = new Map<string, number>();
  for (const move of moves) counts.set(move.kind, (counts.get(move.kind) ?? 0) + 1);
  if (counts.size === 0) return 'none';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
};

const printEventLog = (events: readonly RaceEvent[], nameById: Map<string, string>): void => {
  console.log('');
  console.log(`Event log (${events.length})`);
  for (const event of events) {
    const who = 'racerId' in event ? (nameById.get(event.racerId) ?? event.racerId) : '';
    console.log(
      `  ${formatDurationS(event.atS, 2).padStart(10)}  ${event.type.padEnd(12)} ${who}`,
    );
  }
};

/** Kept for the tuning workflow: `--vehicle x --list` shows what speeds mean. */
export const describeSpeed = (speedMs: number): string => `${msToKph(speedMs).toFixed(1)} kph`;

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The app boundary is the one place exceptions are allowed to surface.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
