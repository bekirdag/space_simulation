import { type Camera, CAMERA_WHEEL_PASSTHROUGH_ATTR } from "./camera";
import { isSyntheticMouseEvent, markTouchActivity } from "../ui/input-mode";

/**
 * Touch gestures for the scene (Pointer Events, pointerType === "touch"):
 *
 *   one-finger drag   -> orbit (same as right/middle mouse drag), with gentle momentum
 *   two-finger pinch  -> zoom anchored at the pinch centre (same path as the wheel)
 *   two-finger drag   -> pan (same as left mouse drag)
 *   tap               -> select (same as left click)       [onTap]
 *   double-tap        -> travel close (same as double-click; detected by onTap timing)
 *   long-press        -> context menu (same as right click) [onLongPress]
 *
 * Gestures may start on the canvas or on any overlay marked with
 * CAMERA_WHEEL_PASSTHROUGH_ATTR (labels, reticle). Taps on such overlays are
 * left to their own click handlers; only drags/pinches are taken over.
 * Mouse and pen input is untouched.
 */
export interface TouchControlHandlers {
  /** Tap on the bare canvas (not on a label). */
  onTap(clientX: number, clientY: number): void;
  /** Finger held still on the canvas or a label. */
  onLongPress(clientX: number, clientY: number): void;
  /** Any new touch on the scene (used to dismiss transient UI). */
  onGestureStart?(): void;
}

const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 520;
const INERTIA_MIN_SPEED = 0.25;   // px/ms needed at release to start momentum
const INERTIA_STOP_SPEED = 0.015; // px/ms
const INERTIA_TIME_CONSTANT_MS = 260;
const INERTIA_MAX_SPEED = 3.5;    // px/ms
const VELOCITY_WINDOW_MS = 90;

interface TrackedTouch {
  id: number;
  x: number;
  y: number;
  onCanvas: boolean;
}

interface MoveSample { t: number; x: number; y: number }

export function attachTouchControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  handlers: TouchControlHandlers,
): void {
  // Browser panning/zooming would otherwise steal the gesture.
  canvas.style.touchAction = "none";

  const touches = new Map<number, TrackedTouch>();
  /** Ids of the (at most two) fingers driving the gesture, in arrival order. */
  let active: number[] = [];

  // One-finger state
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let moved = false;
  let tapCandidate = false;
  let gestureConsumed = false; // long-press fired or a second finger joined
  let longPressTimer: number | null = null;
  let samples: MoveSample[] = [];
  /** Finger whose long-press opened the menu; it no longer drives the camera. */
  let longPressPointer: number | null = null;

  // Two-finger state
  let lastCx = 0, lastCy = 0, lastDist = 0;

  // Momentum
  let inertiaRaf: number | null = null;
  let vx = 0, vy = 0;

  const isSceneTarget = (target: EventTarget | null): { scene: boolean; onCanvas: boolean } => {
    if (target === canvas) return { scene: true, onCanvas: true };
    if (target instanceof Element && target.closest(`[${CAMERA_WHEEL_PASSTHROUGH_ATTR}]`) !== null) {
      return { scene: true, onCanvas: false };
    }
    return { scene: false, onCanvas: false };
  };

  const clearLongPress = (): void => {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const stopInertia = (): void => {
    if (inertiaRaf !== null) cancelAnimationFrame(inertiaRaf);
    inertiaRaf = null;
    vx = 0; vy = 0;
  };

  const startInertia = (): void => {
    if (samples.length < 2) return;
    const now = performance.now();
    const last = samples[samples.length - 1]!;
    if (now - last.t > 100) return; // finger stopped before lifting
    const first = samples[0]!;
    const dt = last.t - first.t;
    if (dt <= 0) return;
    vx = (last.x - first.x) / dt;
    vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < INERTIA_MIN_SPEED) { vx = 0; vy = 0; return; }
    if (speed > INERTIA_MAX_SPEED) {
      vx *= INERTIA_MAX_SPEED / speed;
      vy *= INERTIA_MAX_SPEED / speed;
    }
    let prev = now;
    const step = (t: number): void => {
      const frameDt = Math.min(Math.max(t - prev, 0), 50);
      prev = t;
      camera.orbitBy(vx * frameDt, vy * frameDt);
      const decay = Math.exp(-frameDt / INERTIA_TIME_CONSTANT_MS);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < INERTIA_STOP_SPEED || camera.isTravelling) {
        inertiaRaf = null;
        return;
      }
      inertiaRaf = requestAnimationFrame(step);
    };
    inertiaRaf = requestAnimationFrame(step);
  };

  const pairMetrics = (): { cx: number; cy: number; dist: number } | null => {
    const a = touches.get(active[0] ?? -1);
    const b = touches.get(active[1] ?? -1);
    if (!a || !b) return null;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  };

  /** Re-baseline after the finger set changed so the view never jumps. */
  const rebaseline = (): void => {
    samples = [];
    if (active.length >= 2) {
      const m = pairMetrics();
      if (m) { lastCx = m.cx; lastCy = m.cy; lastDist = m.dist; }
    } else if (active.length === 1) {
      const t = touches.get(active[0]!);
      if (t) { lastX = t.x; lastY = t.y; }
    }
  };

  const resetAll = (): void => {
    clearLongPress();
    touches.clear();
    active = [];
    tapCandidate = false;
    gestureConsumed = false;
    moved = false;
    samples = [];
  };

  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    markTouchActivity();
    const { scene, onCanvas } = isSceneTarget(e.target);
    if (!scene) return;
    // On the bare canvas, cancelling pointerdown suppresses the compatibility
    // mouse events (mousedown/mouseup) so the mouse paths don't double-handle
    // the touch. Labels keep their default so their native click still fires.
    if (onCanvas) e.preventDefault();

    stopInertia();
    handlers.onGestureStart?.();
    touches.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, onCanvas });
    if (active.length >= 2) return; // third+ finger: ignored
    active.push(e.pointerId);
    camera.cancelTravelAnimation();

    if (active.length === 1) {
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      moved = false;
      gestureConsumed = false;
      tapCandidate = onCanvas;
      samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (active.length !== 1 || moved) return;
        gestureConsumed = true;
        tapCandidate = false;
        longPressPointer = active[0] ?? null;
        handlers.onLongPress(startX, startY);
      }, LONG_PRESS_MS);
    } else {
      // Second finger: pinch/pan from here on; this touch sequence is no tap.
      clearLongPress();
      tapCandidate = false;
      gestureConsumed = true;
      rebaseline();
    }
  }, { capture: true, passive: false });

  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") return;
    const t = touches.get(e.pointerId);
    if (!t) return;
    markTouchActivity();
    t.x = e.clientX;
    t.y = e.clientY;
    if (!active.includes(e.pointerId)) return;

    if (active.length >= 2) {
      const m = pairMetrics();
      if (!m) return;
      const scale = m.dist / lastDist;
      if (Number.isFinite(scale) && Math.abs(scale - 1) > 1e-4) camera.pinchZoom(scale, m.cx, m.cy);
      const pdx = m.cx - lastCx;
      const pdy = m.cy - lastCy;
      if (pdx !== 0 || pdy !== 0) camera.panBy(pdx, pdy);
      lastCx = m.cx; lastCy = m.cy; lastDist = m.dist;
      return;
    }

    // One finger
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_SLOP_PX) {
      moved = true;
      tapCandidate = false;
      clearLongPress();
    }
    if (!moved || longPressPointer === e.pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    camera.orbitBy(dx, dy);
    const now = performance.now();
    samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (samples.length > 2 && now - samples[0]!.t > VELOCITY_WINDOW_MS) samples.shift();
  }, { capture: true, passive: true });

  const endPointer = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerType !== "touch") return;
    markTouchActivity();
    const t = touches.get(e.pointerId);
    if (!t) return;
    touches.delete(e.pointerId);
    const wasActive = active.includes(e.pointerId);
    const hadPair = active.length >= 2;
    active = active.filter(id => id !== e.pointerId);

    if (wasActive && !hadPair && active.length === 0) {
      clearLongPress();
      const wasTap = tapCandidate && !moved && !gestureConsumed && !cancelled;
      const wasOrbit = moved && !gestureConsumed && !cancelled;
      tapCandidate = false;
      if (wasTap) handlers.onTap(t.x, t.y);
      else if (wasOrbit) startInertia();
    }

    if (wasActive && hadPair) {
      // Promote a waiting third finger, otherwise continue with one finger.
      for (const id of touches.keys()) {
        if (active.length >= 2) break;
        if (!active.includes(id)) active.push(id);
      }
      moved = true; // never turn the remainder into a tap
      rebaseline();
    }

    if (touches.size === 0) {
      longPressPointer = null;
      resetAll();
    }
  };

  window.addEventListener("pointerup", (e) => endPointer(e, false), { capture: true });
  window.addEventListener("pointercancel", (e) => endPointer(e, true), { capture: true });
  window.addEventListener("blur", () => { resetAll(); longPressPointer = null; stopInertia(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { resetAll(); longPressPointer = null; stopInertia(); }
  });

  // Safari's proprietary pinch events would zoom the page; the pointer path
  // above handles pinches itself.
  const preventGesture = (e: Event): void => e.preventDefault();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, preventGesture, { passive: false });
  }
  // Touch-move over the scene must never scroll or rubber-band the page.
  document.addEventListener("touchmove", (e) => {
    if (isSceneTarget(e.target).scene) e.preventDefault();
  }, { passive: false });
  // Long-press on a label must not open the native callout/menu.
  document.addEventListener("contextmenu", (e) => {
    if (isSceneTarget(e.target).scene && isSyntheticMouseEvent(e)) e.preventDefault();
  });
  // Mouse wheel stops momentum too.
  window.addEventListener("wheel", stopInertia, { passive: true });
  window.addEventListener("mousedown", stopInertia, { capture: true });
}
