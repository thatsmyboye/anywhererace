/**
 * Map tiles (Protomaps or MapTiler free tier in production).
 *
 * Deliberately thin: the map is the only consumer, and swapping providers must
 * not touch anything but this file's implementations.
 */
export interface TileProvider {
  readonly id: string;
  /** MapLibre GL style document URL. */
  styleUrl(): string;
  /** Required attribution string; must be displayed on the map. */
  readonly attribution: string;
  /** Whether this provider needs an API key that we do not have configured. */
  readonly requiresApiKey: boolean;
}
