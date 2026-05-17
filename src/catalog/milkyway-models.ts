import { type StarSearchResult } from "./stars";

export type MilkyWayModelFormat = "glb" | "stl";

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
    id: "crab-nebula-disc",
    name: "Crab Nebula Disc",
    modelGroup: "crab-nebula",
    objectType: "pulsar wind nebula model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/crab-nebula/",
    ra: 83.63,
    dec: 22.01,
    distancePc: 2000,
    diameterArcmin: 6,
    color: [0.58, 0.76, 1.0],
    aliases: ["M1", "Taurus A", "Crab disc"],
  },
  {
    id: "crab-nebula-jet-1",
    name: "Crab Nebula Jet 1",
    modelGroup: "crab-nebula",
    objectType: "pulsar wind nebula jet model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/crab-nebula/",
    ra: 83.63,
    dec: 22.01,
    distancePc: 2000,
    diameterArcmin: 6,
    color: [0.62, 0.86, 1.0],
    aliases: ["M1", "Taurus A", "Crab jet"],
  },
  {
    id: "crab-nebula-jet-2",
    name: "Crab Nebula Jet 2",
    modelGroup: "crab-nebula",
    objectType: "pulsar wind nebula jet model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/crab-nebula/",
    ra: 83.63,
    dec: 22.01,
    distancePc: 2000,
    diameterArcmin: 6,
    color: [0.50, 0.68, 1.0],
    aliases: ["M1", "Taurus A", "Crab jet"],
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
  {
    id: "dg-tau",
    name: "DG Tau",
    modelGroup: "dg-tau",
    objectType: "protostar",
    format: "stl",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/dg-tau/",
    ra: 66.77,
    dec: 26.1,
    distancePc: 138,
    radiusAU: 34,
    color: [0.72, 0.86, 1.0],
    aliases: ["DG Tauri"],
  },
  {
    id: "u-scorpii",
    name: "U Scorpii",
    modelGroup: "u-scorpii",
    objectType: "recurrent nova",
    format: "stl",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/u-scorpii/",
    ra: 245.628,
    dec: -17.867,
    distancePc: 12000,
    radiusAU: 78,
    color: [1.0, 0.5, 0.36],
    aliases: ["U Sco"],
  },
  {
    id: "sn-1006-ejecta",
    name: "SN 1006 Ejecta",
    modelGroup: "sn-1006",
    objectType: "supernova remnant model",
    format: "stl",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/sn-1006/",
    ra: 225.88,
    dec: -41.98,
    distancePc: 2180,
    diameterArcmin: 30,
    color: [1.0, 0.82, 0.36],
    aliases: ["SN 1006", "G327.6+14.6"],
  },
  {
    id: "sn-1006-blast-quarter",
    name: "SN 1006 Blast Wave",
    modelGroup: "sn-1006",
    objectType: "supernova remnant shell model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/sn-1006/",
    ra: 225.88,
    dec: -41.98,
    distancePc: 2180,
    diameterArcmin: 30,
    color: [1.0, 0.74, 0.32],
    aliases: ["SN 1006", "G327.6+14.6", "blast wave"],
  },
  {
    id: "sn-1006-ejecta-quarter",
    name: "SN 1006 Ejecta Quarter",
    modelGroup: "sn-1006",
    objectType: "supernova remnant ejecta model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/sn-1006/",
    ra: 225.88,
    dec: -41.98,
    distancePc: 2180,
    diameterArcmin: 30,
    color: [0.92, 0.62, 0.26],
    aliases: ["SN 1006", "G327.6+14.6", "ejecta"],
  },
  {
    id: "tycho-supernova-inner",
    name: "Tycho Inner Remnant",
    modelGroup: "tycho-supernova",
    objectType: "supernova remnant model",
    format: "stl",
    source: "NASA Science / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/tycho-supernova-remnant/",
    ra: 6.31,
    dec: 64.14,
    distancePc: 3000,
    diameterArcmin: 8,
    color: [0.52, 1.0, 0.72],
    aliases: ["Tycho", "SN 1572", "Tycho's SNR"],
  },
  {
    id: "tycho-supernova-left-outer",
    name: "Tycho Outer Remnant Left",
    modelGroup: "tycho-supernova",
    objectType: "supernova remnant shell model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/tycho-supernova-remnant/",
    ra: 6.31,
    dec: 64.14,
    distancePc: 3000,
    diameterArcmin: 8,
    color: [0.44, 0.86, 0.70],
    aliases: ["Tycho", "SN 1572", "Tycho's SNR"],
  },
  {
    id: "tycho-supernova-right-inner",
    name: "Tycho Inner Remnant Right",
    modelGroup: "tycho-supernova",
    objectType: "supernova remnant shell model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/tycho-supernova-remnant/",
    ra: 6.31,
    dec: 64.14,
    distancePc: 3000,
    diameterArcmin: 8,
    color: [0.58, 1.0, 0.78],
    aliases: ["Tycho", "SN 1572", "Tycho's SNR"],
  },
  {
    id: "tycho-supernova-right-outer",
    name: "Tycho Outer Remnant Right",
    modelGroup: "tycho-supernova",
    objectType: "supernova remnant shell model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/tycho-supernova-remnant/",
    ra: 6.31,
    dec: 64.14,
    distancePc: 3000,
    diameterArcmin: 8,
    color: [0.42, 0.92, 0.62],
    aliases: ["Tycho", "SN 1572", "Tycho's SNR"],
  },
  {
    id: "eta-carinae-homunculus",
    name: "Eta Carinae Homunculus",
    modelGroup: "eta-carinae",
    objectType: "stellar eruption nebula model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 42,
    color: [1.0, 0.62, 0.36],
    textureUrl: "/textures/nebula-eta-carinae.jpg",
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-high-mdot-apastron-wind",
    name: "Eta Carinae High-Mdot Apastron Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.82, 0.78, 0.70],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-high-mdot-apastron-shock",
    name: "Eta Carinae High-Mdot Apastron Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.76, 0.82, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "WWCR"],
  },
  {
    id: "eta-carinae-high-mdot-periastron-wind",
    name: "Eta Carinae High-Mdot Periastron Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.88, 0.72, 0.62],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-high-mdot-periastron-shock",
    name: "Eta Carinae High-Mdot Periastron Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.62, 0.78, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-high-mdot-phase1045-wind",
    name: "Eta Carinae High-Mdot Phase 1.045 Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.94, 0.70, 0.54],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "Phase 1.045"],
  },
  {
    id: "eta-carinae-high-mdot-phase1045-shock",
    name: "Eta Carinae High-Mdot Phase 1.045 Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.58, 0.76, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "Phase 1.045", "WWCR"],
  },
  {
    id: "eta-carinae-low-mdot-apastron-wind",
    name: "Eta Carinae Low-Mdot Apastron Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.84, 0.84, 0.76],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-low-mdot-apastron-shock",
    name: "Eta Carinae Low-Mdot Apastron Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.68, 0.86, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "WWCR"],
  },
  {
    id: "eta-carinae-low-mdot-periastron-wind",
    name: "Eta Carinae Low-Mdot Periastron Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.82, 0.74, 0.66],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-low-mdot-periastron-shock",
    name: "Eta Carinae Low-Mdot Periastron Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.74, 0.88, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula"],
  },
  {
    id: "eta-carinae-low-mdot-phase1045-wind",
    name: "Eta Carinae Low-Mdot Phase 1.045 Wind",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.86, 0.78, 0.66],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "Phase 1.045"],
  },
  {
    id: "eta-carinae-low-mdot-phase1045-shock",
    name: "Eta Carinae Low-Mdot Phase 1.045 Shock",
    modelGroup: "eta-carinae",
    objectType: "stellar wind interaction model",
    format: "stl",
    source: "NASA 3D Resources / Goddard",
    sourceUrl: "https://science.nasa.gov/3d-resources/eta-carinae-homunculus-nebula/",
    ra: 161.265,
    dec: -59.685,
    distancePc: 2350,
    radiusAU: 36,
    color: [0.64, 0.84, 1.0],
    aliases: ["Eta Carinae", "Homunculus Nebula", "Eta Carinae Nebula", "Phase 1.045", "WWCR"],
  },
  {
    id: "pillars-of-creation-pillar",
    name: "Pillars of Creation Pillar 1B",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 22,
    color: [0.82, 0.58, 0.38],
    opacity: 0.7,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "pillars-of-creation-full",
    name: "Pillars of Creation Full",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 58,
    color: [0.86, 0.62, 0.42],
    opacity: 0.74,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "pillars-of-creation-mini",
    name: "Pillars of Creation Mini",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 18,
    color: [0.80, 0.58, 0.38],
    opacity: 0.72,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "pillars-of-creation-positions",
    name: "Pillars of Creation Positions",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula position model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 58,
    color: [0.72, 0.62, 0.46],
    opacity: 0.58,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611", "pillar positions"],
  },
  {
    id: "pillars-of-creation-pillar-1a",
    name: "Pillars of Creation Pillar 1A",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 28,
    color: [0.78, 0.52, 0.34],
    opacity: 0.72,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "pillars-of-creation-pillar-2",
    name: "Pillars of Creation Pillar 2",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 24,
    color: [0.70, 0.48, 0.32],
    opacity: 0.72,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "pillars-of-creation-pillar-3",
    name: "Pillars of Creation Pillar 3",
    modelGroup: "pillars-of-creation",
    objectType: "star-forming nebula model",
    format: "stl",
    source: "NASA Science / STScI",
    sourceUrl: "https://science.nasa.gov/3d-resources/pillars-of-creation/",
    ra: 274.7,
    dec: -13.79,
    distancePc: 2000,
    radiusAU: 22,
    color: [0.90, 0.66, 0.42],
    opacity: 0.72,
    aliases: ["Pillars of Creation", "Eagle Nebula", "M16", "NGC 6611"],
  },
  {
    id: "ic-443-blastwave",
    name: "IC 443 Blastwave",
    modelGroup: "ic-443",
    objectType: "supernova remnant shell model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.50, 0.82, 1.0],
    opacity: 0.68,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0"],
  },
  {
    id: "ic-443-ejecta-torus",
    name: "IC 443 Ejecta and Torus",
    modelGroup: "ic-443",
    objectType: "supernova remnant ejecta model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.74, 0.58, 1.0],
    opacity: 0.68,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0"],
  },
  {
    id: "ic-443-ejecta-cross-section-pwn-torus",
    name: "IC 443 Cross Section PWN and Torus",
    modelGroup: "ic-443",
    objectType: "supernova remnant cross-section model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.60, 0.90, 0.92],
    opacity: 0.66,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0", "PWN"],
  },
  {
    id: "ic-443-ejecta-cross-section-pwn",
    name: "IC 443 Cross Section PWN",
    modelGroup: "ic-443",
    objectType: "supernova remnant cross-section model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.62, 0.78, 1.0],
    opacity: 0.66,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0", "PWN"],
  },
  {
    id: "ic-443-ejecta-torus-blast",
    name: "IC 443 Ejecta Torus Blast",
    modelGroup: "ic-443",
    objectType: "supernova remnant composite model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.86, 0.64, 0.92],
    opacity: 0.66,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0"],
  },
  {
    id: "ic-443-ejecta",
    name: "IC 443 Ejecta",
    modelGroup: "ic-443",
    objectType: "supernova remnant ejecta model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.94, 0.62, 0.48],
    opacity: 0.68,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0"],
  },
  {
    id: "ic-443-molecular-cloud-torus",
    name: "IC 443 Molecular Cloud Torus",
    modelGroup: "ic-443",
    objectType: "supernova remnant molecular cloud model",
    format: "stl",
    source: "NASA 3D Resources / Chandra",
    sourceUrl: "https://science.nasa.gov/3d-resources/ic-443-jellyfish-nebula/",
    ra: 94.3,
    dec: 22.5,
    distancePc: 1500,
    diameterArcmin: 50,
    color: [0.58, 0.66, 0.78],
    opacity: 0.62,
    aliases: ["IC 443", "Jellyfish Nebula", "G189.1+3.0", "molecular cloud"],
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
  "Tycho's SNR (G120.1+1.4)",
  "SN 1006 (G327.6+14.6)",
  "IC 443 (Jellyfish Nebula)",
  "G189.6+3.3",
  "Eagle Nebula (M16)",
  "Eta Carinae Nebula",
  "Eta Carinae (Homunculus Nebula)",
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
