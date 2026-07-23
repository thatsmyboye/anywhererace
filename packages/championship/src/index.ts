// The championship domain: a sequence of races over a fixed field, scored
// outside the sim.
//
// Pure and headless like the sim it sits above — no React, no DOM, no clock.
// It reads race *results* and produces standings; it never reaches into a
// racer, because there is nothing in a racer to reach into. The standings are
// the championship's ledger, not a career.

export * from './types';
export * from './constants';
export * from './scoring';
