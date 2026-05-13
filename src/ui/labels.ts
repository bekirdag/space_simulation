import { type Body } from "../physics/body";
import { type Mat4 } from "../math/mat4";

const ALWAYS_VISIBLE_BODY_NAMES = new Set([
  "Sun",
  "Mercury",
  "Venus",
  "Earth",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
]);
const LABEL_EDGE_MARGIN = 24;
const LABEL_NAV_MARGIN = 238;
const LABEL_BOTTOM_MARGIN = 86;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pinToViewport(nx: number, ny: number, cssW: number, cssH: number): ProjectedPoint {
  let dirX = nx;
  let dirY = ny;
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY) || (Math.abs(dirX) < 0.001 && Math.abs(dirY) < 0.001)) {
    dirX = 0;
    dirY = -1;
  }
  const scale = Math.max(Math.abs(dirX), Math.abs(dirY), 1);
  const edgeX = dirX / scale;
  const edgeY = dirY / scale;
  const rightLimit = cssW > 720 ? cssW - LABEL_NAV_MARGIN : cssW - LABEL_EDGE_MARGIN;
  const bottomLimit = Math.max(LABEL_EDGE_MARGIN, cssH - LABEL_BOTTOM_MARGIN);
  return {
    x: clamp((edgeX + 1) * 0.5 * cssW, LABEL_EDGE_MARGIN, Math.max(LABEL_EDGE_MARGIN, rightLimit)),
    y: clamp((1 - edgeY) * 0.5 * cssH, LABEL_EDGE_MARGIN, bottomLimit),
    pinned: true,
  };
}

interface ProjectedPoint { x: number; y: number; pinned: boolean }

function project(
  x: number, y: number, z: number,
  vp: Mat4, cssW: number, cssH: number,
  pin = false,
): ProjectedPoint | null {
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  const cx = vp[0]!*x + vp[4]!*y + vp[8]! *z + vp[12]!;
  const cy = vp[1]!*x + vp[5]!*y + vp[9]! *z + vp[13]!;
  const cz = vp[2]!*x + vp[6]!*y + vp[10]!*z + vp[14]!;
  const cw = vp[3]!*x + vp[7]!*y + vp[11]!*z + vp[15]!;
  /* eslint-enable */
  if (cw <= 0) {
    if (!pin) return null;
    const cwAbs = Math.max(Math.abs(cw), 1e-6);
    return pinToViewport(-cx / cwAbs, -cy / cwAbs, cssW, cssH);
  }
  const nx = cx / cw, ny = cy / cw, nz = cz / cw;
  const visibleBounds = pin ? 0.98 : 1.4;
  if (nz >= 0 && nz <= 1.02 && nx >= -visibleBounds && nx <= visibleBounds && ny >= -visibleBounds && ny <= visibleBounds) {
    return { x: (nx + 1) * 0.5 * cssW, y: (1 - ny) * 0.5 * cssH, pinned: false };
  }
  if (!pin) return null;
  return pinToViewport(nx, ny, cssW, cssH);
}

interface Projected { x: number; y: number; body: Body }

export class LabelManager {
  private container:  HTMLDivElement;
  private spans     = new Map<number, HTMLSpanElement>();
  private positions = new Map<number, Projected>(); // updated each frame
  private mouseX    = 0;
  private mouseY    = 0;

  constructor() {
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'fixed', inset: '0',
      pointerEvents: 'none', zIndex: '5', overflow: 'hidden',
    });
    document.body.appendChild(this.container);
    window.addEventListener('mousemove', e => { this.mouseX = e.clientX; this.mouseY = e.clientY; });
  }

  update(bodies: Body[], viewProj: Mat4): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    this.positions.clear();

    // Remove spans for departed bodies
    const ids = new Set(bodies.map(b => b.id));
    for (const [id, sp] of this.spans) {
      if (!ids.has(id)) { sp.remove(); this.spans.delete(id); }
    }

    for (const b of bodies) {
      if (!this.spans.has(b.id)) {
        const sp = document.createElement('span');
        sp.className = 'body-label';
        sp.textContent = b.name;
        this.container.appendChild(sp);
        this.spans.set(b.id, sp);
      }

      const sp  = this.spans.get(b.id)!;
      const pos = project(b.x, b.y, b.z, viewProj, cssW, cssH, ALWAYS_VISIBLE_BODY_NAMES.has(b.name));

      if (!pos) {
        sp.style.display = 'none';
        sp.classList.remove('pinned', 'hovered');
        continue;
      }

      this.positions.set(b.id, { x: pos.x, y: pos.y, body: b });
      sp.style.display = 'block';
      sp.classList.toggle('pinned', pos.pinned);
      sp.style.left    = `${pos.pinned ? pos.x : pos.x + 10}px`;
      sp.style.top     = `${pos.pinned ? pos.y : pos.y - 6}px`;

      const dx = this.mouseX - pos.x;
      const dy = this.mouseY - pos.y;
      sp.classList.toggle('hovered', Math.sqrt(dx*dx + dy*dy) < 32);
    }
  }

  /**
   * Return the nearest body whose screen-centre is within `threshold` CSS px
   * of the given screen coordinate. Returns null if nothing is close enough.
   */
  findBodyAtScreen(x: number, y: number, threshold = 28): Body | null {
    let best: Body | null = null;
    let bestDist = threshold;
    for (const { x: px, y: py, body } of this.positions.values()) {
      const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = body; }
    }
    return best;
  }
}
