import {
  type Vec3, type Mat4,
  lookAt, perspective, mulMat4,
} from "../math/mat4";

const FOV_Y = Math.PI / 4; // 45° vertical field of view
const NEAR  = 1e-8;        // AU, allows close body fly-ins without clipping
const FAR   = 50_000_000;  // AU, covers the galaxy catalog after Local Group-linear scaling
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
}

interface WheelZoomGoal {
  distance: number;
  remainingSteps: number;
  point?: Vec3;
}

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

  attach(canvas: HTMLCanvasElement): void {
    let orbiting = false;
    let panning  = false;
    let lastX = 0, lastY = 0;

    // Middle-click or right-click + drag = orbit; left-click drag = pan
    canvas.addEventListener("mousedown", (e) => {
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

    window.addEventListener("mouseup", (e) => {
      if (e.button === 1 || e.button === 2) { orbiting = false; canvas.style.cursor = "default"; }
      if (e.button === 0)                   { panning  = false; canvas.style.cursor = "default"; }
    });

    window.addEventListener("mousemove", (e) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;

      if (orbiting) {
        const fixedEye = !this.lockTarget ? (this._uniforms?.eye ?? this.currentEye()) : null;
        const sens = 0.006;
        this.azimuth   -= dx * sens;
        this.elevation  = Math.max(
          -Math.PI / 2 + ORBIT_POLE_MARGIN,
          Math.min(Math.PI / 2 - ORBIT_POLE_MARGIN, this.elevation + dy * sens),
        );
        if (fixedEye) this.setTargetFromEyeAndOrbit(fixedEye);
      }

      if (panning && this._uniforms) {
        // Move target in the camera's right/up plane
        const auPerPx = (this.distance * 2 * Math.tan(FOV_Y / 2)) / window.innerHeight;
        const r = this._uniforms.camRight;
        const u = this._uniforms.camUp;
        this.target[0] -= (dx * r[0] - dy * u[0]) * auPerPx;
        this.target[1] -= (dx * r[1] - dy * u[1]) * auPerPx;
        this.target[2] -= (dx * r[2] - dy * u[2]) * auPerPx;
      }
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.cancelTravelAnimation();
      const zoomingIn = e.deltaY < 0;
      const pointGoal = this.wheelZoomGoal?.point ? this.wheelZoomGoal : null;
      if (pointGoal?.point && this._uniforms) {
        const eye = this._uniforms.eye;
        const point = pointGoal.point;
        const dx = eye[0] - point[0];
        const dy = eye[1] - point[1];
        const dz = eye[2] - point[2];
        const currentDistance = Math.hypot(dx, dy, dz);
        if (Number.isFinite(currentDistance) && currentDistance > MIN_DISTANCE) {
          let nextDistance = currentDistance * (zoomingIn ? 0.9 : 1.1);
          if (zoomingIn && currentDistance > pointGoal.distance * 1.001) {
            const steps = Math.max(1, pointGoal.remainingSteps);
            const factor = clamp(Math.pow(pointGoal.distance / currentDistance, 1 / steps), 0.02, 0.995);
            nextDistance = currentDistance * factor;
            pointGoal.remainingSteps = steps - 1;
          }
          if (zoomingIn && (pointGoal.remainingSteps <= 0 || nextDistance <= pointGoal.distance * 1.001)) {
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
          return;
        }
      }

      const oldDist = this.distance;
      const activeGoal = zoomingIn && this.wheelZoomGoal && oldDist > this.wheelZoomGoal.distance * 1.001
        ? this.wheelZoomGoal
        : null;
      let factor = zoomingIn ? 0.9 : 1.1;
      if (activeGoal) {
        const steps = Math.max(1, activeGoal.remainingSteps);
        factor = clamp(Math.pow(activeGoal.distance / oldDist, 1 / steps), 0.02, 0.995);
        activeGoal.remainingSteps = steps - 1;
      }
      this.distance  = clampDistance(oldDist * factor);
      if (activeGoal && (activeGoal.remainingSteps <= 0 || this.distance <= activeGoal.distance * 1.001)) {
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
          const mx    = (e.clientX / cssW)  * 2 - 1;   // NDC x, right = +1
          const my    = -(e.clientY / cssH) * 2 + 1;   // NDC y, up = +1
          const shift = delta / this._uniforms.focalY;
          const asp   = cssW / cssH;
          const r     = this._uniforms.camRight;
          const u     = this._uniforms.camUp;
          this.target[0] += (mx * asp * r[0] + my * u[0]) * shift;
          this.target[1] += (mx * asp * r[1] + my * u[1]) * shift;
          this.target[2] += (mx * asp * r[2] + my * u[2]) * shift;
        }
      }
    }, { passive: false });
  }

  private cancelTravelAnimation(): void {
    this.travelAnimation = null;
    this.flightEffect = 0;
    this.flightSpaceWarp = 0;
    this.flightMotionBlur = 0;
  }

  private configureWheelZoomGoal(distance: number, steps: number, referenceDistance: number): void {
    const targetDistance = clampDistance(distance);
    if (!Number.isFinite(targetDistance) || targetDistance >= referenceDistance) {
      this.wheelZoomGoal = null;
      return;
    }
    this.wheelZoomGoal = {
      distance: targetDistance,
      remainingSteps: Math.max(1, Math.round(steps)),
    };
  }

  setWheelZoomGoal(distance: number, steps = 10): void {
    this.configureWheelZoomGoal(distance, steps, this.distance);
  }

  setWheelZoomPointGoal(x: number, y: number, z: number, closeDistance: number, steps = 10): void {
    const targetDistance = clampDistance(closeDistance);
    if (!Number.isFinite(targetDistance)) {
      this.wheelZoomGoal = null;
      return;
    }
    this.wheelZoomGoal = {
      distance: targetDistance,
      remainingSteps: Math.max(1, Math.round(steps)),
      point: [x, y, z],
    };
  }

  updateWheelZoomPoint(x: number, y: number, z: number): void {
    if (!this.wheelZoomGoal?.point) return;
    this.wheelZoomGoal.point = [x, y, z];
  }

  clearWheelZoomGoal(): void {
    this.wheelZoomGoal = null;
  }

  focusFromCurrentView(
    x: number,
    y: number,
    z: number,
    closeDistance: number,
    wheelSteps = 10,
    durationSeconds = 0,
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
    if (anim.fixedEye) {
      this.setViewFromEyeAndTarget(anim.fixedEye, [
        anim.fromTarget[0] + (anim.toTarget[0] - anim.fromTarget[0]) * t,
        anim.fromTarget[1] + (anim.toTarget[1] - anim.fromTarget[1]) * t,
        anim.fromTarget[2] + (anim.toTarget[2] - anim.fromTarget[2]) * t,
      ]);
    } else {
      this.target = anim.approachTarget
        ? [...anim.toTarget]
        : [
            anim.fromTarget[0] + (anim.toTarget[0] - anim.fromTarget[0]) * t,
            anim.fromTarget[1] + (anim.toTarget[1] - anim.fromTarget[1]) * t,
            anim.fromTarget[2] + (anim.toTarget[2] - anim.fromTarget[2]) * t,
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
      if (anim.fixedEye) {
        this.setViewFromEyeAndTarget(anim.fixedEye, anim.toTarget);
      } else {
        this.target = [...anim.toTarget];
        this.distance = anim.toDistance;
        this.azimuth = anim.toAzimuth;
        this.elevation = anim.toElevation;
      }
      this.flightEffect = 0;
      this.flightSpaceWarp = 0;
      this.flightMotionBlur = 0;
    }
  }

  travelTo(x: number, y: number, z: number, distance: number, durationSeconds = 0): void {
    const toTarget: Vec3 = [x, y, z];
    const toDistance = clampDistance(distance);
    this.wheelZoomGoal = null;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      this.travelAnimation = null;
      this.flightEffect = 0;
      this.flightSpaceWarp = 0;
      this.flightMotionBlur = 0;
      this.target = toTarget;
      this.distance = toDistance;
      return;
    }

    const durationMs = Math.max(1, durationSeconds * 1000);
    const timing = defaultTravelTiming(durationMs);
    const eye = this._uniforms?.eye ?? this.currentEye();
    const dx = eye[0] - toTarget[0];
    const dy = eye[1] - toTarget[1];
    const dz = eye[2] - toTarget[2];
    const cameraToTargetDistance = Math.hypot(dx, dy, dz);
    const approachTarget = durationMs >= TARGET_APPROACH_TRAVEL_MIN_MS &&
      Number.isFinite(cameraToTargetDistance) &&
      cameraToTargetDistance > MIN_DISTANCE;
    const approachAngles = approachTarget
      ? orbitAnglesFromDirection([dx, dy, dz])
      : { azimuth: this.azimuth, elevation: this.elevation };
    this.travelAnimation = {
      fromTarget: [...this.target],
      toTarget,
      fromDistance: approachTarget ? cameraToTargetDistance : this.distance,
      toDistance,
      fromAzimuth: approachAngles.azimuth,
      toAzimuth: approachAngles.azimuth,
      fromElevation: approachAngles.elevation,
      toElevation: approachAngles.elevation,
      startMs: performance.now(),
      durationMs,
      ...timing,
      motionBlur: true,
      spaceWarp: true,
      approachTarget,
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
