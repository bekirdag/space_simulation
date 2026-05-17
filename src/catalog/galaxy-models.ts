import {
  GALAXY_KPC_TO_AU,
  LOCAL_GROUP_GALAXY_LABELS,
  type LocalGroupGalaxyLabel,
} from "./galaxies";

export const GALAXY_MODEL_FLOATS = 16;
const GALAXY_MODEL_FOCUS_RADIUS_MULTIPLIER = 0.55;
const GALAXY_MODEL_LOD_RADIUS_MULTIPLIER = 1.15;

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
  radiusAU: number;
  aspect: number;
  right: readonly [number, number, number];
  up: readonly [number, number, number];
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
  },
  {
    id: "andromeda",
    morphology: "spiral",
    textureUrl: "/textures/galaxies/andromeda-m31.jpg",
    sourceUrl: "https://esahubble.org/images/heic2501a/",
    credit: "NASA, ESA, B. Williams (University of Washington)",
    diameterKpc: 67.0,
    aspect: 1.25,
    opacity: 0.82,
    rotationDeg: -18,
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
  },
  {
    id: "m83",
    morphology: "barred-spiral",
    textureUrl: "/textures/galaxies/m83.jpg",
    sourceUrl: "https://science.nasa.gov/asset/hubble/spiral-galaxy-m83/",
    credit: "NASA, ESA and The Hubble Heritage Team (STScI/AURA)",
    diameterKpc: 15.3,
    aspect: 1.25,
    opacity: 0.74,
    rotationDeg: 12,
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
    const radiusAU = majorRadiusAU / Math.max(0.2, def.aspect);
    const focusDistance = Math.max(900, majorRadiusAU * GALAXY_MODEL_FOCUS_RADIUS_MULTIPLIER);
    const lodDistance = Math.max(900, majorRadiusAU * GALAXY_MODEL_LOD_RADIUS_MULTIPLIER);
    const meshFadeNearAU = Math.max(focusDistance * 2.7, majorRadiusAU * 1.5);
    const meshFadeFarAU = Math.max(focusDistance * 5.8, majorRadiusAU * 3.3);
    const billboardFadeInNearAU = Math.max(focusDistance * 1.25, majorRadiusAU * 0.7);
    const billboardFadeInFarAU = Math.max(focusDistance * 2.9, majorRadiusAU * 1.65);
    const { right, up } = basisForLabel(label, def.rotationDeg ?? 0);

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
      aspect: def.aspect,
      right,
      up,
      opacity: def.opacity,
      fadeNearAU: lodDistance * 1.15,
      fadeFarAU: lodDistance * 5.2,
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
