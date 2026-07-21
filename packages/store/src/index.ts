// Local-first persistence on IndexedDB.
//
// Not in CLAUDE.md's package layout: it is its own package rather than part of
// the UI because storage is not a rendering concern, and because keeping it
// separate lets it be tested against fake-indexeddb with no React in the way.

export * from './schema';
export * from './trackStore';
export * from './share';
export * from './og';
