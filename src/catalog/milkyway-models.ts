import { type StarSearchResult } from "./stars";

export type MilkyWayModelFormat = "glb";

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
  textureUrl?: string;
  textureSource?: string;
  textureSourceUrl?: string;
  textureCredit?: string;
  aliases?: string[];
}

const AU_PER_PARSEC = 8;
const EPS = 23.4393 * Math.PI / 180;
const MODEL_FOCUS_NDC_RADIUS = 0.5; // diameter fills roughly half the viewport height
const CAMERA_FOCAL_Y = 1 / Math.tan(Math.PI / 8);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function worldPos(raDeg: number, decDeg: number, distancePc: number): [number, number, number] {
  const r = distancePc * AU_PER_PARSEC;
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const xe = Math.cos(dec) * Math.cos(ra);
  const ye = Math.cos(dec) * Math.sin(ra);
  const ze = Math.sin(dec);
  return [
    xe * r,
    (ye * Math.cos(EPS) + ze * Math.sin(EPS)) * r,
    (-ye * Math.sin(EPS) + ze * Math.cos(EPS)) * r,
  ];
}

function radiusFromAngularSize(distancePc: number, diameterArcmin: number): number {
  const distanceAU = distancePc * AU_PER_PARSEC;
  const angularRadius = (diameterArcmin / 2) / 60 * Math.PI / 180;
  return Math.max(6, distanceAU * Math.tan(angularRadius));
}

function slugSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function focusDistanceForRadius(radiusAU: number): number {
  return clamp((radiusAU * CAMERA_FOCAL_Y) / MODEL_FOCUS_NDC_RADIUS, 16, 12_000);
}

function toModel(def: ModelDef): MilkyWayModelObject {
  const [x, y, z] = worldPos(def.ra, def.dec, def.distancePc);
  const radiusAU = def.radiusAU ?? radiusFromAngularSize(def.distancePc, def.diameterArcmin ?? 12);
  const focusDistance = focusDistanceForRadius(radiusAU);
  const fadeNearAU = clamp(radiusAU * 12, 120, 12_000);
  const fadeFarAU = clamp(radiusAU * 48, fadeNearAU + 80, 42_000);

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
    aliases: def.aliases ?? [],
  };
  if (def.textureUrl) model.textureUrl = def.textureUrl;
  if (def.textureSource) model.textureSource = def.textureSource;
  if (def.textureSourceUrl) model.textureSourceUrl = def.textureSourceUrl;
  if (def.textureCredit) model.textureCredit = def.textureCredit;
  return model;
}

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
    color: [0.58, 0.76, 1.0],
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
    color: [0.82, 0.62, 1.0],
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
    color: [0.56, 1.0, 0.72],
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
    color: [1.0, 0.62, 0.44],
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
    color: [0.55, 0.80, 1.0],
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
    color: [0.48, 0.9, 1.0],
    opacity: 0.45,
    aliases: ["Veil Nebula", "NGC 6960"],
  },
  {
    id: "bp-tauri",
    name: "BP Tauri",
    modelGroup: "bp-tauri",
    objectType: "T Tauri star",
    format: "glb",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/bp-tauri/",
    ra: 64.816,
    dec: 29.108,
    distancePc: 129,
    radiusAU: 34,
    color: [1.0, 0.52, 0.42],
    aliases: ["BP Tau"],
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

const MODEL_BACKED_NEBULA_NAMES = [
  "Crab Nebula (M1)",
  "G184.6-5.8 (Crab surroundings)",
  "Cassiopeia A",
  "G292.0+1.8",
  "Cygnus Loop (G74.0-8.5)",
];

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
