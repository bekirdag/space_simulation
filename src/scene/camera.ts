import {
  type Vec3, type Mat4,
  normalize, cross, dot, sub,
  lookAt, perspective, mulMat4,
} from "../math/mat4";

const FOV_Y = Math.PI / 4; // 45° vertical field of view
const NEAR  = 0.001;       // AU
const FAR   = 2000;        // AU

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

    // Middle mouse button = orbit
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
          -Math.PI / 2 + 0.02,
          Math.min(Math.PI / 2 - 0.02, this.elevation + dy * sens),
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
      this.distance = Math.max(0.01, Math.min(1000, this.distance * factor));
    }, { passive: false });
  }

  travelTo(x: number, y: number, z: number, distance: number): void {
    this.target   = [x, y, z];
    this.distance = distance;
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

    // World "up" is Z (out of ecliptic). Near poles use Y to avoid gimbal flip.
    const worldUp: Vec3 = Math.abs(sinPhi) > 0.98 ? [0, 1, 0] : [0, 0, 1];

    const view = lookAt(eye, this.target, worldUp);
    const proj = perspective(FOV_Y, aspect, NEAR, FAR);
    const viewProj = mulMat4(proj, view);

    // Camera right and up in world space (for billboard quads)
    const fwd = normalize(sub(this.target, eye));
    const right = normalize(cross(fwd, worldUp));
    const up    = normalize(cross(right, fwd));

    this._uniforms = {
      viewProj,
      camRight: right,
      camUp:    up,
      focalY:   1 / Math.tan(FOV_Y / 2),
    };
    return this._uniforms;
  }
}
