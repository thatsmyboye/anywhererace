import type { Track } from '@anywhererace/core';
import { runRace } from '@anywhererace/sim';
import type { RaceResult } from '@anywhererace/sim';
import { describe, expect, it } from 'vitest';
import { OG_HEIGHT, OG_WIDTH, buildRaceCard, buildRaceOgSvg } from '../src/og';
import { makeConfig, makeField, makeSyntheticTrack } from '../../sim/test/fixtures';

/**
 * Share-card tests. The card is generated from a race's inputs (re-run to find
 * the winner) rather than a stored summary, so these pin down that it reports
 * the real winner and margin, draws the track shape, and never emits unescaped
 * user text into the SVG.
 */

const runFixture = (track: Track, laps = 1, racers = makeField({ size: 6 })): RaceResult => {
  const config = makeConfig({ trackId: track.id, laps, racers });
  const run = runRace({ track, config });
  if (!run.ok) throw new Error(`fixture race failed: ${run.error.message}`);
  return run.value;
};

describe('race card summary', () => {
  it('names the winner and states a margin', () => {
    const track = makeSyntheticTrack({ lengthM: 2000, mode: 'circuit' });
    const config = makeConfig({ trackId: track.id, laps: 2 });
    const result = runFixture(track, 2, config.racers);

    const card = buildRaceCard(track, config, result);
    const names = config.racers.map((r) => r.name);
    expect(names).toContain(card.winnerName);
    expect(card.marginText).toMatch(/by |unopposed|nobody finished/);
    expect(card.mode).toBe('circuit');
  });

  it('calls a race unopposed when only one racer finished', () => {
    // A minimum field is two, so "unopposed" is the sole-finisher case: the
    // runner-up retired and has no gap to the winner.
    const track = makeSyntheticTrack({ lengthM: 1500, mode: 'point-to-point' });
    const config = makeConfig({ trackId: track.id, racers: makeField({ size: 2 }) });
    const result = {
      finishers: [
        { racerId: config.racers[0]!.id, status: 'finished', totalTimeS: 100 },
        { racerId: config.racers[1]!.id, status: 'dnf-crash', gapToWinnerS: undefined },
      ],
    } as unknown as RaceResult;

    const card = buildRaceCard(track, config, result);
    expect(card.winnerName).toBe(config.racers[0]!.name);
    expect(card.marginText).toBe('unopposed');
  });

  it('says nobody finished when the winner slot is a retirement', () => {
    const track = makeSyntheticTrack({ lengthM: 1500, mode: 'point-to-point' });
    const config = makeConfig({ trackId: track.id, racers: makeField({ size: 2 }) });
    const result = {
      finishers: [{ racerId: config.racers[0]!.id, status: 'dnf-crash' }],
    } as unknown as RaceResult;

    expect(buildRaceCard(track, config, result).marginText).toBe('nobody finished');
  });
});

describe('og svg', () => {
  const track = makeSyntheticTrack({ lengthM: 2000, mode: 'circuit' });
  const config = makeConfig({ trackId: track.id, laps: 2 });

  it('is a well-formed svg at Open Graph dimensions', () => {
    const svg = buildRaceOgSvg(buildRaceCard(track, config, runFixture(track, 2, config.racers)));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`width="${OG_WIDTH}"`);
    expect(svg).toContain(`height="${OG_HEIGHT}"`);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('draws the track as a path', () => {
    const svg = buildRaceOgSvg(buildRaceCard(track, config, runFixture(track, 2, config.racers)));
    expect(svg).toMatch(/<path d="M[\d.,]/);
  });

  it('closes a circuit but leaves a point-to-point open', () => {
    const circuit = buildRaceOgSvg({
      trackName: 'Loop',
      vehicleLabel: 'Road cyclist',
      mode: 'circuit',
      winnerName: 'Ada',
      marginText: 'by 2.0s',
      polyline: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 1, lng: 1 },
      ],
    });
    const line = buildRaceOgSvg({
      trackName: 'Dash',
      vehicleLabel: 'Runner',
      mode: 'point-to-point',
      winnerName: 'Bram',
      marginText: 'by 2.0s',
      polyline: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 1, lng: 1 },
      ],
    });
    expect(circuit).toMatch(/Z"/);
    expect(line).not.toMatch(/Z"/);
  });

  it('escapes user-controlled text so a name cannot break the svg', () => {
    const svg = buildRaceOgSvg({
      trackName: 'Phil <b>& AC</b>',
      vehicleLabel: 'Road cyclist',
      mode: 'point-to-point',
      winnerName: 'A & B <script>',
      marginText: 'by 1.0s',
      polyline: [
        { lat: 39.95, lng: -75.16 },
        { lat: 39.36, lng: -74.42 },
      ],
    });
    expect(svg).not.toMatch(/<script>/);
    expect(svg).not.toMatch(/& AC/);
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
  });

  it('draws a marker rather than crashing on a degenerate track', () => {
    const svg = buildRaceOgSvg({
      trackName: 'Point',
      vehicleLabel: 'Runner',
      mode: 'point-to-point',
      winnerName: 'Ada',
      marginText: 'unopposed',
      polyline: [{ lat: 1, lng: 1 }],
    });
    expect(svg).toContain('<circle');
  });
});
