export type SolarSystemModelFormat = "glb" | "usdz" | "procedural-sphere";

export interface SolarSystemModelAsset {
  id: string;
  bodyName: string;
  format: SolarSystemModelFormat;
  source: string;
  sourceUrl: string;
  assetUrl: string;
  fallbackColor: [number, number, number];
  emissive?: number;
}

const NASA_SCIENCE = "NASA Science 3D Resources";

export const SOLAR_SYSTEM_MODEL_ASSETS: readonly SolarSystemModelAsset[] = [
  {
    id: "solar-sun",
    bodyName: "Sun",
    format: "procedural-sphere",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/learn/heat/resource/sun-3d-model/",
    assetUrl: "/api/model-assets/solar-sun",
    fallbackColor: [1.0, 0.62, 0.18],
    emissive: 5.5,
  },
  {
    id: "solar-mercury",
    bodyName: "Mercury",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/mercury-3d-model/",
    assetUrl: "/api/model-assets/solar-mercury",
    fallbackColor: [0.72, 0.68, 0.62],
  },
  {
    id: "solar-venus",
    bodyName: "Venus",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/venus-3d-model/",
    assetUrl: "/api/model-assets/solar-venus",
    fallbackColor: [0.92, 0.76, 0.48],
  },
  {
    id: "solar-earth",
    bodyName: "Earth",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/earth-3d-model/",
    assetUrl: "/api/model-assets/solar-earth",
    fallbackColor: [0.36, 0.56, 0.96],
  },
  {
    id: "solar-mars",
    bodyName: "Mars",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/planet-mars-3d-model/",
    assetUrl: "/api/model-assets/solar-mars",
    fallbackColor: [0.86, 0.34, 0.18],
  },
  {
    id: "solar-jupiter",
    bodyName: "Jupiter",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/jupiter-3d-model/",
    assetUrl: "/api/model-assets/solar-jupiter",
    fallbackColor: [0.92, 0.78, 0.58],
  },
  {
    id: "solar-saturn",
    bodyName: "Saturn",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/saturn-3d-model/",
    assetUrl: "/api/model-assets/solar-saturn",
    fallbackColor: [0.95, 0.86, 0.62],
  },
  {
    id: "solar-uranus",
    bodyName: "Uranus",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/uranus-3d-model/",
    assetUrl: "/api/model-assets/solar-uranus",
    fallbackColor: [0.56, 0.86, 0.92],
  },
  {
    id: "solar-neptune",
    bodyName: "Neptune",
    format: "glb",
    source: NASA_SCIENCE,
    sourceUrl: "https://science.nasa.gov/resource/neptune-3d-model/",
    assetUrl: "/api/model-assets/solar-neptune",
    fallbackColor: [0.28, 0.42, 0.95],
  },
];
