# Celestia

Celestia is a browser-based celestial simulation built with WebGPU, TypeScript,
and Vite. It renders a live solar-system view, uses NASA/JPL Horizons data for
known bodies, and keeps large star catalogs in a separate render-only layer so
they do not affect the physics calculation.

## Features

- WebGPU-rendered solar-system simulation with trails, labels, focus controls,
  and time controls.
- NASA/JPL Horizons starting vectors cached for 33 simulated bodies: the Sun,
  planets, major moons, Pluto/Charon, and selected dwarf planets.
- Solar-system-barycentric state data, so the Sun has a real starting position
  and velocity instead of being treated as fixed at the origin.
- Local circular galactic-frame model that adds a small external tidal
  acceleration while keeping render coordinates centered near the solar system.
- Planet-system visibility rules: planets and the Sun stay visible, and moons
  appear as you focus or zoom into their parent system.
- Static render-only star field with 100,000 HYG 4.2 stars.
- Searchable NASA Exoplanet Archive host-star catalog with 4,707 host stars.
  These stars can be searched and focused without being listed in the right nav.
- Camera fixes for close zoom/focus behavior and orbit control stability.

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

Start the Vite development server:

```sh
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173/`. If that
port is already in use, Vite will choose the next available port.

## Build And Preview

Create a production build:

```sh
npm run build
```

Preview the built app locally:

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

At the moment, `npm test` is a typecheck alias. There is not yet a separate unit
or browser automation test suite.

## Data And Cache Files

The app ships with generated data under `public/` so it can run immediately
after install:

- `public/cache/horizons/2026-05-13.json`: NASA/JPL Horizons vectors for the
  currently cached simulation start date. It contains 33 of 33 requested bodies
  and no warnings.
- `public/data/visible-stars-100k.bin`: compact binary render buffer for 100,000
  visible stars.
- `public/data/visible-stars-100k.meta.json`: source metadata for the visible
  star field.
- `public/data/exoplanet-hosts.json`: searchable NASA Exoplanet Archive host
  stars.

Horizons data is loaded in this order: committed cache file, browser
`localStorage`, then live NASA/JPL Horizons fetch if no cache is available.

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
src/catalog/              Star catalog loading, generated fallback data, search
src/gpu/                  WebGPU device, render pipelines, WGSL shaders
src/physics/              Bodies, constants, integration, moons, galactic frame
src/scene/                Camera and trail systems
src/services/horizons.ts  NASA/JPL Horizons client and cache loader
src/ui/                   HUD, labels, and navigation
scripts/                  Data generation and cache refresh scripts
public/cache/             Committed runtime cache files
public/data/              Generated catalog assets served by Vite
```

## Notes

The star catalog is intentionally not part of the N-body physics state. This
keeps the simulation light enough for a laptop while still making mapped stars
visible and searchable.
