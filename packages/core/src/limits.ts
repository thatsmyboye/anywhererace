/**
 * Field-size bounds, in one place so the roster editor, the championship setup,
 * the CLI and the sim's own validation cannot drift apart. They lived as four
 * private `MAX_FIELD` copies before, which is exactly how a UI comes to offer a
 * field the sim then rejects.
 *
 * The ceiling is a legibility limit, not a performance one: the tick is linear
 * in the field and the map draws the whole field from a single GL layer, but
 * beyond this the three marker channels (colour, ring pattern, body shape) run
 * out of room to keep every pair of racers apart.
 */
export const MIN_FIELD_SIZE = 2;
export const MAX_FIELD_SIZE = 100;
