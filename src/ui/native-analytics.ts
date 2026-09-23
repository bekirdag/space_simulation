import { BodyType } from "../physics/constants";

/** Event parameter values the iPad shell forwards to Firebase Analytics. */
export type NativeEventParams = Record<string, string | number>;

/**
 * Logs an anonymous usage event through the native iPad shell
 * (`window.CosmosMapNative.logEvent`, backed by Firebase Analytics).
 * No-op on the website and whenever the bridge is missing.
 *
 * Event and parameter names: letters, digits and "_", starting with a letter,
 * at most 40 characters. At most 25 parameters; strings are cut to 100 characters.
 */
export function logNativeEvent(name: string, params: NativeEventParams = {}): void {
  const bridge = typeof window !== "undefined" ? window.CosmosMapNative : undefined;
  const logEvent = bridge?.logEvent;
  if (typeof logEvent !== "function") return;
  try {
    logEvent.call(bridge, name, params);
  } catch {
    // Analytics must never break the app.
  }
}

const BODY_TYPE_NAMES: Record<BodyType, string> = {
  [BodyType.Star]: "star",
  [BodyType.Planet]: "planet",
  [BodyType.Moon]: "moon",
  [BodyType.Asteroid]: "asteroid",
  [BodyType.DwarfPlanet]: "dwarf planet",
  [BodyType.Exoplanet]: "exoplanet",
};

/** Human-readable body type for analytics parameters. */
export function bodyTypeName(type: BodyType): string {
  return BODY_TYPE_NAMES[type] ?? "body";
}
