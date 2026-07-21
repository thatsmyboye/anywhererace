// The React layer: race view, timing tower, map rendering.
// Depends on worker, track, sim and core; never the reverse.

export * from './palette';
export * from './markers';
export * from './useRaceClient';
export * from './useTrackBuilder';

export { RaceView } from './components/RaceView';
export type { RaceViewProps } from './components/RaceView';
export { RaceMap } from './components/RaceMap';
export { TimingTower } from './components/TimingTower';
export { PlaybackControls } from './components/PlaybackControls';
export { EventFeed } from './components/EventFeed';
export { PatternSwatch } from './components/PatternSwatch';
export { TrackList } from './components/TrackList';
export type { TrackListProps } from './components/TrackList';
export { TrackBuilder } from './components/builder/TrackBuilder';
export type { TrackBuilderProps } from './components/builder/TrackBuilder';
export { BuilderMap } from './components/builder/BuilderMap';
export { ElevationProfile } from './components/builder/ElevationProfile';
