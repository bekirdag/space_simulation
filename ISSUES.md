# CosmosMap — known issues (audit 2026-09-23)

Status legend: **FIXED** = changed in the working tree (uncommitted, verified in Chrome/WebGPU), otherwise open.
P0 = user-visible breakage, P1 = clearly wrong, P2 = polish / hygiene.

## A. Camera, input, labels

| # | P | Issue | Root cause | Fix |
|---|---|---|---|---|
| A1 | P0 · **FIXED** | Mouse-wheel zoom does nothing over entity labels | Wheel listener only on the canvas (`src/scene/camera.ts:295`); labels re-enable `pointer-events` (`index.html:1194,1297,1323,1398`; Sgr A* label appended to `<body>` `labels.ts:1050`) so wheel never reaches canvas | Listen for wheel on `window` (`passive:false`, ignore UI panels) or forward label wheel events to the canvas |
| A2 | P0 · **FIXED** | Drag gets "stuck" when mouse is released over a label | Labels `stopPropagation` on `mouseup` (`labels.ts:399-405,487-488`); camera ends drag on `window` mouseup (`camera.ts:263`) | Only stop `click`/`dblclick` on labels, or use `pointerup` + `setPointerCapture` |
| A3 | P0 · **FIXED** | Target wiggles while flying to it (double-click / Enter) | Animation lerps toward a *frozen* snapshot `anim.toTarget` (`camera.ts:575-588`) that overwrites the live body position set by `nav.updateFocusedBody()` each frame; body keeps moving, uneven physics steps/frame (`main.ts:~2715`) | Animate toward the live body (follow id/callback), interpolate view angles instead of the target point |
| A4 | P0 · **FIXED** | Target wiggles when panning/orbiting after it is centred | Wheel-zoom focus path sets `lockTarget` on a fixed point and never enables body tracking (`nav.ts:281,342,368-372`, `camera.ts:316-328`); orbit happens around empty space while the body drifts | Enable body tracking when the wheel goal completes |
| A5 | P1 · **FIXED** | Label/reticle jumps around a nearly centred target | `offsetLabelToObjectOutskirts` direction flips when body is a few px from centre (`labels.ts:~180-213`); positions rounded to whole CSS px (`labels.ts:589,636,657`) | Dead-zone/smoothing for the direction; fractional `translate3d` |
| A6 | P1 · **FIXED** | Trails, nebula/MW 3D models, constellations jitter when zoomed close | Absolute world coords × f32 `viewProj` (`trail.wgsl:51`, `milkyway-model.wgsl:78`, `nebula*.wgsl`, `dust*.wgsl`, `constellation.wgsl:20`); `center - target` in f32 (`solar-system-model.wgsl:145`) | Upload camera/target-relative positions computed in f64 on CPU (as `uploadBodies` already does) |
| A7 | P1 | Frame hitches | Per-label `offsetWidth/Height` read after style writes → forced layout per label per frame (`labels.ts:585`) | Cache sizes / batch reads before writes |
| A8 | P1 · **FIXED** | Enter after clicking a label runs the wrong action | Label keeps focus with `role=button`; global Enter handler ignores it (`main.ts:1882`) | Blur label after activation |
| A9 | P2 | Left-drag pan does nothing while tracking a body | `updateFocusedBody` resets target every frame (`nav.ts:345`) | Pan an offset or release tracking |
| A10 | P2 · **FIXED** | Trackpad zoom far too fast | Each wheel event = fixed 10% step, ignores `deltaY`/`deltaMode` (`camera.ts:298`) | `Math.exp(-deltaY*k)` |
| A11 | P2 | Labels overlap in crowded systems | No collision avoidance (`labels.ts:575-590`) | Simple greedy declutter |
| A12 | P2 · **FIXED** | Search "No match" renders the query as HTML (self-XSS) | `innerHTML` with raw query (`nav.ts:691`) | Use `textContent` |

## B. Stars

| # | P | Issue | Root cause | Fix |
|---|---|---|---|---|
| B1 | P0 · **FIXED** | Stars wink/twinkle while rotating (right-drag) | Sub-pixel aliasing: point core `exp(-d²·46)` ≈ 0.2 px wide inside a ~1.6-2 px quad (`star.wgsl:~188-224`, `MIN_PX=2.5` `renderer.ts:2726`), HDR ×240 then bloom threshold (`bloom-extract.wgsl:34`) amplifies on/off; no MSAA. Same profile in `milkyway.wgsl:157-188` | Band-limited Gaussian in pixel units (σ ≥ 0.7-1 px), ≥ 3 px quad, conserve flux, clamp star HDR before bloom; optional 4× MSAA |
| B2 | P0 · **FIXED** | Stars near Sgr A* appear twice | Scene-lensing blended unlensed + lensed image (`blackhole.wgsl` `apply_black_hole_scene_lensing`) | **FIXED** – return only the lensed sample; direction now aspect-correct |
| B3 | P0 · **FIXED** | Catalog stars tilted 23.44° vs everything else (planets, Milky Way field, nebulas, dust, Sgr A*) | HYG buffer, named nearby stars, exoplanet hosts and constellation lines were equatorial; world frame is ecliptic (Horizons `REF_PLANE=ECLIPTIC`) | **FIXED** – `equatorialToEcliptic` / `equatorialBufferToEcliptic` in `src/catalog/stars.ts`, applied in `stars.ts`, `nearby-stars.ts`, `constellations.ts` |
| B4 | P0 · **FIXED** | Stars and Milky Way objects use different distance scales | Catalog stars 80 AU/pc (`stars.ts:6`, `nearby-stars.ts:42`, `build-visible-stars.mjs`); Milky Way field, Sgr A*, nebulas, MW 3D models, dust 8 AU/pc (`build-milkyway-stars.mjs`, `nebulas.ts:974`, `milkyway-models.ts:53`). E.g. Orion Nebula (412 pc) renders 5× *closer* than Betelgeuse (197 pc); catalog stars within 1 kpc extend 10× past their real galactic position | Unify on one scale (needs decision — see note) |
| B5 | P1 | Brightest stars missing (Sirius, Canopus, Arcturus, Hadar, Achernar, Aludra); `check-constellations.mjs` fails with 21 endpoints | Named nearby anchors are removed from the HYG buffer at build time; constellation lines then snap to the wrong star | Keep anchors in the buffer (dedupe against labels instead) or snap to anchor positions |
| B6 | P1 | Soft blurry star sprites around the galactic centre | Separate soft-sprite layer, unchanged by the galaxies, black hole and brightness toggles; source not yet identified | Investigate |
| B7 | P2 | Nearby-star distances off | Mira 273→~92 pc, Alpha Lupi 114→~142, Alnitak 387→~226, Naos 429→~330, Mirfak 181→~155 (`nearby-stars.ts`) | Correct values |

## C. Sagittarius A* (black hole)

| # | P | Issue | Root cause | Fix |
|---|---|---|---|---|
| C1 | P0 · **FIXED** | Disk cut along a straight line / vanishes a little zoomed out; shadow disappears | Ray-march starts at the camera with 72 × 0.85 Rs steps ≈ 61 Rs reach (`blackhole.wgsl:52,307,330`); between ~76 and 850 Rs nothing renders (image LOD starts at 850 Rs, `:55`) | Intersect bounding sphere (~120 Rs) and start marching there; distance-scaled step size; ~150-200 steps |
| C2 | P0 · **FIXED** | Near side of disk hidden behind the black shadow | Shadow multiplied over already-accumulated disk light (`blackhole.wgsl:359-366`) instead of front-to-back compositing | Composite front-to-back: `alpha += (1-alpha)*shadowCov`, no `color *= …`; final = `color + base*(1-alpha)` |
| C3 | P1 · **FIXED** | Photon ring and black circle don't line up | Shadow/ring are thresholds on coarsely sampled `minR`; bending strength scaled by the fade (`:326,478`) | Fine steps (C1), bending strength 1.0, fade the output only |
| C4 | P0 · **FIXED** | Blurry stars visible inside the shadow | Bloom added *after* black-hole composite (`blackhole.wgsl:491,533`); flight-warp/motion-blur resample raw scene (`:513-525`); image LOD shadow capped at 72-90% opacity (`:418-419`) | Add bloom before compositing (or composite into its own target before bloom); opaque LOD shadow sized from the real shadow radius; no overlap of LOD ranges |
| C5 | P2 · **FIXED** | Far-side lensed disk arc missing | Only first disk crossing used (`diskCrossings < 1`, `:337`) | Allow 2-3 crossings |
| C6 | P2 · **FIXED** | Trails drawn over the black hole | Trails pass after BH pass (`renderer.ts:3010`) | Reorder |

## D. 3D models / skins

| # | P | Issue | Root cause | Fix |
|---|---|---|---|---|
| D1 | P0 · **FIXED** | Earth unreadable | `src/models/earth.glb` has 2 outer shells with empty materials → opaque white; surface has emissive [1,1,1] added everywhere (`solar-system-model.wgsl:191`); 672 tris each | Revert to NASA `solar-earth.glb` (pre-5fe4dd5) or re-export surface only with emissive 0; skip untextured shells; use emissive only with an emissive map |
| D2 | P0 · **FIXED** | Every planet and the Sun: pole lies on the equator (axis/rotation "wrong") | glTF is Y-up but shader maps y→`up`, z→`axis` (`solar-system-model.wgsl:136-144`); same for built-in sphere | Map `x→right, y→axis, z→-up` (also for normals). Rotation tables themselves match IAU/NAIF pck00011 |
| D3 | P1 · **FIXED** | Textures not aligned to prime meridian | No per-model longitude offset (Mercury/Mars 225°, Jupiter/Saturn 315°, Venus/Uranus/Neptune 255.4°, Earth 0°) | `lonOffsetDeg` per entry in `solar-system-models.ts` |
| D4 | P1 · **FIXED** | Saturn globe at 43% size, rings vertical | Scale from whole-model bbox incl. rings (`model-loader.ts:229`) + D2 | Scale from the sphere part |
| D5 | P0 · **FIXED** | Nebula/star models render as speckled grey spheres (screenshot) | Loader keeps every Nth triangle (`model-loader.ts:230,267`: 1/2 Crab … 1/9 Cas A Green Monster); drawn with no depth and no culling (`renderer.ts:1346`) | Use full mesh with index buffer or pre-simplify offline (meshoptimizer/gltf-transform); enable depth + back-face culling. Or delete untextured Cygnus Loop, BP Tauri, Cas A 2023/2025 |
| D6 | P1 · partial (log depth in model pipelines only) | Z-fighting between close surfaces | Standard-Z `depth24plus`, near 1e-8 / far 5e7 (`renderer.ts:49,56`) | Reversed-Z `depth32float` |
| D7 | P1 · **FIXED for bodies** | No mipmaps, sRGB mishandled, normal/emissive maps ignored | `rgba8unorm`, no mips (`renderer.ts:2066-2079`) | `rgba8unorm-srgb` + mip generation |
| D8 | P1 · **FIXED** | Moons and dwarf planets have no 3D skins | No entries in `SOLAR_SYSTEM_MODEL_ASSETS` | Textured-sphere path (built-in UV sphere + equirect map); NASA/USGS maps for Moon, Galilean moons, Titan, Enceladus, Triton, Pluto, Charon, Ceres; Haumea needs ellipsoid scale. Fix D2 first |
| D9 | P2 · **FIXED** | Untracked `src/models/sun.glb`, `venus.glb` unused (Venus has an untextured atmosphere shell that would repeat D1) | — | Delete |

## E. Physics & data

| # | P | Issue | Where | Fix |
|---|---|---|---|---|
| E1 | P1 | Sun GM off by 3.8e-5 (≫ modelled GR effect), ~100″/yr drift at Earth | `constants.ts:3` `G = 4π²` | `(0.01720209895*365.25)**2` |
| E2 | P1 | GR term uses barycentric velocity (wrong for moons) | `integrator.ts:33,52-57` | Use velocity relative to primary |
| E3 | P2 | Integrator does 2× N² per step + allocations; trails recorded per sub-step | `integrator.ts:84-104`, `trail-system.ts:92` | Reuse accelerations; record once per frame |
| E4 | P2 | J2 inconsistencies | Mars pole (pre-2015) `oblateness.ts:81-86`; Uranus/Neptune J2 vs reference radius `:67-76` | Update |
| E5 | P2 | Rotation uses UTC instead of TDB (69 s) | `rotations.ts:28,190` | Add 69.184 s |
| E6 | P2 · **FIXED** | Galactic orbit plane / Sgr A* distance inconsistent (8.178 vs 8.5 kpc, wrong plane) | `galactic-frame.ts:38-44` | Use real GC direction and one R₀ |
| E7 | P2 | Old moon masses | Ariel, Umbriel, Titania, Oberon, Miranda (`moons.ts`); Haumea radius (`presets.ts`) | Jacobson 2014 values |

## F. Info box

| # | P | Issue | Where | Fix |
|---|---|---|---|---|
| F1 | P1 · **FIXED** | Generic hits ("Mapped star", "Milky Way star") fetch random Wikipedia pages, cached 30 days | `main.ts:2218,2279`; `object-info.mjs:21-23` | Skip lookup for generic hits |
| F2 | P1 · **FIXED** | Ambiguous moon names (Mimas, Tethys, Dione, Rhea, Iapetus, Miranda, Ariel, Umbriel, Titania, Oberon) can match mythology/Shakespeare | `WIKIPEDIA_OBJECT_PAGES` `object-info.mjs:44-81` | Add explicit "(moon)" pages |
| F3 | P1 | Wrong Local Group galaxy coordinates/distances | `galaxies.ts:101-138` (Tucana II, Hydrus I, Reticulum II, Phoenix, Antlia, And I/III/V/VI/VII/X/XVI, M65/M66/M96) | Re-source from McConnachie 2012 / NED |

## G. Server & robustness

| # | P | Issue | Where | Fix |
|---|---|---|---|---|
| G1 | P0 · **FIXED** | A malformed URL crashes the whole server (`/api/model-assets/%E0%A4%A`) | `model-assets.mjs:204` `decodeURIComponent`, no try/catch in request handler (`dev.mjs`, `index.mjs`) | try/catch → 400; wrap handlers → 500 |
| G2 | P0 · **FIXED** | Render loop dies permanently on any exception; device-lost just freezes | `main.ts:2930`, `device.ts:21-23` | try/finally around frame; error overlay on device loss |
| G3 | P1 · **FIXED** | Unhashed `/data`, `/textures`, `/cache`, `/api/model-assets` served `immutable` for 1 year → regenerated data never reaches browsers | `dev.mjs:14,58-67`, `index.mjs:109`, `model-assets.mjs:17` | `no-cache` + ETag, or content-hash URLs |
| G4 | P1 | Partial Horizons snapshots cached forever | `horizons.mjs:256-334,436` | Don't persist when targets are missing |
| G5 | P1 | Canvas size not clamped to `maxTextureDimension2D` (black canvas on 5K/6K) | `main.ts:1035-1039` | Clamp |
| G6 | P2 · **FIXED** | No fetch timeouts / duplicate concurrent model downloads | `object-info.mjs:342-355,569`, `model-assets.mjs` | Timeouts; in-flight dedupe |
| G7 | P2 | Bodies uploaded twice per frame; settings `input` resets physics accumulator | `main.ts:2737,2857,1159` | Remove redundant upload |

## H. Repo hygiene

- `node_modules/` (334 files incl. macOS-only binaries) is committed despite `.gitignore` → `git rm -r --cached node_modules`.
- `.claude/settings.local.json` tracked → untrack + ignore.
- `server/model-assets.mjs:41` serves `src/models/earth.glb` from the source tree at runtime (production deploy needs `src/`).

## Note on B4 (scale) — resolved

Everything now uses 80 visual AU/pc (80 000 AU/kpc), defined once in `src/catalog/scale.ts` (also R0 = 8.178 kpc and the precise galactic→ecliptic matrix). `public/data/milkyway-stars.bin` was regenerated; the galaxy catalog binary is rescaled ×10 at load time (rebuild needs VizieR/Simbad); camera far plane is 5e8.

## I. Follow-ups found while fixing

| # | P | Issue | Notes |
|---|---|---|---|
| I1 | P1 · **FIXED** | Orbit trails and background stars draw on top of planets, moons and nebula models | Star/trail passes aren't depth-tested against bodies/models (seen on Earth, Moon, Cygnus Loop) |
| I2 | P2 | First wheel step after single-clicking a body jumps the view onto it | Pre-existing; add a short transition |
| I3 | P2 | Free cursor-zoom with nothing selected can still fly inside a body | Surface clamp only applies to the tracked body |
| I4 | P2 · **FIXED** | `src/models/earth.glb` and `localGlb` helper in `server/model-assets.mjs` now unused; Matteo Pascale Earth credit still in `index.html`/`README.md` | Remove |
| I5 | P2 · **FIXED** | Crab (dark blue) and G292 (dark red) models look dim | Source material colours. Structure meshes now ignore the GLB material colour and render as glowing gas (`milkyway-model.wgsl` fs_absorb + fs_glow: extinction pass then additive fresnel/limb-weighted emission, per-model Chandra-style palettes in `milkyway-models.ts` `glow`); model-backed 2D nebulae crossfade to the mesh (`nebula.wgsl` handoff). BP Tauri model removed (capped-cylinder disk looked like a glass can). |
| I6 | P2 · **FIXED** | C6 still open: trails drawn after the black-hole pass | Needs trails rendered into the HDR scene |
| I7 | P0 · **FIXED** | Earth faceted (~24-segment silhouette) and skinned with a land/water mask | GLB planets replaced by ray-traced ellipsoid impostors (`src/gpu/body-surfaces.ts`, `body-surface.wgsl`) with content-hashed equirect maps + mipmaps (`scripts/build-body-textures.mjs`, `public/textures/bodies/manifest.json`); all moons/dwarf planets skinned; Saturn rings |
| I8 | P0 · **FIXED** | White dot beside Sgr A* | Procedural Milky Way star 1.16 AU from the black hole (inside the rendered disk); generator now keeps 24 AU around Sgr A* clear (`build-milkyway-stars.mjs` `GC_CLEAR_RADIUS_KPC`) |
| I9 | P0 · **FIXED** | Andromeda (and other textured galaxies) rendered as a beige sphere with dark petals | Galaxy photo wrapped on the bulge sphere, black mosaic gaps opaque, focus distance inside the galaxy; now an inclined emissive disk with sky-projected texture, new M31 texture, focus 1.9 × radius |
| I10 | P1 · **FIXED** | Fly-to often ends on the night side (black Moon/Titan) | `travelTo` frames bodies 35° off the Sun direction |
| I11 | P2 | Centaurus A has no texture/model (generic blob, focused very close) | Open |
| I12 | P2 | Uranian moons, Triton north, Pluto/Charon south have unimaged regions filled with flat tone; single-band mosaics are tinted, not true colour | Data limitation |
| I13 | P2 | Accretion disk is semi-transparent, background stars show through it | Design choice; could raise disk opacity |
| I14 | P2 | Cygnus Loop model shows flat cut planes from some angles | Borderline; delete if disliked |
| I15 | P2 | Old `public/textures/galaxies/andromeda-m31.jpg` unused; orphaned wrong entries in `cache/wikimedia/object-info/` | Delete |
