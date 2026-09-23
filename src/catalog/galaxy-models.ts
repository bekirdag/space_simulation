import {
  GALAXY_KPC_TO_AU,
  LOCAL_GROUP_GALAXY_LABELS,
  type LocalGroupGalaxyLabel,
} from "./galaxies";

export const GALAXY_MODEL_FLOATS = 16;
// Distances below are multiples of the galaxy's major radius R. Focus frames
// the whole disk (45° vertical FOV: R subtends ~60% of the half-height at 1.9R)
// from outside; the morphology mesh is the close LOD, the photo billboard the
// mid LOD, and the procedural catalog blob takes over far away.
const GALAXY_MODEL_FOCUS_RADIUS_MULTIPLIER = 1.9;
const GALAXY_MESH_FADE_NEAR_RADII = 3.2;
const GALAXY_MESH_FADE_FAR_RADII = 7.0;
const GALAXY_BILLBOARD_FADE_IN_NEAR_RADII = 2.6;
const GALAXY_BILLBOARD_FADE_IN_FAR_RADII = 5.5;
const GALAXY_BILLBOARD_FADE_OUT_NEAR_RADII = 8.0;
const GALAXY_BILLBOARD_FADE_OUT_FAR_RADII = 30.0;
// The billboard plane is tilted towards the true disk plane, but no more than
// this, so edge-on galaxies do not become long smeared planes seen face-on.
const GALAXY_BILLBOARD_MAX_TILT_DEG = 60;

export const GALAXY_MORPHOLOGY_TYPES = [
  {
    id: "spiral",
    label: "Spiral galaxy",
    description: "A rotating disk with spiral-arm structure and a central bulge.",
  },
  {
    id: "barred-spiral",
    label: "Barred spiral galaxy",
    description: "A spiral galaxy with a bright stellar bar crossing the center.",
  },
  {
    id: "lenticular",
    label: "Lenticular galaxy",
    description: "A lens-shaped disk galaxy with a prominent bulge and weak arm structure.",
  },
  {
    id: "elliptical",
    label: "Elliptical galaxy",
    description: "A smooth spheroidal galaxy dominated by an old stellar population.",
  },
  {
    id: "irregular",
    label: "Irregular galaxy",
    description: "A disturbed or asymmetric galaxy without clean spiral or elliptical structure.",
  },
  {
    id: "edge-on-starburst",
    label: "Edge-on starburst galaxy",
    description: "A thin, edge-on galaxy with a compact bright star-forming core.",
  },
  {
    id: "interacting",
    label: "Interacting galaxy pair",
    description: "A close galaxy pair with tidal distortion and bridge-like structure.",
  },
] as const;

export type GalaxyMorphologyType = typeof GALAXY_MORPHOLOGY_TYPES[number]["id"];

export interface GalaxyTextureModel {
  id: string;
  name: string;
  morphology: GalaxyMorphologyType;
  morphologyLabel: string;
  textureUrl: string;
  sourceUrl: string;
  credit: string;
  x: number;
  y: number;
  z: number;
  /** Texture half-height in AU (the mesh/billboard local unit). */
  radiusAU: number;
  /** Texture width / height; the texture width spans the galaxy diameter. */
  aspect: number;
  /** Sky-plane basis as seen from the Sun: right = texture +u (major axis), up = texture +v. */
  right: readonly [number, number, number];
  up: readonly [number, number, number];
  /** Disk inclination (radians, 0 = face-on to the Sun), tilted about `right`. */
  inclination: number;
  /** In-plane minor axis of the tilted disk (sky projection = up·cos i). */
  planeUp: readonly [number, number, number];
  /** Disk-plane normal. */
  planeNormal: readonly [number, number, number];
  /** Disk radius in local units (texture half-heights): min(aspect, 1/cos i). */
  diskExtent: number;
  /** Billboard in-plane half-height in local units (texture v spans ±1 in the sky). */
  billboardUpExtent: number;
  /** Billboard plane minor axis (tilted by min(i, GALAXY_BILLBOARD_MAX_TILT_DEG)). */
  billboardUp: readonly [number, number, number];
  majorRadiusAU: number;
  opacity: number;
  fadeNearAU: number;
  fadeFarAU: number;
  billboardFadeInNearAU: number;
  billboardFadeInFarAU: number;
  meshRadiusAU: number;
  meshOpacity: number;
  meshFadeNearAU: number;
  meshFadeFarAU: number;
  focusDistance: number;
}

interface GalaxyTextureModelDef {
  id: string;
  morphology: GalaxyMorphologyType;
  textureUrl: string;
  sourceUrl: string;
  credit: string;
  diameterKpc: number;
  aspect: number;
  opacity: number;
  meshOpacity?: number;
  rotationDeg?: number;
  /** True disk inclination (0 = face-on). The photo is projected onto the tilted disk. */
  inclinationDeg?: number;
}

const TEXTURED_GALAXY_DEFS: GalaxyTextureModelDef[] = [
  {
    id: "lmc",
    morphology: "irregular",
    textureUrl: "/textures/galaxies/lmc.jpg",
    sourceUrl: "https://esahubble.org/images/opo9933i/",
    credit: "Anglo-Australian Observatory/Royal Observatory, Edinburgh and David Malin",
    diameterKpc: 14.0,
    aspect: 1.25,
    opacity: 0.72,
    rotationDeg: -12,
    inclinationDeg: 35,
  },
  {
    id: "smc",
    morphology: "irregular",
    textureUrl: "/textures/galaxies/smc.jpg",
    sourceUrl: "https://esahubble.org/images/heic0603d/",
    credit: "ESA/Hubble and Digitized Sky Survey 2",
    diameterKpc: 7.0,
    aspect: 1.25,
    opacity: 0.68,
    rotationDeg: 7,
    inclinationDeg: 40,
  },
  {
    id: "andromeda",
    morphology: "spiral",
    // Full PHAT+PHAST mosaic, re-centred on the nucleus and levelled so the
    // major axis is horizontal (the old 1280x1024 wallpaper crop had the
    // nucleus in a corner and jagged black mosaic edges across the middle).
    textureUrl: "/textures/galaxies/andromeda-m31-phast.jpg",
    sourceUrl: "https://esahubble.org/images/heic2501a/",
    credit: "NASA, ESA, B. Williams (University of Washington)",
    diameterKpc: 46.6,
    aspect: 3.875,
    opacity: 0.86,
    rotationDeg: -18,
    inclinationDeg: 77,
  },
  {
    id: "triangulum",
    morphology: "spiral",
    textureUrl: "/textures/galaxies/triangulum-m33.jpg",
    sourceUrl: "https://esahubble.org/images/heic1901a/",
    credit: "NASA, ESA, M. Durbin, J. Dalcanton, and B. F. Williams (University of Washington)",
    diameterKpc: 18.4,
    aspect: 1.25,
    opacity: 0.78,
    rotationDeg: 21,
    inclinationDeg: 55,
  },
  {
    id: "ngc-253",
    morphology: "edge-on-starburst",
    textureUrl: "/textures/galaxies/ngc-253.jpg",
    sourceUrl: "https://esahubble.org/images/opo9510b/",
    credit: "Jay Gallagher, Alan Watson, and NASA/ESA",
    diameterKpc: 27.0,
    aspect: 1.25,
    opacity: 0.72,
    rotationDeg: -8,
    inclinationDeg: 76,
  },
  {
    id: "m81",
    morphology: "spiral",
    textureUrl: "/textures/galaxies/m81.jpg",
    sourceUrl: "https://esahubble.org/images/heic0710a/",
    credit: "NASA, ESA and the Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 27.6,
    aspect: 1.25,
    opacity: 0.72,
    rotationDeg: 16,
    inclinationDeg: 59,
  },
  {
    id: "m82",
    morphology: "edge-on-starburst",
    textureUrl: "/textures/galaxies/m82.jpg",
    sourceUrl: "https://esahubble.org/images/heic0604a/",
    credit: "NASA, ESA and the Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 11.3,
    aspect: 1.25,
    opacity: 0.78,
    rotationDeg: -22,
    inclinationDeg: 80,
  },
  {
    id: "m101",
    morphology: "spiral",
    textureUrl: "/textures/galaxies/m101.jpg",
    sourceUrl: "https://esahubble.org/images/heic0602a/",
    credit: "European Space Agency and NASA",
    diameterKpc: 52.0,
    aspect: 1.25,
    opacity: 0.74,
    rotationDeg: 9,
    inclinationDeg: 18,
  },
  {
    id: "m83",
    morphology: "barred-spiral",
    textureUrl: "/textures/galaxies/m83.jpg",
    sourceUrl: "https://science.nasa.gov/asset/hubble/spiral-galaxy-m83/",
    credit: "NASA, ESA and The Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 15.3,
    aspect: 2000 / 1300, // m83.jpg is 2000x1300
    opacity: 0.74,
    rotationDeg: 12,
    inclinationDeg: 24,
  },
  {
    id: "m51",
    morphology: "interacting",
    textureUrl: "/textures/galaxies/m51.jpg",
    sourceUrl: "https://esahubble.org/images/opo0110a/",
    credit: "NASA/ESA and The Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 23.0,
    aspect: 1.25,
    opacity: 0.76,
    rotationDeg: -5,
    inclinationDeg: 22,
  },
  {
    id: "m104",
    morphology: "lenticular",
    textureUrl: "/textures/galaxies/m104-sombrero.jpg",
    sourceUrl: "https://esahubble.org/images/opo0328a/",
    credit: "NASA/ESA and The Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 15.3,
    aspect: 1.25,
    opacity: 0.78,
    rotationDeg: 0,
    inclinationDeg: 84,
  },
  {
    id: "m87",
    morphology: "elliptical",
    textureUrl: "/textures/galaxies/m87.jpg",
    sourceUrl: "https://esahubble.org/images/heic2411b/",
    credit: "NASA, ESA and STScI",
    diameterKpc: 40.0,
    aspect: 1.15,
    opacity: 0.70,
    meshOpacity: 0.78,
    rotationDeg: -4,
    inclinationDeg: 0,
  },
];

function morphologyLabel(id: GalaxyMorphologyType): string {
  return GALAXY_MORPHOLOGY_TYPES.find(type => type.id === id)?.label ?? id;
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len <= 1e-9) return [1, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function basisForLabel(
  label: LocalGroupGalaxyLabel,
  rotationDeg = 0,
): { right: [number, number, number]; up: [number, number, number] } {
  const normal = normalize([label.x, label.y, label.z]);
  let right = normalize(cross([0, 0, 1], normal));
  if (Math.hypot(right[0], right[1], right[2]) <= 1e-6) {
    right = normalize(cross([0, 1, 0], normal));
  }
  let up = normalize(cross(normal, right));

  const theta = rotationDeg * Math.PI / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rotatedRight: [number, number, number] = [
    right[0] * c + up[0] * s,
    right[1] * c + up[1] * s,
    right[2] * c + up[2] * s,
  ];
  const rotatedUp: [number, number, number] = [
    up[0] * c - right[0] * s,
    up[1] * c - right[1] * s,
    up[2] * c - right[2] * s,
  ];
  return { right: normalize(rotatedRight), up: normalize(rotatedUp) };
}

let cachedModels: GalaxyTextureModel[] | null = null;

export function galaxyTextureModels(): GalaxyTextureModel[] {
  if (cachedModels) return cachedModels;
  cachedModels = TEXTURED_GALAXY_DEFS.flatMap(def => {
    const label = LOCAL_GROUP_GALAXY_LABELS.find(galaxy => galaxy.id === def.id);
    if (!label) return [];

    const majorRadiusAU = Math.max(1, def.diameterKpc * GALAXY_KPC_TO_AU * 0.5);
    const aspect = Math.max(0.2, def.aspect);
    const radiusAU = majorRadiusAU / aspect;
    const focusDistance = Math.max(9_000, majorRadiusAU * GALAXY_MODEL_FOCUS_RADIUS_MULTIPLIER);
    const meshFadeNearAU = majorRadiusAU * GALAXY_MESH_FADE_NEAR_RADII;
    const meshFadeFarAU = majorRadiusAU * GALAXY_MESH_FADE_FAR_RADII;
    const billboardFadeInNearAU = majorRadiusAU * GALAXY_BILLBOARD_FADE_IN_NEAR_RADII;
    const billboardFadeInFarAU = majorRadiusAU * GALAXY_BILLBOARD_FADE_IN_FAR_RADII;
    const { right, up } = basisForLabel(label, def.rotationDeg ?? 0);
    const skyNormal = normalize(cross(right, up));

    // The photo is the sky projection of the disk as seen from the Sun. Tilting
    // the disk plane about the major axis by the real inclination and
    // projecting the photo back onto it along the line of sight reproduces the
    // photo exactly from the Sun's side and gives a proper 3D disk elsewhere.
    const inclination = Math.min(89, Math.max(0, def.inclinationDeg ?? 0)) * Math.PI / 180;
    const tiltUp = (angle: number): [number, number, number] => normalize([
      up[0] * Math.cos(angle) + skyNormal[0] * Math.sin(angle),
      up[1] * Math.cos(angle) + skyNormal[1] * Math.sin(angle),
      up[2] * Math.cos(angle) + skyNormal[2] * Math.sin(angle),
    ]);
    const planeUp = tiltUp(inclination);
    const planeNormal = normalize(cross(right, planeUp));
    const diskExtent = Math.min(aspect, 1 / Math.max(Math.cos(inclination), 1e-3));
    const billboardTilt = Math.min(inclination, GALAXY_BILLBOARD_MAX_TILT_DEG * Math.PI / 180);

    return [{
      id: def.id,
      name: label.name,
      morphology: def.morphology,
      morphologyLabel: morphologyLabel(def.morphology),
      textureUrl: def.textureUrl,
      sourceUrl: def.sourceUrl,
      credit: def.credit,
      x: label.x,
      y: label.y,
      z: label.z,
      radiusAU,
      aspect,
      right,
      up,
      inclination,
      planeUp,
      planeNormal,
      diskExtent,
      billboardUpExtent: 1 / Math.cos(billboardTilt),
      billboardUp: tiltUp(billboardTilt),
      majorRadiusAU,
      opacity: def.opacity,
      fadeNearAU: majorRadiusAU * GALAXY_BILLBOARD_FADE_OUT_NEAR_RADII,
      fadeFarAU: majorRadiusAU * GALAXY_BILLBOARD_FADE_OUT_FAR_RADII,
      billboardFadeInNearAU,
      billboardFadeInFarAU,
      meshRadiusAU: radiusAU,
      meshOpacity: def.meshOpacity ?? Math.min(0.88, def.opacity + 0.04),
      meshFadeNearAU,
      meshFadeFarAU,
      focusDistance,
    }];
  });
  return cachedModels;
}

export function galaxyModelFocusDistance(id: string): number | null {
  const model = galaxyTextureModels().find(item => item.id === id);
  return model?.focusDistance ?? null;
}

/**
 * Disk (and bulge) of the nearest textured galaxy that is visible as a disk from
 * `eye`, for hiding labels of objects behind it (labels.ts galaxyDiskOccludes).
 */
export function nearestGalaxyDiskOccluder(eye: readonly [number, number, number]): {
  center: [number, number, number];
  normal: [number, number, number];
  radiusAU: number;
  bulgeRadiusAU: number;
} | null {
  let best: GalaxyTextureModel | null = null;
  let bestDist = Infinity;
  for (const model of galaxyTextureModels()) {
    const dist = Math.hypot(eye[0] - model.x, eye[1] - model.y, eye[2] - model.z);
    // Mesh or tilted billboard still shows a sizeable disk out to fadeNearAU.
    if (dist < model.fadeNearAU && dist < bestDist) {
      best = model;
      bestDist = dist;
    }
  }
  if (!best) return null;
  const diskRadiusAU = best.diskExtent * best.radiusAU;
  return {
    center: [best.x, best.y, best.z],
    normal: [best.planeNormal[0], best.planeNormal[1], best.planeNormal[2]],
    radiusAU: diskRadiusAU * 0.85,
    bulgeRadiusAU: diskRadiusAU * (best.morphology === "elliptical" ? 0.8 : 0.22),
  };
}
