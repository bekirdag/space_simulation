# Celestial Physics Simulation — Project Plan

**Stack:** WebGPU + TypeScript  
**Target:** Browser (Chrome 113+, Edge 113+, Firefox Nightly w/ flag)

---

## Goals

- Simulate N celestial bodies with accurate gravitational physics
- Real-time rendering of bodies and orbital trajectories
- Interactive controls: add/remove bodies, adjust time scale, pause/play
- Physically accurate integrator (no shortcuts)

---

## Architecture Overview

```
src/
├── gpu/
│   ├── compute.wgsl        # N-body gravity compute shader
│   ├── render.wgsl         # Vertex + fragment shaders for bodies & trails
│   └── device.ts           # WebGPU device/adapter init
├── physics/
│   ├── integrator.ts       # RK4 / Verlet time-step logic
│   ├── constants.ts        # G, AU, solar masses, time units
│   └── body.ts             # Body data structure (mass, pos, vel, color, radius)
├── scene/
│   ├── scene.ts            # Scene graph: holds all bodies, manages GPU buffers
│   ├── camera.ts           # 2D/3D pan, zoom, orbit controls
│   └── trails.ts           # Ring-buffer trail renderer
├── ui/
│   ├── controls.ts         # Play/pause, time warp, add body panel
│   ├── inspector.ts        # Click a body → show velocity, mass, orbit data
│   └── hud.ts              # FPS, body count, simulation time overlay
├── main.ts                 # Entry point: init GPU, scene, render loop
└── index.html
```

---

## Physics Design

### Integrator

Use **4th-order Runge-Kutta (RK4)** for accuracy.  
Fall back to **Leapfrog (Störmer-Verlet)** for large N (more GPU-friendly, symplectic — conserves energy better over long runs).

### Gravity

```
F = G * m1 * m2 / (r² + ε²)
```

`ε` (softening factor) prevents singularity when bodies get very close.

### Units

| Quantity | Unit |
|---|---|
| Distance | Astronomical Units (AU) |
| Mass | Solar masses (M☉) |
| Time | Earth years |
| G | 4π² AU³ / (M☉ · yr²) |

Using dimensionless solar-system units avoids floating-point precision issues with SI values.

### GPU Compute Strategy

- All body state (position, velocity, mass) stored in **GPU buffers**
- Compute shader dispatches one **workgroup per body**
- Each workgroup reads all other bodies and accumulates force
- Two ping-pong buffers: read current state → write next state
- **Barnes-Hut tree** (O(N log N)) added in Phase 3 for large N

---

## Rendering Design

- Bodies: instanced quads scaled by mass, colored by type
- Trails: ring-buffer of past positions per body, rendered as line strips
- Background: procedural star field (static, vertex shader)
- Camera: orthographic 2D initially, optional 3D orbit in Phase 3

---

## Development Phases

### Phase 1 — Foundation (Week 1)
- [ ] Project scaffold: Vite + TypeScript + ESLint
- [ ] WebGPU device initialization with fallback error UI
- [ ] Basic render pipeline: draw a quad on screen
- [ ] Body data structures and constants module
- [ ] CPU-side RK4 integrator (no GPU yet)
- [ ] Render N bodies as colored circles

**Milestone:** Solar system (Sun + 8 planets) running in browser at 60fps

---

### Phase 2 — GPU Compute (Week 2)
- [ ] Port integrator to WGSL compute shader
- [ ] GPU buffer management (ping-pong state buffers)
- [ ] Validate GPU physics output matches CPU reference
- [ ] Trail renderer (ring-buffer, line strip)
- [ ] Basic UI: play/pause, time warp slider (1x → 1000x)

**Milestone:** 500+ bodies running smoothly via GPU compute

---

### Phase 3 — Interaction & Polish (Week 3)
- [ ] Click-to-inspect body (velocity, mass, orbital period)
- [ ] Add body tool: place with initial velocity vector (drag to set)
- [ ] Collision detection + merge (inelastic — conserves momentum)
- [ ] Barnes-Hut spatial tree for O(N log N) scaling
- [ ] Preset scenarios: Solar System, binary stars, galaxy collision

**Milestone:** 5000+ bodies, interactive, presets working

---

### Phase 4 — Fidelity & Extras (stretch)
- [ ] Relativistic corrections (post-Newtonian, Mercury precession demo)
- [ ] Export simulation state as JSON (save/load)
- [ ] Record trajectory to video (canvas capture API)
- [ ] 3D camera with orbit controls (Three.js or raw WebGPU 3D)
- [ ] Lagrange point visualizer

---

## Tooling

| Tool | Purpose |
|---|---|
| Vite | Dev server + bundler (native ESM, fast HMR) |
| TypeScript 5 | Type safety |
| WGSL | GPU shaders (compute + render) |
| ESLint + Prettier | Code style |
| Vitest | Unit tests for physics integrator |

---

## Browser Requirements

WebGPU is **not available in all browsers** without flags. Target:

- Chrome 113+ (stable)
- Edge 113+ (stable)
- Safari 18+ (partial support)
- Firefox: behind `dom.webgpu.enabled` flag (not production-ready)

Show a graceful fallback message on unsupported browsers.

---

## Key Technical Risks

| Risk | Mitigation |
|---|---|
| WebGPU not supported | Detect + show clear error; consider WebGL fallback for Phase 1 |
| Floating point precision at large scales | Use AU-based units; consider double-precision emulation if needed |
| N-body O(N²) bottleneck | Barnes-Hut in Phase 3; GPU parallelism masks it up to ~2000 bodies |
| Trail buffer memory | Ring-buffer with fixed max trail length per body |
| Energy drift over long runs | Switch to symplectic Leapfrog for long simulations |
