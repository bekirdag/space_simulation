# CosmosMap

CosmosMap is a browser-based celestial simulation and universe map built with
WebGPU, TypeScript, and Vite. It renders a live solar-system simulation, maps
nearby stars, the Milky Way, galaxies, dust, constellations, nebulas, and a
visual Sagittarius A* black-hole lensing layer.

The project was created by [Bekir Dag](https://bekirdag.com) for his children,
so they can learn about the universe by moving through it. It was built with
help from Claude and Codex 5.5.

## Features

- WebGPU-rendered solar-system simulation with trails, labels, search, focus,
  top-center focus titles, NASA-backed object information, context menus, and
  time controls.
- NASA/JPL Horizons starting vectors cached for 33 simulated bodies: the Sun,
  planets, major moons, Pluto/Charon, and selected dwarf planets.
- Solar-system-barycentric state data, so the Sun has a real starting position
  and velocity instead of being treated as fixed at the origin.
- Local circular galactic-frame model that adds a small external tidal
  acceleration while keeping render coordinates centered near the solar system.
- Planet-system visibility rules: planets and the Sun stay visible, and moons
  appear as you focus or zoom into their parent system.
- Static render-only star field with 100,000 HYG 4.2 nearby visible stars.
- Searchable NASA Exoplanet Archive host-star catalog with 4,707 host stars.
  These stars can be searched and focused without being listed in the right nav.
- 200,000 Milky Way background stars and a 100,000-entry galaxy layer.
- NASA SVS constellation lines and titles.
- High-resolution visual Galactic dust map layer derived from NASA/GSFC LAMBDA
  data and anchored so its Galactic center aligns with Sagittarius A*.
- Visual Sagittarius A* black-hole lensing approximation using the physical
  event-horizon radius derived from a 4.3-million-solar-mass black hole.
- Camera-distance adjusted apparent brightness mode for bodies, Milky Way
  stars, and galaxies.

## Requirements

- Node.js 18 or newer.
- npm.
- A WebGPU-capable browser. Chrome 113+ and Edge 113+ are the best targets.
  Safari 18+ has partial WebGPU support. Firefox requires enabling WebGPU flags.

## Install

```sh
npm install
```

## Run Locally

Start the CosmosMap development backend. It wraps Vite and also serves the
NASA object-information API used by the top-center focus title:

```sh
npm run dev
```

Open the local URL printed by the server, usually `http://127.0.0.1:5173/`. If
that port is already in use, the server will choose the next available port.

## Build And Preview

Create a production build:

```sh
npm run build
```

Preview the built app locally with the same local NASA information backend:

```sh
npm run preview
```

## Validation

Run TypeScript validation:

```sh
npm run typecheck
```

Run the default test command:

```sh
npm test
```

At the moment, `npm test` is a typecheck alias. Browser smoke validation is done
manually or through headless Chrome when shader changes are made.

## Data And Cache Files

The app ships with generated data under `public/` so it can run immediately
after install:

- `public/cache/horizons/2026-05-13.json`: NASA/JPL Horizons vectors for the
  currently cached simulation start date. It contains 33 of 33 requested bodies
  and no warnings.
- `public/data/visible-stars-100k.bin`: compact binary render buffer for
  100,000 nearby visible stars.
- `public/data/visible-stars-100k.meta.json`: source metadata for the visible
  star field.
- `public/data/exoplanet-hosts.json`: searchable NASA Exoplanet Archive host
  stars.
- `public/data/milkyway-stars.bin`: 200,000 render-only Milky Way background
  stars.
- `public/data/galaxies-100k.bin`: 100,000 galaxies, combining real named
  entries with procedural deep-field fill.
- `public/cache/nasa/constellations-lines.geojson`: cached J2000 constellation
  line figures used by the Settings-controlled constellation overlay.
- `public/cache/nasa/constellation_figures_4k.tif` and
  `public/cache/nasa/constellations.meta.json`: NASA SVS Deep Star Maps 2020
  source reference for the constellation layer.
- `public/data/dust-map-mf2015.bin`: high-resolution visual dust overlay
  derived from NASA/GSFC LAMBDA Meisner & Finkbeiner 2015 data. Its all-sky
  Galactic coordinate center is placed at the simulation's Sagittarius A*
  position using the same 8,000 AU/kpc Milky Way scale as the star field.

Horizons data is loaded through the local backend at `/api/horizons`. The
backend serves `cache/nasa/horizons/<date>.json` first, seeds that runtime cache
from committed `public/cache/horizons/<date>.json` files when available, and
only then calls NASA/JPL Horizons with low concurrency and retry/backoff. The
browser no longer calls NASA/JPL directly for simulation startup or date jumps.
Focused-object information is requested from the local backend, which queries
NASA Images and caches normalized JSON plus same-origin image files under
`cache/nasa/object-info/`. Runtime backend caches under `cache/nasa/` are
intentionally git-ignored.

## Limits And Assumptions

CosmosMap is an explorable educational simulation, not a complete
astrophysical solver.

- Only the solar-system body list participates in N-body physics.
- Catalog stars, Milky Way background stars, galaxies, dust, constellations,
  nebulas, and black-hole lensing are render-only layers.
- Large star and galaxy catalogs are mapped visually and do not exert gravity.
- Galaxy distances are scaled with a Local Group linear range and a logarithmic
  deep-field range so large structures remain navigable in one scene.
- Brightness is tone-mapped for display and adjusted by camera distance. It is
  useful visually, but it is not a calibrated photometry pipeline.
- Sagittarius A* uses a physical event-horizon radius of about 0.085 AU
  derived from a 4.3-million-solar-mass black hole. The lensing/accretion
  visuals are still illustrative and are not a relativistic ray tracer.
- Galactic dust currently affects the visual overlay only; it does not change
  star brightness or physics. The NASA/GSFC LAMBDA source is a 2D total
  line-of-sight map, so CosmosMap renders it as a fixed Galactic sky shell,
  not as a true 3D dust-volume model.

## Culling And LOD

- Frustum culling stays in WGSL shaders so off-screen billboards can be skipped
  without accidentally removing visible galaxy or Milky Way regions.
- Occlusion culling is intentionally avoided because it is not meaningful for
  mostly empty space scenes.
- Screen-density reduction hides crowded simulated-body clusters when many
  neighboring bodies compress into a tiny screen area.
- Large star and galaxy caps are spread across octants so reducing catalog size
  does not simply cut off one side of the sky.

## Refresh Generated Data

These commands require network access.

Refresh the NASA Exoplanet Archive host-star catalog:

```sh
npm run catalog:exoplanets
```

Refresh the HYG visible star render buffer:

```sh
npm run catalog:stars
```

Refresh the NASA/GSFC LAMBDA dust overlay. The default build uses a 512x256
runtime grid; set `DUST_GRID_SCALE=1` for the older 256x128 asset or up to
`DUST_GRID_SCALE=4` for a denser local experiment.

```sh
npm run catalog:dust
```

Refresh the NASA/JPL Horizons cache for today:

```sh
npm run cache:horizons
```

Refresh one or more specific Horizons dates:

```sh
npm run cache:horizons -- 2026-05-13
npm run cache:horizons -- 2026-05-13 2026-06-01
```

## Project Layout

```text
src/catalog/              Star, galaxy, nebula, dust, and constellation data
src/gpu/                  WebGPU device, render pipelines, WGSL shaders
src/img/                  Source image assets
src/physics/              Bodies, constants, integration, moons, galactic frame
src/scene/                Camera and trail systems
src/services/horizons.ts  NASA/JPL Horizons client and cache loader
src/ui/                   HUD, labels, navigation, context menu
server/                   Local NASA Images object-info API and static server
scripts/                  Data generation and cache refresh scripts
public/cache/             Committed runtime cache files
public/data/              Generated catalog assets served by Vite
```

## Contributing

Issues and pull requests are welcome at
[github.com/bekirdag/space_simulation](https://github.com/bekirdag/space_simulation).
Useful contributions include data corrections, performance improvements,
educational UI improvements, source attribution improvements, and better
validation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

CosmosMap is released under the MIT License. See [LICENSE](LICENSE).
