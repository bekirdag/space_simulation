import { BODY_TEXTURE_URLS, type BodyTextureId } from "./body-textures.generated";

/**
 * Textured-sphere surfaces for solar-system bodies (src/gpu/body-surfaces.ts).
 *
 * Every body is a ray-traced ellipsoid oriented by its IAU/NAIF rotation
 * (src/physics/rotations.ts) and skinned with an equirectangular map normalised
 * by scripts/build-body-textures.mjs to u = 0.5 at longitude 0 with east
 * longitude increasing, so the texture's prime meridian lands exactly where the
 * IAU W angle puts it. Sources, licences and credits for every map are recorded
 * in public/textures/bodies/manifest.json.
 */
export type BodySurfaceKind = "rocky" | "gas" | "sun" | "earth";

export interface SolarSystemModelAsset {
  id: string;
  bodyName: string;
  kind: BodySurfaceKind;
  /** Content-hashed colour map URL (sRGB). */
  colorTexture?: string;
  /** Earth only: R = night lights, G = clouds (linear). */
  auxTexture?: string;
  /** Saturn only: radial ring colour/alpha strip (inner -> outer edge). */
  ringTexture?: string;
  /** Ring inner/outer radius in km (planet centre). */
  ringRadiiKm?: [number, number];
  /** Body-frame semi-axes (x toward prime meridian, y, z polar) in km. */
  semiAxesKm?: [number, number, number];
  /**
   * Longitude (deg east) shown at the texture centre (u = 0.5). 0 for every
   * map with a surface reference; gas-giant cloud maps have no fixed features.
   */
  textureCenterLonDeg?: number;
  fallbackColor: [number, number, number];
  /** Sun only: HDR emission gain. */
  emissive?: number;
  /** 0 = none, 1 = strong limb darkening. */
  limbDarkening?: number;
  /** Thin-atmosphere rim strength (uses `atmosphereColor`). */
  atmosphere?: number;
  atmosphereColor?: [number, number, number];
  /**
   * Bodies without IAU rotation elements: spin about the ecliptic north pole.
   * Approximate and labelled as such.
   */
  rotationFallback?: { periodHours: number; w0Deg: number };
  credit: string;
  sourceUrl: string;
  license: string;
}

const tex = (id: BodyTextureId): string => BODY_TEXTURE_URLS[id];

const SSS = { credit: "Solar System Scope", sourceUrl: "https://www.solarsystemscope.com/textures/", license: "CC BY 4.0" } as const;
const USGS = { license: "Public domain" } as const;

const moon = (
  bodyName: string,
  id: BodyTextureId,
  fallbackColor: [number, number, number],
  credit: string,
  sourceUrl: string,
  extra: Partial<SolarSystemModelAsset> = {},
): SolarSystemModelAsset => ({
  id: `body-${id}`,
  bodyName,
  kind: "rocky",
  colorTexture: tex(id),
  fallbackColor,
  limbDarkening: 0.08,
  credit,
  sourceUrl,
  ...USGS,
  ...extra,
});

export const SOLAR_SYSTEM_MODEL_ASSETS: readonly SolarSystemModelAsset[] = [
  {
    id: "body-sun",
    bodyName: "Sun",
    kind: "sun",
    fallbackColor: [1.0, 0.62, 0.18],
    emissive: 5.5,
    credit: "Procedural photosphere",
    sourceUrl: "",
    license: "",
  },
  { id: "body-mercury", bodyName: "Mercury", kind: "rocky", colorTexture: tex("mercury"), fallbackColor: [0.72, 0.68, 0.62], limbDarkening: 0.08, ...SSS },
  {
    id: "body-venus", bodyName: "Venus", kind: "gas", colorTexture: tex("venus"), fallbackColor: [0.92, 0.76, 0.48],
    limbDarkening: 0.45, atmosphere: 0.25, atmosphereColor: [1.0, 0.9, 0.7], ...SSS,
  },
  {
    id: "body-earth", bodyName: "Earth", kind: "earth", colorTexture: tex("earth"), auxTexture: tex("earth-aux"),
    semiAxesKm: [6378.137, 6378.137, 6356.752], fallbackColor: [0.36, 0.56, 0.96],
    limbDarkening: 0.12, atmosphere: 0.55, atmosphereColor: [0.32, 0.55, 1.0], ...SSS,
  },
  moon("Moon", "moon", [0.85, 0.82, 0.78], SSS.credit, SSS.sourceUrl, { license: SSS.license }),
  {
    id: "body-mars", bodyName: "Mars", kind: "rocky", colorTexture: tex("mars"), semiAxesKm: [3396.19, 3396.19, 3376.2],
    fallbackColor: [0.86, 0.34, 0.18], limbDarkening: 0.1, atmosphere: 0.12, atmosphereColor: [1.0, 0.62, 0.42], ...SSS,
  },
  {
    id: "body-jupiter", bodyName: "Jupiter", kind: "gas", colorTexture: tex("jupiter"), semiAxesKm: [71492, 71492, 66854],
    fallbackColor: [0.92, 0.78, 0.58], limbDarkening: 0.6, ...SSS,
  },
  {
    id: "body-saturn", bodyName: "Saturn", kind: "gas", colorTexture: tex("saturn"), ringTexture: tex("saturn-ring"),
    ringRadiiKm: [74_658, 140_220], semiAxesKm: [60268, 60268, 54364],
    fallbackColor: [0.95, 0.86, 0.62], limbDarkening: 0.55, ...SSS,
  },
  {
    id: "body-uranus", bodyName: "Uranus", kind: "gas", colorTexture: tex("uranus"), semiAxesKm: [25559, 25559, 24973],
    fallbackColor: [0.56, 0.86, 0.92], limbDarkening: 0.55, ...SSS,
  },
  {
    id: "body-neptune", bodyName: "Neptune", kind: "gas", colorTexture: tex("neptune"), semiAxesKm: [24764, 24764, 24341],
    fallbackColor: [0.28, 0.42, 0.95], limbDarkening: 0.55, ...SSS,
  },

  moon("Io", "io", [0.90, 0.72, 0.28], "NASA/JPL/USGS Galileo SSI + Voyager", "https://astrogeology.usgs.gov/search/map/io_galileo_ssi_voyager_global_mosaic_clrmerge_1km"),
  moon("Europa", "europa", [0.84, 0.80, 0.75], "NASA/JPL/USGS Voyager + Galileo SSI", "https://astrogeology.usgs.gov/search/map/europa_voyager_galileo_ssi_global_mosaic_500m"),
  moon("Ganymede", "ganymede", [0.62, 0.56, 0.50], "NASA/JPL/USGS Voyager + Galileo SSI", "https://astrogeology.usgs.gov/search/map/ganymede_voyager_galileo_ssi_global_clrmosaic_1435m"),
  moon("Callisto", "callisto", [0.48, 0.43, 0.40], "NASA/JPL/USGS Voyager + Galileo SSI", "https://astrogeology.usgs.gov/search/map/callisto_voyager_galileo_ssi_global_mosaic_1km"),
  moon("Mimas", "mimas", [0.85, 0.83, 0.80], "NASA/JPL/SSI Cassini ISS (DLR)", "https://astrogeology.usgs.gov/search/map/mimas_cassini_global_mosaic_dlr"),
  moon("Enceladus", "enceladus", [0.96, 0.96, 0.98], "NASA/JPL/SSI Cassini ISS (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/enceladus_cassini_iss_global_mosaic_110m"),
  moon("Tethys", "tethys", [0.83, 0.80, 0.78], "NASA/JPL/SSI Cassini ISS (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/tethys_cassini_iss_global_mosaic_293m"),
  moon("Dione", "dione", [0.80, 0.77, 0.75], "NASA/JPL/SSI Cassini ISS + Voyager (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/dione_cassini_voyager_global_mosaic_154m"),
  moon("Rhea", "rhea", [0.78, 0.74, 0.72], "NASA/JPL/SSI Cassini ISS + Voyager (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/rhea_cassini_voyager_global_mosaic_417m"),
  moon("Titan", "titan", [0.90, 0.65, 0.30], "NASA/JPL/SSI Cassini ISS near-IR (USGS)", "https://astrogeology.usgs.gov/search/map/titan_cassini_iss_global_mosaic_4km", {
    limbDarkening: 0.35, atmosphere: 0.6, atmosphereColor: [1.0, 0.72, 0.32],
  }),
  moon("Iapetus", "iapetus", [0.65, 0.60, 0.55], "NASA/JPL/SSI Cassini ISS + Voyager (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/iapetus_cassini_voyager_global_mosaic_783m"),
  moon("Miranda", "miranda", [0.68, 0.65, 0.62], "NASA/JPL/USGS Voyager 2 (south only)", "https://commons.wikimedia.org/wiki/File:Miranda_map_JPL_USGS.jpg"),
  moon("Ariel", "ariel", [0.72, 0.70, 0.68], "NASA/JPL/USGS Voyager 2 (south only)", "https://commons.wikimedia.org/wiki/File:Ariel_map_JPL_USGS.jpg"),
  moon("Umbriel", "umbriel", [0.42, 0.40, 0.40], "NASA/JPL/USGS Voyager 2 (south only)", "https://commons.wikimedia.org/wiki/File:Umbriel_map_JPL_USGS.jpg"),
  moon("Titania", "titania", [0.62, 0.60, 0.58], "NASA/JPL/USGS Voyager 2 (south only)", "https://commons.wikimedia.org/wiki/File:Titania_map_JPL_USGS.jpg"),
  moon("Oberon", "oberon", [0.52, 0.48, 0.46], "NASA/JPL/USGS Voyager 2 (south only)", "https://commons.wikimedia.org/wiki/File:Oberon_map_JPL_USGS.jpg"),
  moon("Triton", "triton", [0.72, 0.78, 0.90], "NASA/JPL/USGS Voyager 2", "https://astrogeology.usgs.gov/search/map/triton_voyager_2_global_color_mosaic_600m"),
  moon("Pluto", "pluto", [0.82, 0.75, 0.68], "NASA/JHUAPL/SwRI New Horizons (USGS)", "https://astrogeology.usgs.gov/search/map/pluto_new_horizons_lorri_mvic_global_mosaic_300m", {
    atmosphere: 0.12, atmosphereColor: [0.55, 0.7, 1.0],
  }),
  moon("Charon", "charon", [0.72, 0.68, 0.65], "NASA/JHUAPL/SwRI New Horizons (USGS)", "https://astrogeology.usgs.gov/search/map/charon_new_horizons_lorri_mvic_global_mosaic_300m"),
  moon("Ceres", "ceres", [0.58, 0.55, 0.52], "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA Dawn FC", "https://astrogeology.usgs.gov/search/map/ceres_dawn_fc_dlr_global_mosaic_20ppd"),
  // No imagery exists for these: generic (fictional) terrain recoloured to the
  // catalogue colour, spin axis approximated by the ecliptic pole.
  moon("Eris", "eris", [0.92, 0.90, 0.88], "Generic surface: Solar System Scope fictional terrain", SSS.sourceUrl, {
    license: SSS.license, rotationFallback: { periodHours: 378.9, w0Deg: 0 },
  }),
  moon("Haumea", "haumea", [0.88, 0.86, 0.84], "Generic surface: Solar System Scope fictional terrain", SSS.sourceUrl, {
    license: SSS.license, semiAxesKm: [1161, 852, 513], rotationFallback: { periodHours: 3.9155, w0Deg: 0 },
  }),
  moon("Makemake", "makemake", [0.80, 0.72, 0.65], "Generic surface: Solar System Scope fictional terrain", SSS.sourceUrl, {
    license: SSS.license, rotationFallback: { periodHours: 22.83, w0Deg: 0 },
  }),
];
