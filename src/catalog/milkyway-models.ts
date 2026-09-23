import { type StarSearchResult } from "./stars";
import { AU_PER_PARSEC, raDecDistancePcToWorldAU } from "./scale";

export type MilkyWayModelFormat = "glb";

/**
 * Glowing-gas look for the NASA/Chandra isosurface meshes (milkyway-model.wgsl
 * fs_glow). `color` on the model is the outer / blast-wave colour, `inner` the
 * ejecta colour toward the centre; textured parts keep their element colours.
 */
export interface MilkyWayModelGlow {
  inner: [number, number, number];
  /** HDR emission multiplier (additive; bloom threshold is ~1.1 luma). */
  gain: number;
  /** Fresnel exponent: higher = thinner, sharper limb-brightened shells. */
  rimPower: number;
  /** Emission of faces seen head-on relative to grazing (0..1). */
  headOn: number;
}

export interface MilkyWayModelObject {
  id: string;
  name: string;
  modelGroup: string;
  objectType: string;
  format: MilkyWayModelFormat;
  source: string;
  sourceUrl: string;
  assetUrl: string;
  x: number;
  y: number;
  z: number;
  radiusAU: number;
  focusDistance: number;
  fadeNearAU: number;
  fadeFarAU: number;
  loadDistanceAU: number;
  color: [number, number, number];
  opacity: number;
  glow: MilkyWayModelGlow;
  textureUrl?: string;
  textureSource?: string;
  textureSourceUrl?: string;
  textureCredit?: string;
  aliases: string[];
}

interface ModelDef {
  id: string;
  name: string;
  modelGroup?: string;
  objectType: string;
  format: MilkyWayModelFormat;
  source: string;
  sourceUrl: string;
  ra: number;
  dec: number;
  distancePc: number;
  diameterArcmin?: number;
  radiusAU?: number;
  color: [number, number, number];
  opacity?: number;
  glow?: Partial<MilkyWayModelGlow>;
  textureUrl?: string;
  textureSource?: string;
  textureSourceUrl?: string;
  textureCredit?: string;
  aliases?: string[];
}

// Shared 80 AU/pc scale (scale.ts). The AU clamps below were tuned at the old
// 8 AU/pc Milky Way scale and are multiplied by 10 (SCALE_AU) so fades and
// focus distances trigger at the same physical distances as before.
const SCALE_AU = 10;
const MODEL_FOCUS_NDC_RADIUS = 0.5; // diameter fills roughly half the viewport height
const CAMERA_FOCAL_Y = 1 / Math.tan(Math.PI / 8);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function worldPos(raDeg: number, decDeg: number, distancePc: number): [number, number, number] {
  return raDecDistancePcToWorldAU(raDeg, decDeg, distancePc);
}

function radiusFromAngularSize(distancePc: number, diameterArcmin: number): number {
  const distanceAU = distancePc * AU_PER_PARSEC;
  const angularRadius = (diameterArcmin / 2) / 60 * Math.PI / 180;
  return Math.max(6 * SCALE_AU, distanceAU * Math.tan(angularRadius));
}

function slugSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function focusDistanceForRadius(radiusAU: number): number {
  return clamp((radiusAU * CAMERA_FOCAL_Y) / MODEL_FOCUS_NDC_RADIUS, 16 * SCALE_AU, 12_000 * SCALE_AU);
}

function toModel(def: ModelDef): MilkyWayModelObject {
  const [x, y, z] = worldPos(def.ra, def.dec, def.distancePc);
  const radiusAU = def.radiusAU ?? radiusFromAngularSize(def.distancePc, def.diameterArcmin ?? 12);
  const focusDistance = focusDistanceForRadius(radiusAU);
  const fadeNearAU = clamp(radiusAU * 12, 120 * SCALE_AU, 12_000 * SCALE_AU);
  const fadeFarAU = clamp(radiusAU * 48, fadeNearAU + 80 * SCALE_AU, 42_000 * SCALE_AU);

  const model: MilkyWayModelObject = {
    id: def.id,
    name: def.name,
    modelGroup: def.modelGroup ?? def.id,
    objectType: def.objectType,
    format: def.format,
    source: def.source,
    sourceUrl: def.sourceUrl,
    assetUrl: `/api/model-assets/${encodeURIComponent(def.id)}`,
    x, y, z,
    radiusAU,
    focusDistance,
    fadeNearAU,
    fadeFarAU,
    loadDistanceAU: fadeFarAU * 1.18,
    color: def.color,
    opacity: def.opacity ?? 0.78,
    glow: {
      inner: def.glow?.inner ?? def.color,
      gain: def.glow?.gain ?? 1,
      rimPower: def.glow?.rimPower ?? 2.2,
      headOn: def.glow?.headOn ?? 0.05,
    },
    aliases: def.aliases ?? [],
  };
  if (def.textureUrl) model.textureUrl = def.textureUrl;
  if (def.textureSource) model.textureSource = def.textureSource;
  if (def.textureSourceUrl) model.textureSourceUrl = def.textureSourceUrl;
  if (def.textureCredit) model.textureCredit = def.textureCredit;
  return model;
}

// BP Tauri (NASA "3D Models/BP Tauri") was removed: its disk is a solid
// capped cylinder that reads as a glass can even when drawn as glowing gas.
const DEFINITIONS: ModelDef[] = [
  {
    id: "crab-nebula",
    name: "Crab Nebula",
    modelGroup: "crab-nebula",
    objectType: "supernova remnant",
    format: "glb",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/crab-nebula/",
    ra: 83.63,
    dec: 22.01,
    distancePc: 2000,
    diameterArcmin: 6,
    color: [0.36, 0.48, 1.0],
    glow: { inner: [0.72, 0.82, 1.0], gain: 0.9 },
    aliases: ["M1", "Taurus A"],
  },
  {
    id: "cassiopeia-a",
    name: "Cassiopeia A",
    modelGroup: "cassiopeia-a",
    objectType: "supernova remnant",
    format: "glb",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/cassiopeia-a-supernova/",
    ra: 350.85,
    dec: 58.81,
    distancePc: 3400,
    diameterArcmin: 5,
    color: [0.28, 0.50, 1.0],
    glow: { inner: [0.50, 0.42, 1.0], gain: 0.75 },
    aliases: ["Cas A"],
  },
  {
    id: "cassiopeia-a-green-monster-2023",
    name: "Cassiopeia A Green Monster",
    modelGroup: "cassiopeia-a",
    objectType: "supernova remnant model",
    format: "glb",
    source: "NASA Science / Chandra / Webb",
    sourceUrl: "https://science.nasa.gov/3d-resources/cassiopeia-a-supernova-b-2023/",
    ra: 350.85,
    dec: 58.81,
    distancePc: 3400,
    diameterArcmin: 5,
    color: [1.0, 0.46, 0.26],
    glow: { inner: [0.45, 1.0, 0.55], gain: 0.75 },
    opacity: 0.62,
    aliases: ["Cas A 2023", "Green Monster"],
  },
  {
    id: "cassiopeia-a-iron-2025",
    name: "Cassiopeia A Iron",
    modelGroup: "cassiopeia-a",
    objectType: "supernova remnant model",
    format: "glb",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/cassiopeia-a-supernova-c-2025/",
    ra: 350.85,
    dec: 58.81,
    distancePc: 3400,
    diameterArcmin: 5,
    color: [0.78, 0.32, 1.0],
    glow: { inner: [1.0, 0.36, 0.46], gain: 1.0 },
    opacity: 0.64,
    aliases: ["Cas A 2025", "Cas A iron"],
  },
  {
    id: "g292-supernova-remnant",
    name: "G292.0+1.8",
    modelGroup: "g292-supernova-remnant",
    objectType: "supernova remnant",
    format: "glb",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/g292-01-8-supernova-remnant/",
    ra: 181.42,
    dec: -59.32,
    distancePc: 6000,
    diameterArcmin: 8,
    color: [0.40, 0.60, 1.0],
    glow: { inner: [1.0, 0.74, 0.34], gain: 1.0 },
    aliases: ["G292", "G292.0 1.8"],
  },
  {
    id: "cygnus-loop-supernova",
    name: "Cygnus Loop",
    modelGroup: "cygnus-loop-supernova",
    objectType: "supernova remnant",
    format: "glb",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/cygnus-loop-supernova/",
    ra: 312.9,
    dec: 30.8,
    distancePc: 740,
    diameterArcmin: 230,
    color: [0.32, 0.86, 1.0],
    glow: { inner: [1.0, 0.34, 0.46], gain: 1.15, headOn: 0.04 },
    opacity: 0.45,
    aliases: ["Veil Nebula", "NGC 6960"],
  },

];

export const MILKY_WAY_MODEL_OBJECTS: MilkyWayModelObject[] = DEFINITIONS.map(toModel);

export function milkyWayModelById(id: string): MilkyWayModelObject | undefined {
  return MILKY_WAY_MODEL_OBJECTS.find(model => model.id === id || `mwmodel:${model.id}` === id);
}

export function milkyWayModelToSearchResult(model: MilkyWayModelObject): StarSearchResult {
  const distancePc = Math.round(Math.hypot(model.x, model.y, model.z) / AU_PER_PARSEC);
  return {
    id: `mwmodel:${model.id}`,
    label: model.name,
    subtitle: `${model.objectType} • ${distancePc.toLocaleString()} pc • ${model.format.toUpperCase()} model`,
    x: model.x,
    y: model.y,
    z: model.z,
    focusDistance: model.focusDistance,
    color: model.color,
  };
}

export function milkyWayModelSearchResults(): StarSearchResult[] {
  return MILKY_WAY_MODEL_OBJECTS.map(milkyWayModelToSearchResult);
}

// 2D catalog nebulas (nebulas.ts) that have a 3D gas mesh here. They are
// excluded from search / context-menu hits (the model entry supersedes them),
// but their billboard stays in the GPU buffer and hands over to the mesh up
// close (milkyWayModelNebulaHandoff) so far views still show the remnant.
const MODEL_BACKED_NEBULAE: ReadonlyArray<readonly [nebulaName: string, modelGroup: string]> = [
  ["Crab Nebula (M1)", "crab-nebula"],
  ["G184.6-5.8 (Crab surroundings)", "crab-nebula"],
  ["Cassiopeia A", "cassiopeia-a"],
  ["G292.0+1.8", "g292-supernova-remnant"],
  ["Cygnus Loop (G74.0-8.5)", "cygnus-loop-supernova"],
];
const MODEL_BACKED_NEBULA_NAMES = MODEL_BACKED_NEBULAE.map(([name]) => name);

export interface MilkyWayModelNebulaHandoff {
  /** Camera distance (AU) at/below which the mesh is fully shown. */
  nearAU: number;
  /** Camera distance (AU) at/above which only the 2D billboard is shown. */
  farAU: number;
}

/**
 * Crossfade range for a 2D catalog nebula backed by a 3D gas mesh: the
 * billboard dims toward a faint residual haze while the mesh fades in
 * (same range as the mesh LOD in milkyway-model.wgsl vs_main).
 */
export function milkyWayModelNebulaHandoff(nebulaName: string): MilkyWayModelNebulaHandoff | null {
  const entry = MODEL_BACKED_NEBULAE.find(([name]) => name === nebulaName);
  if (!entry) return null;
  const model = MILKY_WAY_MODEL_OBJECTS.find(candidate => candidate.modelGroup === entry[1]);
  if (!model) return null;
  return { nearAU: model.fadeNearAU, farAU: model.fadeFarAU };
}

export function milkyWayModelNebulaExclusionSlugs(): Set<string> {
  const slugs = new Set(MODEL_BACKED_NEBULA_NAMES.map(slugSearch));
  for (const model of MILKY_WAY_MODEL_OBJECTS) {
    slugs.add(slugSearch(model.name));
    for (const alias of model.aliases) slugs.add(slugSearch(alias));
  }
  return slugs;
}

export function searchMilkyWayModels(query: string, limit = 5): StarSearchResult[] {
  const q = slugSearch(query);
  if (q.length < 2) return [];
  const hits = MILKY_WAY_MODEL_OBJECTS
    .map(model => {
      const haystack = slugSearch([model.name, model.objectType, model.source, ...model.aliases].join(" "));
      const starts = haystack.startsWith(q) || model.aliases.some(alias => slugSearch(alias).startsWith(q));
      const contains = haystack.includes(q);
      if (!starts && !contains) return null;
      return { model, score: starts ? 0 : haystack.indexOf(q) + 1 };
    })
    .filter((hit): hit is { model: MilkyWayModelObject; score: number } => hit !== null)
    .sort((a, b) => a.score - b.score || a.model.name.localeCompare(b.model.name))
    .slice(0, limit);
  return hits.map(hit => milkyWayModelToSearchResult(hit.model));
}
