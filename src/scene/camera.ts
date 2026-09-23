import {
  type Vec3, type Mat4,
  lookAt, perspective, mulMat4,
} from "../math/mat4";
import { isSyntheticMouseEvent } from "../ui/input-mode";

const FOV_Y = Math.PI / 4; // 45° vertical field of view
const NEAR  = 1e-8;        // AU, allows close body fly-ins without clipping
const FAR   = 500_000_000; // AU, covers the galaxy catalog at the shared 80 000 AU/kpc scale (keep in sync with renderer/main/shaders)
const MIN_DISTANCE = 1e-7; // AU
const MAX_DISTANCE = FAR;
const CLOSEUP_VIEW_FILL = 0.88;
const ORBIT_POLE_MARGIN = 0.02;
const CINEMATIC_TRAVEL_ACCEL_MS = 500;
const CINEMATIC_TRAVEL_DECEL_MS = 1000;
const TARGET_APPROACH_TRAVEL_MIN_MS = 1000;

interface CameraTravelAnimation {
  fromTarget: Vec3;
  toTarget:   Vec3;
  fromDistance: number;
  toDistance:   number;
  fromAzimuth: number;
  toAzimuth: number;
  fromElevation: number;
  toElevation: number;
  startMs:  number;
  durationMs: number;
  accelMs: number;
  cruiseMs: number;
  decelMs: number;
  motionBlur: boolean;
  spaceWarp: boolean;
  approachTarget: boolean;
  fixedEye?: Vec3;
  /**
   * Live follow-point position when the animation started. While a follow
   * point is set (a tracked, moving body), the whole animated camera is
   * translated by the body's displacement since the start, so the flight is
   * computed in the body's co-moving frame and converges on the live body
   * without drifting or snapping at the end.
   */
  followOrigin: Vec3 | undefined;
  followShift: Vec3;
}

interface WheelZoomGoal {
  distance: number;
  remainingSteps: number;
  stepDistance: number;
  point?: Vec3;
  /** Never zoom closer to `point` than this (surface clearance of the goal body). */
  minDistance?: number;
}

/** One classic mouse-wheel notch in CSS px (DOM_DELTA_PIXEL). */
const WHEEL_NOTCH_PX = 100;
/** Zoom factor per notch: exp(-WHEEL_NOTCH_PX * k) ~= 0.9 (the old fixed 10% step). */
const WHEEL_ZOOM_PER_PX = Math.log(1 / 0.9) / WHEEL_NOTCH_PX;
// One event never zooms more than one classic notch (10%): Chrome reports
// 100-200 px per mouse notch depending on platform, trackpads far less.
const WHEEL_MAX_NOTCHES_PER_EVENT = 1;
/** Closest the camera may orbit a followed body, in body radii (keeps it out of the globe). */
const BODY_SURFACE_CLEARANCE = 1.03;

/** Normalise wheel deltaY to CSS px regardless of deltaMode (pixel/line/page). */
function wheelDeltaPx(e: WheelEvent): number {
  const dy = Number.isFinite(e.deltaY) ? e.deltaY : 0;
  if (e.deltaMode === 1) return dy * 16; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return dy * (typeof window !== "undefined" ? window.innerHeight : 800); // DOM_DELTA_PAGE
  return dy;
}

/** Elements (labels, reticle) that sit over the canvas but must not swallow camera wheel input. */
export const CAMERA_WHEEL_PASSTHROUGH_ATTR = "data-camera-wheel-passthrough";

function clampDistance(distance: number): number {
  return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function aspectLimitedNdcRadius(fill: number): number {
  if (typeof window === "undefined" || window.innerHeight <= 0) return fill;
  const aspect = window.innerWidth / window.innerHeight;
  return Math.max(0.25, Math.min(fill, fill * aspect));
}

function shortestAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function orbitAnglesFromDirection(direction: Vec3): { azimuth: number; elevation: number } {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(length) || length <= 0) {
    return { azimuth: 0, elevation: 0 };
  }

  return {
    azimuth: Math.atan2(direction[1], direction[0]),
    elevation: clamp(
      Math.asin(clamp(direction[2] / length, -1, 1)),
      -Math.PI / 2 + ORBIT_POLE_MARGIN,
      Math.PI / 2 - ORBIT_POLE_MARGIN,
    ),
  };
}

/** Phase angle (Sun-body-camera) used when framing a body after travel. */
const LIT_VIEW_PHASE_RAD = 35 * Math.PI / 180;
/** Views already this close to the Sun direction are lit enough; keep them. */
const LIT_VIEW_KEEP_RAD = 45 * Math.PI / 180;

/**
 * Viewing direction (target -> eye) that shows the target's sunlit side: the
 * current direction rotated toward the target->light direction until the phase
 * angle is LIT_VIEW_PHASE_RAD (minimal swing), or unchanged if already lit.
 */
function litViewDirection(current: Vec3, toLight: Vec3): Vec3 {
  const ll = Math.hypot(toLight[0], toLight[1], toLight[2]);
  const cl = Math.hypot(current[0], current[1], current[2]);
  if (!Number.isFinite(ll) || ll <= 0 || !Number.isFinite(cl) || cl <= 0) return current;
  const sx = toLight[0] / ll, sy = toLight[1] / ll, sz = toLight[2] / ll;
  const cx = current[0] / cl, cy = current[1] / cl, cz = current[2] / cl;
  const cosPhase = cx * sx + cy * sy + cz * sz;
  if (cosPhase >= Math.cos(LIT_VIEW_KEEP_RAD)) return [cx, cy, cz];
  // Component of the current view perpendicular to the light direction.
  let px = cx - cosPhase * sx;
  let py = cy - cosPhase * sy;
  let pz = cz - cosPhase * sz;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    // Looking straight from the night side: offset toward ecliptic north.
    px = -sz * sx; py = -sz * sy; pz = 1 - sz * sz;
    pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) { px = 1; py = 0; pz = 0; pl = 1; }
  }
  const c = Math.cos(LIT_VIEW_PHASE_RAD);
  const sn = Math.sin(LIT_VIEW_PHASE_RAD);
  return [sx * c + (px / pl) * sn, sy * c + (py / pl) * sn, sz * c + (pz / pl) * sn];
}

function interpolateTravelDistance(fromDistance: number, toDistance: number, t: number, logarithmic: boolean): number {
  const from = clampDistance(fromDistance);
  const to = clampDistance(toDistance);
  if (!logarithmic || from <= 0 || to <= 0) {
    return clampDistance(from + (to - from) * t);
  }

  const fromLog = Math.log(from);
  const toLog = Math.log(to);
  if (!Number.isFinite(fromLog) || !Number.isFinite(toLog) || Math.abs(fromLog - toLog) < 1e-6) {
    return clampDistance(from + (to - from) * t);
  }

  return clampDistance(Math.exp(fromLog + (toLog - fromLog) * t));
}

function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function defaultTravelTiming(durationMs: number): { accelMs: number; cruiseMs: number; decelMs: number } {
  const total = Math.max(1, durationMs);
  const edgeMs = CINEMATIC_TRAVEL_ACCEL_MS + CINEMATIC_TRAVEL_DECEL_MS;
  if (total <= edgeMs) {
    const scale = total / edgeMs;
    return {
      accelMs: CINEMATIC_TRAVEL_ACCEL_MS * scale,
      cruiseMs: 0,
      decelMs: CINEMATIC_TRAVEL_DECEL_MS * scale,
    };
  }

  const accelMs = CINEMATIC_TRAVEL_ACCEL_MS;
  const decelMs = CINEMATIC_TRAVEL_DECEL_MS;
  return {
    accelMs,
    cruiseMs: total - accelMs - decelMs,
    decelMs,
  };
}

function secondsToMs(value: number, fallbackSeconds: number): number {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : fallbackSeconds;
  return Math.max(0, seconds * 1000);
}

function cinematicTravelProgress(
  elapsedMs: number,
  durationMs: number,
  accelMs: number,
  cruiseMs: number,
  decelMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 1;

  const elapsed = clamp(elapsedMs, 0, durationMs);
  const safeAccelMs = Math.max(0, accelMs);
  const safeCruiseMs = Math.max(0, cruiseMs);
  const safeDecelMs = Math.max(0, decelMs);
  const travelArea = safeCruiseMs + (safeAccelMs + safeDecelMs) * 0.5;
  if (travelArea <= 0) {
    const linearT = elapsed / durationMs;
    return linearT * linearT * (3 - 2 * linearT);
  }

  const cruiseVelocity = 1 / travelArea;
  if (elapsed <= safeAccelMs) {
    return 0.5 * cruiseVelocity * elapsed * elapsed / Math.max(safeAccelMs, 1);
  }

  const accelDistance = 0.5 * cruiseVelocity * safeAccelMs;
  const cruiseEndMs = safeAccelMs + safeCruiseMs;
  if (elapsed <= cruiseEndMs) {
    return accelDistance + cruiseVelocity * (elapsed - safeAccelMs);
  }

  const decelElapsed = elapsed - cruiseEndMs;
  const cruiseDistance = cruiseVelocity * safeCruiseMs;
  const decelDistance =
    cruiseVelocity * decelElapsed -
    0.5 * cruiseVelocity * decelElapsed * decelElapsed / Math.max(safeDecelMs, 1);
  return clamp(accelDistance + cruiseDistance + decelDistance, 0, 1);
}

function cinematicTravelEffect(
  elapsedMs: number,
  durationMs: number,
  accelMs: number,
  decelMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;

  const elapsed = clamp(elapsedMs, 0, durationMs);
  const linearT = durationMs > 0 ? elapsed / durationMs : 1;
  const safeAccelMs = Math.max(0, accelMs);
  const safeDecelMs = Math.max(0, decelMs);

  let velocityRamp = 1;
  if (safeAccelMs > 0 && elapsed < safeAccelMs) {
    velocityRamp = elapsed / safeAccelMs;
  } else if (safeDecelMs > 0 && elapsed > durationMs - safeDecelMs) {
    velocityRamp = (durationMs - elapsed) / safeDecelMs;
  }

  const edgeFade = Math.sin(Math.PI * linearT);
  return clamp(velocityRamp * Math.sqrt(Math.max(0, edgeFade)), 0, 1);
}

export interface CameraUniforms {
  viewProj:   Mat4;
  camRight:   Vec3;
  camUp:      Vec3;
  focalY:     number; // = 1 / tan(fovY/2), for perspective-correct min size
  eye:        Vec3;   // camera world-space position (for distance-based fades)
  target:     Vec3;   // camera target, used for stable target-relative projection
  eyeOffset:  Vec3;   // eye - target, small even when target is galaxy-scale
  flightEffect: number; // 0..1 legacy combined cinematic travel effect strength
  flightSpaceWarp: number; // 0..1 cinematic screen-warp strength
  flightMotionBlur: number; // 0..1 cinematic radial motion-blur strength
}

export interface CameraSnapshot {
  target: Vec3;
  distance: number;
  azimuth: number;
  elevation: number;
  eye: Vec3;
}

export interface CameraFlightOptions {
  accelerationSeconds: number;
  flightSeconds: number;
  decelerationSeconds: number;
  motionBlur: boolean;
  spaceWarp: boolean;
}

export class Camera {
  // Orbit parameters
  target:    Vec3 = [0, 0, 0];
  distance   = 55;             // AU from target
  azimuth    = 0.6;            // radians, horizontal orbit angle
  elevation  = 0.5;            // radians, above ecliptic plane

  /**
   * When true (body is focused/tracked), scroll zoom only changes orbit radius.
   * When false (free exploration), right/middle drag free-looks from the current
   * eye and scroll zooms toward the screen point under the cursor.
   * Set by NavPanel.setFocusedBody / clearFocusedBody.
   */
  lockTarget = false;

  // Computed each frame by update()
  private _uniforms!: CameraUniforms;
  private travelAnimation: CameraTravelAnimation | null = null;
  private wheelZoomGoal: WheelZoomGoal | null = null;
  private flightEffect = 0;
  private flightSpaceWarp = 0;
  private flightMotionBlur = 0;
  /** Live position of the tracked (moving) body, refreshed every frame by the owner. */
  private followPoint: Vec3 | null = null;
  /** Physical radius of the followed body (0 = unknown); sets the orbit floor. */
  private followRadius = 0;
  /** Set when a wheel step engaged a point goal (camera now orbits that point). */
  private wheelPointEngaged = false;

  /**
   * Update the live position of the body the camera is tracking. Call once per
   * frame after physics, before update(). Travel animations started with
   * `follow` are carried along with this point so they converge on the live body.
   */
  setFollowPoint(x: number, y: number, z: number, radius?: number): void {
    if (radius !== undefined) this.followRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
    if (this.followPoint) {
      this.followPoint[0] = x;
      this.followPoint[1] = y;
      this.followPoint[2] = z;
    } else {
      this.followPoint = [x, y, z];
    }
  }

  clearFollowPoint(): void {
    this.followPoint = null;
    this.followRadius = 0;
  }

  /** Minimum orbit distance around the current target (body surface clearance when following). */
  private minOrbitDistance(): number {
    return this.followPoint && this.followRadius > 0
      ? clampDistance(this.followRadius * BODY_SURFACE_CLEARANCE)
      : MIN_DISTANCE;
  }

  /** True once after a wheel step moved the camera onto its point goal. */
  consumeWheelPointEngaged(): boolean {
    const engaged = this.wheelPointEngaged;
    this.wheelPointEngaged = false;
    return engaged;
  }

  get isTravelling(): boolean {
    return this.travelAnimation !== null;
  }

  get hasWheelZoomGoal(): boolean {
    return this.wheelZoomGoal !== null;
  }

  /**
   * Decide whether a new animation toward (x, y, z) should ride along with the
   * follow point. `undefined` = automatic: follow when the destination is the
   * currently tracked point.
   */
  private followOriginFor(x: number, y: number, z: number, follow: boolean | undefined): Vec3 | undefined {
    if (follow === true) {
      this.setFollowPoint(x, y, z);
      return [x, y, z];
    }
    if (follow === false || !this.followPoint) return undefined;
    const fp = this.followPoint;
    const gap = Math.hypot(x - fp[0], y - fp[1], z - fp[2]);
    const tolerance = Math.max(1e-12, this.distance * 1e-6);
    return gap <= tolerance ? [fp[0], fp[1], fp[2]] : undefined;
  }

  attach(canvas: HTMLCanvasElement): void {
    let orbiting = false;
    let panning  = false;
    let lastX = 0, lastY = 0;

    const endOrbit = (): void => { orbiting = false; if (!panning) canvas.style.cursor = "default"; };
    const endPan = (): void => { panning = false; if (!orbiting) canvas.style.cursor = "default"; };
    const endAllDrags = (): void => {
      orbiting = false;
      panning = false;
      canvas.style.cursor = "default";
    };

    // Capture the pointer on the canvas so the matching pointerup/mouseup is
    // delivered here even when released over a label or UI panel that stops
    // propagation. Without this a drag could get "stuck" on.
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    });

    // Middle-click or right-click + drag = orbit; left-click drag = pan
    canvas.addEventListener("mousedown", (e) => {
      // Touch input is handled by touch-controls.ts; ignore its compatibility mouse events.
      if (isSyntheticMouseEvent(e)) return;
      if (e.button === 1 || e.button === 2) {
        this.cancelTravelAnimation();
        orbiting = true;
        lastX = e.clientX; lastY = e.clientY;
        e.preventDefault();
        canvas.style.cursor = "move";
      } else if (e.button === 0) {
        this.cancelTravelAnimation();
        panning = true;
        lastX = e.clientX; lastY = e.clientY;
        canvas.style.cursor = "grabbing";
      }
    });

    // Prevent middle-click scroll; native context menu is suppressed by main.ts
    canvas.addEventListener("auxclick", (e) => e.preventDefault());

    // Capture phase so overlays that stopPropagation() cannot hide the release.
    window.addEventListener("mouseup", (e) => {
      if (e.button === 1 || e.button === 2) endOrbit();
      if (e.button === 0)                   endPan();
    }, { capture: true });
    window.addEventListener("pointercancel", endAllDrags, { capture: true });
    canvas.addEventListener("lostpointercapture", (e) => {
      // Capture is released on pointerup; if no mouse button is held anymore the drag is over.
      if (e.buttons === 0) endAllDrags();
    });
    window.addEventListener("blur", endAllDrags);

    window.addEventListener("mousemove", (e) => {
      // Self-heal: if the release was missed, the button mask says the drag is over.
      if (orbiting && (e.buttons & (2 | 4)) === 0) endOrbit();
      if (panning && (e.buttons & 1) === 0) endPan();

      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;

      if (orbiting) this.orbitBy(dx, dy);
      if (panning) this.panBy(dx, dy);
    });

    // Wheel is handled on window so zooming also works while the cursor is over
    // an entity label or the lock reticle (they need pointer-events for clicks).
    // Events from UI panels/inputs/modals are ignored so their own scrolling works.
    window.addEventListener("wheel", (e) => {
      const origin = e.target;
      const overScene =
        origin === canvas ||
        (origin instanceof Element && origin.closest(`[${CAMERA_WHEEL_PASSTHROUGH_ATTR}]`) !== null);
      if (!overScene) return;
      e.preventDefault();
      this.handleWheel(e);
    }, { passive: false });
  }

  /**
   * Orbit by a screen-space drag delta in CSS px (right/middle mouse drag,
   * one-finger touch drag). Free-looks from the current eye when no body is locked.
   */
  orbitBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    const fixedEye = !this.lockTarget ? (this._uniforms?.eye ?? this.currentEye()) : null;
    const sens = 0.006;
    this.azimuth   -= dx * sens;
    this.elevation  = Math.max(
      -Math.PI / 2 + ORBIT_POLE_MARGIN,
      Math.min(Math.PI / 2 - ORBIT_POLE_MARGIN, this.elevation + dy * sens),
    );
    if (fixedEye) this.setTargetFromEyeAndOrbit(fixedEye);
  }

  /** Pan the target in the camera's right/up plane by a drag delta in CSS px (left mouse drag, two-finger drag). */
  panBy(dx: number, dy: number): void {
    if (!this._uniforms || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const auPerPx = (this.distance * 2 * Math.tan(FOV_Y / 2)) / window.innerHeight;
    const r = this._uniforms.camRight;
    const u = this._uniforms.camUp;
    this.target[0] -= (dx * r[0] - dy * u[0]) * auPerPx;
    this.target[1] -= (dx * r[1] - dy * u[1]) * auPerPx;
    this.target[2] -= (dx * r[2] - dy * u[2]) * auPerPx;
  }

  /**
   * Zoom by a pinch scale ratio (>1 = fingers spread = zoom in) anchored at a
   * screen point. Reuses the wheel path (point goals, surface clamp, zoom to
   * cursor) by converting the ratio to equivalent wheel pixels.
   */
  pinchZoom(scale: number, clientX: number, clientY: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-6) return;
    let deltaPx = -Math.log(scale) / WHEEL_ZOOM_PER_PX;
    // Split large pinch steps into wheel-sized chunks (the wheel path clamps
    // each event to one notch).
    const maxChunk = WHEEL_MAX_NOTCHES_PER_EVENT * WHEEL_NOTCH_PX;
    let guard = 0;
    while (Math.abs(deltaPx) > 1e-9 && guard++ < 64) {
      const chunk = Math.max(-maxChunk, Math.min(maxChunk, deltaPx));
      this.zoomByPixels(chunk, clientX, clientY);
      deltaPx -= chunk;
    }
  }

  private handleWheel(e: WheelEvent): void {
    this.zoomByPixels(wheelDeltaPx(e), e.clientX, e.clientY);
  }

  private zoomByPixels(rawDeltaPx: number, clientX: number, clientY: number): void {
    if (rawDeltaPx === 0 || !Number.isFinite(rawDeltaPx)) return;
    this.cancelTravelAnimation();
    const zoomingIn = rawDeltaPx < 0;
    // Trackpads emit many small deltas, mouse wheels ~100 px per notch: scale
    // the zoom by the delta magnitude (clamped so one event can't jump too far).
    const maxDeltaPx = WHEEL_MAX_NOTCHES_PER_EVENT * WHEEL_NOTCH_PX;
    const deltaPx = Math.max(-maxDeltaPx, Math.min(maxDeltaPx, rawDeltaPx));
    const notches = Math.abs(deltaPx) / WHEEL_NOTCH_PX;
    const zoomFactor = Math.exp(deltaPx * WHEEL_ZOOM_PER_PX);
    const pointGoal = this.wheelZoomGoal?.point ? this.wheelZoomGoal : null;
    if (pointGoal?.point && this._uniforms) {
      const eye = this._uniforms.eye;
      const point = pointGoal.point;
      const dx = eye[0] - point[0];
      const dy = eye[1] - point[1];
      const dz = eye[2] - point[2];
      const currentDistance = Math.hypot(dx, dy, dz);
      if (Number.isFinite(currentDistance) && currentDistance > MIN_DISTANCE) {
        let nextDistance = Math.max(currentDistance * zoomFactor, pointGoal.minDistance ?? MIN_DISTANCE);
        if (zoomingIn && currentDistance > pointGoal.distance * 1.001) {
          const stepDistance = Number.isFinite(pointGoal.stepDistance) && pointGoal.stepDistance > 0
            ? pointGoal.stepDistance
            : (currentDistance - pointGoal.distance) / Math.max(1, pointGoal.remainingSteps);
          nextDistance = Math.max(pointGoal.distance, currentDistance - stepDistance * notches);
          pointGoal.remainingSteps -= notches;
        }
        if (zoomingIn && (pointGoal.remainingSteps <= 1e-6 || nextDistance <= pointGoal.distance * 1.001)) {
          nextDistance = pointGoal.distance;
          this.wheelZoomGoal = null;
        }
        this.setViewFromEyeAndTarget(
          [
            point[0] + dx / currentDistance * nextDistance,
            point[1] + dy / currentDistance * nextDistance,
            point[2] + dz / currentDistance * nextDistance,
          ],
          point,
        );
        this.lockTarget = true;
        // The camera now orbits the goal point; let the owner start tracking it.
        this.wheelPointEngaged = true;
        return;
      }
    }

    const oldDist = this.distance;
    const activeGoal = zoomingIn && this.wheelZoomGoal && oldDist > this.wheelZoomGoal.distance * 1.001
      ? this.wheelZoomGoal
      : null;
    let nextDistance = oldDist * zoomFactor;
    if (activeGoal) {
      const stepDistance = Number.isFinite(activeGoal.stepDistance) && activeGoal.stepDistance > 0
        ? activeGoal.stepDistance
        : (oldDist - activeGoal.distance) / Math.max(1, activeGoal.remainingSteps);
      nextDistance = Math.max(activeGoal.distance, oldDist - stepDistance * notches);
      activeGoal.remainingSteps -= notches;
    }
    this.distance  = clampDistance(nextDistance);
    if (this.lockTarget) this.distance = Math.max(this.distance, this.minOrbitDistance());
    if (activeGoal && (activeGoal.remainingSteps <= 1e-6 || this.distance <= activeGoal.distance * 1.001)) {
      this.distance = activeGoal.distance;
      this.wheelZoomGoal = null;
    }

    // Zoom toward cursor when free-exploring (no body lock).
    // Shifts target so the world point under the cursor stays fixed —
    // standard behaviour in Blender, UE, every 3D viewport.
    if (!this.lockTarget && this._uniforms) {
      const delta = oldDist - this.distance; // positive = zoomed in
      if (Math.abs(delta) > 1e-12) {
        const cssW  = window.innerWidth;
        const cssH  = window.innerHeight;
        const mx    = (clientX / cssW)  * 2 - 1;   // NDC x, right = +1
        const my    = -(clientY / cssH) * 2 + 1;   // NDC y, up = +1
        const shift = delta / this._uniforms.focalY;
        const asp   = cssW / cssH;
        const r     = this._uniforms.camRight;
        const u     = this._uniforms.camUp;
        this.target[0] += (mx * asp * r[0] + my * u[0]) * shift;
        this.target[1] += (mx * asp * r[1] + my * u[1]) * shift;
        this.target[2] += (mx * asp * r[2] + my * u[2]) * shift;
      }
    }
  }

  cancelTravelAnimation(): void {
    this.travelAnimation = null;
    this.flightEffect = 0;
    this.flightSpaceWarp = 0;
    this.flightMotionBlur = 0;
  }

  private configureWheelZoomGoal(distance: number, steps: number, referenceDistance: number): void {
    this.wheelPointEngaged = false;
    const targetDistance = clampDistance(distance);
    if (!Number.isFinite(targetDistance) || targetDistance >= referenceDistance) {
      this.wheelZoomGoal = null;
      return;
    }
    const remainingSteps = Math.max(1, Math.round(steps));
    const stepDistance = (referenceDistance - targetDistance) / remainingSteps;
    if (!Number.isFinite(stepDistance) || stepDistance <= 0) {
      this.wheelZoomGoal = null;
      return;
    }
    this.wheelZoomGoal = {
      distance: targetDistance,
      remainingSteps,
      stepDistance,
    };
  }

  setWheelZoomGoal(distance: number, steps = 10): void {
    this.configureWheelZoomGoal(distance, steps, this.distance);
  }

  setWheelZoomPointGoal(
    x: number,
    y: number,
    z: number,
    closeDistance: number,
    steps = 10,
    surfaceRadius = 0,
  ): void {
    this.wheelPointEngaged = false;
    const targetDistance = clampDistance(closeDistance);
    const currentEye = this._uniforms?.eye ?? this.currentEye();
    const referenceDistance = Math.hypot(currentEye[0] - x, currentEye[1] - y, currentEye[2] - z);
    if (!Number.isFinite(targetDistance) || !Number.isFinite(referenceDistance) || referenceDistance <= targetDistance) {
      this.wheelZoomGoal = null;
      return;
    }
    const remainingSteps = Math.max(1, Math.round(steps));
    const stepDistance = (referenceDistance - targetDistance) / remainingSteps;
    if (!Number.isFinite(stepDistance) || stepDistance <= 0) {
      this.wheelZoomGoal = null;
      return;
    }
    this.wheelZoomGoal = {
      distance: targetDistance,
      remainingSteps,
      stepDistance,
      point: [x, y, z],
      minDistance: Number.isFinite(surfaceRadius) && surfaceRadius > 0
        ? clampDistance(surfaceRadius * BODY_SURFACE_CLEARANCE)
        : MIN_DISTANCE,
    };
  }

  updateWheelZoomPoint(x: number, y: number, z: number): void {
    if (!this.wheelZoomGoal?.point) return;
    this.wheelZoomGoal.point = [x, y, z];
  }

  clearWheelZoomGoal(): void {
    this.wheelZoomGoal = null;
    this.wheelPointEngaged = false;
  }

  focusFromCurrentView(
    x: number,
    y: number,
    z: number,
    closeDistance: number,
    wheelSteps = 10,
    durationSeconds = 0,
    follow?: boolean,
  ): void {
    this.cancelTravelAnimation();

    const target: Vec3 = [x, y, z];
    const eye = this._uniforms?.eye ?? this.currentEye();
    const dx = eye[0] - target[0];
    const dy = eye[1] - target[1];
    const dz = eye[2] - target[2];
    const finalDistance = Math.hypot(dx, dy, dz);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0 && Number.isFinite(finalDistance) && finalDistance > MIN_DISTANCE) {
      const durationMs = Math.max(1, durationSeconds * 1000);
      const finalAngles = orbitAnglesFromDirection([dx, dy, dz]);
      this.travelAnimation = {
        fromTarget: [...this.target],
        toTarget: target,
        fromDistance: this.distance,
        toDistance: clampDistance(finalDistance),
        fromAzimuth: this.azimuth,
        toAzimuth: finalAngles.azimuth,
        fromElevation: this.elevation,
        toElevation: finalAngles.elevation,
        startMs: performance.now(),
        durationMs,
        accelMs: 0,
        cruiseMs: durationMs,
        decelMs: 0,
        motionBlur: false,
        spaceWarp: false,
        approachTarget: false,
        fixedEye: [eye[0], eye[1], eye[2]],
        followOrigin: this.followOriginFor(x, y, z, follow),
        followShift: [0, 0, 0],
      };
    } else {
      this.setViewFromEyeAndTarget(eye, target);
    }
    this.lockTarget = true;
    this.configureWheelZoomGoal(
      closeDistance,
      wheelSteps,
      Number.isFinite(finalDistance) ? finalDistance : this.distance,
    );
  }

  lookFromEyeToTarget(eye: Vec3, target: Vec3): void {
    this.cancelTravelAnimation();
    this.clearWheelZoomGoal();
    this.setViewFromEyeAndTarget(eye, target);
    this.lockTarget = true;
  }

  snapshot(): CameraSnapshot {
    return {
      target: [this.target[0], this.target[1], this.target[2]],
      distance: this.distance,
      azimuth: this.azimuth,
      elevation: this.elevation,
      eye: this.currentEye(),
    };
  }

  private setViewFromEyeAndTarget(eye: Vec3, target: Vec3): void {
    const dx = eye[0] - target[0];
    const dy = eye[1] - target[1];
    const dz = eye[2] - target[2];
    const rawDistance = Math.hypot(dx, dy, dz);

    this.target = [...target];
    if (Number.isFinite(rawDistance) && rawDistance > MIN_DISTANCE) {
      this.distance = clampDistance(rawDistance);
      this.azimuth = Math.atan2(dy, dx);
      this.elevation = clamp(
        Math.asin(clamp(dz / rawDistance, -1, 1)),
        -Math.PI / 2 + ORBIT_POLE_MARGIN,
        Math.PI / 2 - ORBIT_POLE_MARGIN,
      );
    }
  }

  private orbitOffset(): Vec3 {
    const cosPhi   = Math.cos(this.elevation);
    const sinPhi   = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    return [
      this.distance * cosPhi * cosTheta,
      this.distance * cosPhi * sinTheta,
      this.distance * sinPhi,
    ];
  }

  private setTargetFromEyeAndOrbit(eye: Vec3): void {
    const offset = this.orbitOffset();
    this.target = [
      eye[0] - offset[0],
      eye[1] - offset[1],
      eye[2] - offset[2],
    ];
  }

  private currentEye(): Vec3 {
    const offset = this.orbitOffset();
    return [
      this.target[0] + offset[0],
      this.target[1] + offset[1],
      this.target[2] + offset[2],
    ];
  }

  private updateTravelAnimation(nowMs: number): void {
    const anim = this.travelAnimation;
    if (!anim) {
      this.flightEffect = 0;
      this.flightSpaceWarp = 0;
      this.flightMotionBlur = 0;
      return;
    }

    const elapsedMs = nowMs - anim.startMs;
    const linearT = Math.min(1, Math.max(0, elapsedMs / anim.durationMs));
    const t = anim.fixedEye
      ? easeInOut(linearT)
      : cinematicTravelProgress(
          elapsedMs,
          anim.durationMs,
          anim.accelMs,
          anim.cruiseMs,
          anim.decelMs,
        );
    const effect = anim.fixedEye
      ? 0
      : cinematicTravelEffect(elapsedMs, anim.durationMs, anim.accelMs, anim.decelMs);
    this.flightSpaceWarp = anim.spaceWarp ? effect : 0;
    this.flightMotionBlur = anim.motionBlur ? effect : 0;
    this.flightEffect = Math.max(this.flightSpaceWarp, this.flightMotionBlur);

    // Co-moving frame: shift the whole flight by how far the followed body has
    // moved since the animation began (kept if the follow point goes away).
    if (anim.followOrigin && this.followPoint) {
      anim.followShift = [
        this.followPoint[0] - anim.followOrigin[0],
        this.followPoint[1] - anim.followOrigin[1],
        this.followPoint[2] - anim.followOrigin[2],
      ];
    }
    const sh = anim.followShift;
    const toTarget: Vec3 = [anim.toTarget[0] + sh[0], anim.toTarget[1] + sh[1], anim.toTarget[2] + sh[2]];
    const fromTarget: Vec3 = [anim.fromTarget[0] + sh[0], anim.fromTarget[1] + sh[1], anim.fromTarget[2] + sh[2]];
    const fixedEye: Vec3 | null = anim.fixedEye
      ? [anim.fixedEye[0] + sh[0], anim.fixedEye[1] + sh[1], anim.fixedEye[2] + sh[2]]
      : null;

    if (fixedEye) {
      this.setViewFromEyeAndTarget(fixedEye, [
        fromTarget[0] + (toTarget[0] - fromTarget[0]) * t,
        fromTarget[1] + (toTarget[1] - fromTarget[1]) * t,
        fromTarget[2] + (toTarget[2] - fromTarget[2]) * t,
      ]);
    } else {
      this.target = anim.approachTarget
        ? toTarget
        : [
            fromTarget[0] + (toTarget[0] - fromTarget[0]) * t,
            fromTarget[1] + (toTarget[1] - fromTarget[1]) * t,
            fromTarget[2] + (toTarget[2] - fromTarget[2]) * t,
          ];
      this.distance = interpolateTravelDistance(anim.fromDistance, anim.toDistance, t, anim.approachTarget);
      this.azimuth = anim.fromAzimuth + shortestAngleDelta(anim.fromAzimuth, anim.toAzimuth) * t;
      this.elevation = clamp(
        anim.fromElevation + (anim.toElevation - anim.fromElevation) * t,
        -Math.PI / 2 + ORBIT_POLE_MARGIN,
        Math.PI / 2 - ORBIT_POLE_MARGIN,
      );
    }

    if (linearT >= 1) {
      this.travelAnimation = null;
      if (fixedEye) {
        this.setViewFromEyeAndTarget(fixedEye, toTarget);
      } else {
        this.target = toTarget;
        this.distance = anim.toDistance;
        this.azimuth = anim.toAzimuth;
        this.elevation = anim.toElevation;
      }
      this.flightEffect = 0;
      this.flightSpaceWarp = 0;
      this.flightMotionBlur = 0;
    }
  }

  /**
   * Fly to (x, y, z). `follow` = true when the destination is a moving body
   * whose live position is fed via setFollowPoint(); undefined = follow only
   * when the destination is the current follow point.
   */
  travelTo(
    x: number,
    y: number,
    z: number,
    distance: number,
    durationSeconds = 0,
    follow?: boolean,
    litFrom?: Vec3,
  ): void {
    const toTarget: Vec3 = [x, y, z];
    const toDistance = clampDistance(distance);
    this.wheelZoomGoal = null;
    this.wheelPointEngaged = false;
    const eye = this._uniforms?.eye ?? this.currentEye();
    const dx = eye[0] - toTarget[0];
    const dy = eye[1] - toTarget[1];
    const dz = eye[2] - toTarget[2];
    const cameraToTargetDistance = Math.hypot(dx, dy, dz);
    // Final view angles: sunlit side of the destination when a light is given
    // (travel/focus framing only; later user orbiting is untouched).
    const currentViewDir: Vec3 = Number.isFinite(cameraToTargetDistance) && cameraToTargetDistance > MIN_DISTANCE
      ? [dx, dy, dz]
      : this.orbitOffset();
    const finalAngles = litFrom
      ? orbitAnglesFromDirection(litViewDirection(currentViewDir, [
          litFrom[0] - x,
          litFrom[1] - y,
          litFrom[2] - z,
        ]))
      : null;

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      if (follow === true) this.setFollowPoint(x, y, z);
      this.travelAnimation = null;
      this.flightEffect = 0;
      this.flightSpaceWarp = 0;
      this.flightMotionBlur = 0;
      this.target = toTarget;
      this.distance = toDistance;
      if (finalAngles) {
        this.azimuth = finalAngles.azimuth;
        this.elevation = finalAngles.elevation;
      }
      return;
    }

    const durationMs = Math.max(1, durationSeconds * 1000);
    const timing = defaultTravelTiming(durationMs);
    const approachTarget = durationMs >= TARGET_APPROACH_TRAVEL_MIN_MS &&
      Number.isFinite(cameraToTargetDistance) &&
      cameraToTargetDistance > MIN_DISTANCE;
    const approachAngles = approachTarget
      ? orbitAnglesFromDirection([dx, dy, dz])
      : { azimuth: this.azimuth, elevation: this.elevation };
    const endAngles = finalAngles ?? approachAngles;
    const followOrigin = this.followOriginFor(x, y, z, follow);
    this.travelAnimation = {
      fromTarget: [...this.target],
      toTarget,
      fromDistance: approachTarget ? cameraToTargetDistance : this.distance,
      toDistance,
      fromAzimuth: approachAngles.azimuth,
      toAzimuth: endAngles.azimuth,
      fromElevation: approachAngles.elevation,
      toElevation: endAngles.elevation,
      startMs: performance.now(),
      durationMs,
      ...timing,
      motionBlur: false,
      spaceWarp: true,
      approachTarget,
      followOrigin,
      followShift: [0, 0, 0],
    };
  }

  startCustomFlight(start: CameraSnapshot, end: CameraSnapshot, options: CameraFlightOptions): void {
    const accelMs = secondsToMs(options.accelerationSeconds, 0.5);
    const cruiseMs = secondsToMs(options.flightSeconds, 1);
    const decelMs = secondsToMs(options.decelerationSeconds, 0.5);
    const durationMs = Math.max(1, accelMs + cruiseMs + decelMs);
    this.clearWheelZoomGoal();
    this.target = [start.target[0], start.target[1], start.target[2]];
    this.distance = clampDistance(start.distance);
    this.azimuth = start.azimuth;
    this.elevation = clamp(start.elevation, -Math.PI / 2 + ORBIT_POLE_MARGIN, Math.PI / 2 - ORBIT_POLE_MARGIN);
    this.lockTarget = true;
    this.travelAnimation = {
      fromTarget: [start.target[0], start.target[1], start.target[2]],
      toTarget: [end.target[0], end.target[1], end.target[2]],
      fromDistance: clampDistance(start.distance),
      toDistance: clampDistance(end.distance),
      fromAzimuth: start.azimuth,
      toAzimuth: end.azimuth,
      fromElevation: start.elevation,
      toElevation: end.elevation,
      startMs: performance.now(),
      durationMs,
      accelMs,
      cruiseMs,
      decelMs,
      motionBlur: options.motionBlur,
      spaceWarp: options.spaceWarp,
      approachTarget: false,
      followOrigin: undefined,
      followShift: [0, 0, 0],
    };
  }

  distanceForViewRadius(radius: number, fill = CLOSEUP_VIEW_FILL): number {
    if (!Number.isFinite(radius) || radius <= 0) return MIN_DISTANCE;
    const focalY = 1 / Math.tan(FOV_Y / 2);
    const distance = (radius * focalY) / aspectLimitedNdcRadius(fill);
    return clampDistance(distance);
  }

  closeDistanceForRadius(radius: number): number {
    if (!Number.isFinite(radius) || radius <= 0) return MIN_DISTANCE;
    return clampDistance(Math.max(this.distanceForViewRadius(radius), radius * 1.25));
  }

  /** Compute and cache view-projection matrix + billboard vectors. */
  update(aspect: number): CameraUniforms {
    this.updateTravelAnimation(performance.now());
    // Surface clamp while orbiting a followed body (also covers other callers
    // that set `distance` directly). Flights end at >= 1.25 radii anyway.
    if (!this.travelAnimation && this.lockTarget && this.followPoint) {
      this.distance = Math.max(this.distance, this.minOrbitDistance());
    }

    const cosPhi   = Math.cos(this.elevation);
    const sinPhi   = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    const eye = this.currentEye();

    const right: Vec3 = [-sinTheta, cosTheta, 0];
    const up: Vec3 = [-sinPhi * cosTheta, -sinPhi * sinTheta, cosPhi];

    const view = lookAt(eye, this.target, up);
    const proj = perspective(FOV_Y, aspect, NEAR, FAR);
    const viewProj = mulMat4(proj, view);

    this._uniforms = {
      viewProj,
      camRight: right,
      camUp:    up,
      focalY:   1 / Math.tan(FOV_Y / 2),
      eye,
      target: [this.target[0], this.target[1], this.target[2]],
      eyeOffset: [
        eye[0] - this.target[0],
        eye[1] - this.target[1],
        eye[2] - this.target[2],
      ],
      flightEffect: this.flightEffect,
      flightSpaceWarp: this.flightSpaceWarp,
      flightMotionBlur: this.flightMotionBlur,
    };
    return this._uniforms;
  }
}
