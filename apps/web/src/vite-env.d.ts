/// <reference types="vite/client" />

/**
 * Build-time configuration. Declared explicitly rather than relying on the
 * generic `Record<string, string>` so a typo in an env var name is a type
 * error rather than a silently undefined basemap.
 */
interface ImportMetaEnv {
  /** MapTiler API key. Optional — the app falls back to a blank basemap. */
  readonly VITE_MAPTILER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
