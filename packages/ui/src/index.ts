// The React layer: race view, timing tower, map rendering.
// Depends on worker, track, sim and core; never the reverse.

export * from './feed';
export * from './units';
export * from './separationCopy';
export * from './heatGeometry';
export * from './palette';
export * from './markers';
export * from './useRaceClient';
export * from './useTrackBuilder';
export * from './useRaceSetup';
export * from './useMapSearch';
export * from './racerNames';

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
export type { BuilderMapProps, MapFocus } from './components/builder/BuilderMap';
export { MapSearch } from './components/builder/MapSearch';
export type { MapSearchProps } from './components/builder/MapSearch';
export { ElevationProfile } from './components/builder/ElevationProfile';
export { RaceSetup } from './components/setup/RaceSetup';
export { SeparationPoints } from './components/setup/SeparationPoints';
export type { SeparationPointsProps } from './components/setup/SeparationPoints';
export type { RaceSetupProps } from './components/setup/RaceSetup';
export { RosterTable } from './components/setup/RosterTable';
export { WeatherPicker } from './components/setup/WeatherPicker';
export { ResultsPanel } from './components/results/ResultsPanel';
export type { ResultsPanelProps } from './components/results/ResultsPanel';
export { LapTimes, PositionOverTime } from './components/results/RaceCharts';
