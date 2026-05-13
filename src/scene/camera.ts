import {
  type Vec3, type Mat4,
  lookAt, perspective, mulMat4,
} from "../math/mat4";

const FOV_Y = Math.PI / 4; // 45° vertical field of view
const NEAR  = 1e-8;        // AU, allows close body fly-ins without clipping
const FAR   = 180_000;     // AU, includes compressed nearby-star catalog
const MIN_DISTANCE = 1e-7; // AU
const MAX_DISTANCE = FAR;
const CLOSEUP_VIEW_FILL = 0.88;
const ORBIT_POLE_MARGIN = 0.02;

function clampDistance(distance: number): number {
  return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
}

function aspectLimitedNdcRadius(fill: number): number {
  if (typeof window === "undefined" || window.innerHeight <= 0) return fill;
  const aspect = window.innerWidth / window.innerHeight;
  return Math.max(0.25, Math.min(fill, fill * aspect));
}

export interface CameraUniforms {
  viewProj:   Mat4;
  camRight:   Vec3;
  camUp:      Vec3;
  focalY:     number; // = 1 / tan(fovY/2), for perspective-correct min size
}

export class Camera {
  // Orbit parameters
  target:    Vec3 = [0, 0, 0];
  distance   = 55;             // AU from target
  azimuth    = 0.6;            // radians, horizontal orbit angle
  elevation  = 0.5;            // radians, above ecliptic plane

  // Computed each frame by update()
  private _uniforms!: CameraUniforms;

  attach(canvas: HTMLCanvasElement): void {
    let orbiting = false;
    let panning  = false;
    let lastX = 0, lastY = 0;

    // Mouse wheel button drag = orbit
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        orbiting = true;
        lastX = e.clientX; lastY = e.clientY;
        e.preventDefault();
        canvas.style.cursor = "move";
      } else if (e.button === 0) {
        panning = true;
        lastX = e.clientX; lastY = e.clientY;
        canvas.style.cursor = "grabbing";
      }
    });

    // Prevent middle-click scroll / context-menu
    canvas.addEventListener("contextmenu",   (e) => e.preventDefault());
    canvas.addEventListener("auxclick",      (e) => e.preventDefault());

    window.addEventListener("mouseup", (e) => {
      if (e.button === 1) { orbiting = false; canvas.style.cursor = "default"; }
      if (e.button === 0) { panning  = false; canvas.style.cursor = "default"; }
    });

    window.addEventListener("mousemove", (e) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;

      if (orbiting) {
        const sens = 0.006;
        this.azimuth   -= dx * sens;
        this.elevation  = Math.max(
          -Math.PI / 2 + ORBIT_POLE_MARGIN,
          Math.min(Math.PI / 2 - ORBIT_POLE_MARGIN, this.elevation + dy * sens),
        );
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
      const factor = e.deltaY < 0 ? 0.9 : 1.1;
      this.distance = clampDistance(this.distance * factor);
    }, { passive: false });
  }

  travelTo(x: number, y: number, z: number, distance: number): void {
    this.target   = [x, y, z];
    this.distance = clampDistance(distance);
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
    const cosPhi   = Math.cos(this.elevation);
    const sinPhi   = Math.sin(this.elevation);
    const cosTheta = Math.cos(this.azimuth);
    const sinTheta = Math.sin(this.azimuth);

    const eye: Vec3 = [
      this.target[0] + this.distance * cosPhi * cosTheta,
      this.target[1] + this.distance * cosPhi * sinTheta,
      this.target[2] + this.distance * sinPhi,
    ];

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
    };
    return this._uniforms;
  }
}
