/**
 * Input-mode helpers shared by the camera, canvas picking and the UI:
 * touch activity tracking (to drop compatibility mouse events synthesized from
 * touches), coarse-pointer detection and native-shell (iPad app) detection.
 */

/** Compatibility mouse events arrive shortly after the touch that caused them. */
const SYNTHETIC_MOUSE_WINDOW_MS = 800;

let lastTouchMs = -Infinity;

/** Record touch activity (called for every touch pointer event). */
export function markTouchActivity(): void {
  lastTouchMs = performance.now();
}

interface MouseEventWithCapabilities extends MouseEvent {
  sourceCapabilities?: { firesTouchEvents?: boolean } | null;
}

/**
 * True when a mouse event was most likely synthesized from a touch (the touch
 * gesture layer already handled it), so mouse-only handlers should ignore it.
 */
export function isSyntheticMouseEvent(e: MouseEvent): boolean {
  if ((e as MouseEventWithCapabilities).sourceCapabilities?.firesTouchEvents) return true;
  return performance.now() - lastTouchMs < SYNTHETIC_MOUSE_WINDOW_MS;
}

function matches(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Primary pointer is coarse (finger) - iPad, phones, touch-only laptops. */
export function isCoarsePointer(): boolean {
  return matches("(pointer: coarse)");
}

/** Any touch-capable device (also iPads reporting a desktop user agent). */
export function hasTouchInput(): boolean {
  return isCoarsePointer() || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 1 && matches("(any-pointer: coarse)"));
}

/** Object injected by the native iPad shell (WKWebView user script). */
export interface CosmosMapNativeBridge {
  platform?: string;
  version?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    CosmosMapNative?: CosmosMapNativeBridge;
  }
}

/** True when running inside the native CosmosMap app shell. */
export function isEmbeddedNativeApp(): boolean {
  return typeof window !== "undefined" && window.CosmosMapNative != null;
}

/** Max gap between the two taps of a touch double-tap. */
export const DOUBLE_TAP_MS = 350;
/** Max distance between the two taps of a touch double-tap (CSS px). */
export const DOUBLE_TAP_SLOP_PX = 32;

/**
 * Run `handler` on a mouse double-click AND on a touch double-tap. The touch
 * path is driven by `click` (not pointerup) so it runs after the element's own
 * single-click handlers, matching the mouse order click, click, dblclick.
 * Register this after the element's click listener.
 */
export function addDoubleActivateListener(el: HTMLElement, handler: (e: Event) => void): void {
  let lastPointerType = "";
  let lastTouchClickMs = -Infinity;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let suppressNativeDblUntil = 0;
  el.addEventListener("pointerdown", e => { lastPointerType = e.pointerType; });
  el.addEventListener("click", e => {
    if (lastPointerType !== "touch") return;
    const now = performance.now();
    const near = Math.hypot(e.clientX - lastTouchX, e.clientY - lastTouchY) <= DOUBLE_TAP_SLOP_PX;
    if (now - lastTouchClickMs <= DOUBLE_TAP_MS && near) {
      lastTouchClickMs = -Infinity;
      suppressNativeDblUntil = now + 600;
      handler(e);
      return;
    }
    lastTouchClickMs = now;
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
  });
  el.addEventListener("dblclick", e => {
    if (performance.now() < suppressNativeDblUntil) return;
    handler(e);
  });
}
