#!/usr/bin/env node
// Builds the equirectangular surface textures used by the textured-sphere
// solar-system body renderer (src/gpu/body-surfaces.ts).
//
//   node scripts/build-body-textures.mjs
//
// Raw source maps are downloaded once into cache/textures/src (gitignored) and
// processed with ImageMagick 7 (`magick`) into public/textures/bodies/. Every
// output is normalised to the same convention:
//   - simple cylindrical (equirectangular), north up
//   - u = 0.5 is longitude 0 (the IAU prime meridian), east longitude
//     increasing to the right (u = 0 / 1 is 180 deg)
// Output file names carry a content hash, so browsers never reuse a stale
// force-cached copy. The script also writes public/textures/bodies/manifest.json
// (source URL, licence and credit per texture) and
// src/catalog/body-textures.generated.ts (hashed URLs for the client).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC_DIR = path.join(ROOT, "cache", "textures", "src");
const OUT_DIR = path.join(ROOT, "public", "textures", "bodies");
const OUT_URL = "/textures/bodies";
const TS_OUT = path.join(ROOT, "src", "catalog", "body-textures.generated.ts");

const SSS = "https://www.solarsystemscope.com/textures/download";
const USGS = "https://planetarymaps.usgs.gov/mosaic";
const COMMONS = "https://upload.wikimedia.org/wikipedia/commons";

const SSS_CREDIT = {
  credit: "Solar System Scope (INOVE)",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  page: "https://www.solarsystemscope.com/textures/",
};
const usgsCredit = (credit, page) => ({
  credit,
  license: "Public domain (NASA/USGS)",
  licenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
  page,
});

/** Raw inputs. `roll` shifts the image (fraction of width) so lon 0 lands at u = 0.5. */
const SOURCES = {
  "sss-earth-day":    { file: "sss_8k_earth_daymap.jpg",   url: `${SSS}/8k_earth_daymap.jpg`, ...SSS_CREDIT, note: "Based on NASA Blue Marble imagery" },
  "sss-earth-night":  { file: "sss_8k_earth_nightmap.jpg", url: `${SSS}/8k_earth_nightmap.jpg`, ...SSS_CREDIT, note: "Based on NASA Black Marble imagery" },
  "sss-earth-clouds": { file: "sss_8k_earth_clouds.jpg",   url: `${SSS}/8k_earth_clouds.jpg`, ...SSS_CREDIT },
  "sss-moon":         { file: "sss_8k_moon.jpg",           url: `${SSS}/8k_moon.jpg`, ...SSS_CREDIT, note: "Based on NASA LRO imagery" },
  "sss-mars":         { file: "sss_8k_mars.jpg",           url: `${SSS}/8k_mars.jpg`, ...SSS_CREDIT, note: "Based on NASA/USGS Viking/MGS imagery" },
  "sss-mercury":      { file: "sss_8k_mercury.jpg",        url: `${SSS}/8k_mercury.jpg`, ...SSS_CREDIT, note: "Based on NASA MESSENGER imagery" },
  "sss-venus-atmo":   { file: "sss_4k_venus_atmosphere.jpg", url: `${SSS}/4k_venus_atmosphere.jpg`, ...SSS_CREDIT },
  "sss-jupiter":      { file: "sss_8k_jupiter.jpg",        url: `${SSS}/8k_jupiter.jpg`, ...SSS_CREDIT, note: "Based on NASA Cassini/Juno imagery" },
  "sss-saturn":       { file: "sss_8k_saturn.jpg",         url: `${SSS}/8k_saturn.jpg`, ...SSS_CREDIT },
  "sss-saturn-ring":  { file: "sss_8k_saturn_ring_alpha.png", url: `${SSS}/8k_saturn_ring_alpha.png`, ...SSS_CREDIT },
  "sss-uranus":       { file: "sss_2k_uranus.jpg",         url: `${SSS}/2k_uranus.jpg`, ...SSS_CREDIT },
  "sss-neptune":      { file: "sss_2k_neptune.jpg",        url: `${SSS}/2k_neptune.jpg`, ...SSS_CREDIT },
  "sss-eris":         { file: "sss_4k_eris_fictional.jpg", url: `${SSS}/4k_eris_fictional.jpg`, ...SSS_CREDIT, note: "Fictional terrain (no spacecraft imagery exists)" },
  "sss-haumea":       { file: "sss_4k_haumea_fictional.jpg", url: `${SSS}/4k_haumea_fictional.jpg`, ...SSS_CREDIT, note: "Fictional terrain (no spacecraft imagery exists)" },
  "sss-makemake":     { file: "sss_4k_makemake_fictional.jpg", url: `${SSS}/4k_makemake_fictional.jpg`, ...SSS_CREDIT, note: "Fictional terrain (no spacecraft imagery exists)" },

  "usgs-io":       { file: "io.tif",       url: `${USGS}/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif`, roll: 0, ...usgsCredit("NASA/JPL/USGS Galileo SSI + Voyager colour mosaic", "https://astrogeology.usgs.gov/search/map/io_galileo_ssi_voyager_global_mosaic_clrmerge_1km") },
  "usgs-europa":   { file: "europa.tif",   url: `${USGS}/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif`, roll: 0.5, ...usgsCredit("NASA/JPL/USGS Voyager + Galileo SSI mosaic", "https://astrogeology.usgs.gov/search/map/europa_voyager_galileo_ssi_global_mosaic_500m") },
  "usgs-ganymede": { file: "ganymede.tif", url: `${USGS}/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif`, roll: 0.5, ...usgsCredit("NASA/JPL/USGS Voyager + Galileo SSI colour mosaic", "https://astrogeology.usgs.gov/search/map/ganymede_voyager_galileo_ssi_global_clrmosaic_1435m") },
  "usgs-callisto": { file: "callisto.tif", url: `${USGS}/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif`, roll: 0.5, ...usgsCredit("NASA/JPL/USGS Voyager + Galileo SSI mosaic", "https://astrogeology.usgs.gov/search/map/callisto_voyager_galileo_ssi_global_mosaic_1km") },
  "usgs-mimas":    { file: "MI_170630_DLR_basemap_degrees.tif", url: `${USGS}/Mimas/Cassini_DLR_Mimas.zip`, zipMember: "Cassini_DLR/MI_170630_DLR_basemap_degrees.tif", roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS, DLR basemap (Roatsch et al.)", "https://astrogeology.usgs.gov/search/map/mimas_cassini_global_mosaic_dlr") },
  "usgs-enceladus":{ file: "enceladus.tif", url: `${USGS}/Enceladus_Cassini_mosaic_global_110m.tif`, roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS mosaic (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/enceladus_cassini_iss_global_mosaic_110m") },
  "usgs-tethys":   { file: "tethys.tif",   url: `${USGS}/Tethys_Cassini_mosaic_global_293m.tif`, roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS mosaic (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/tethys_cassini_iss_global_mosaic_293m") },
  "usgs-dione":    { file: "dione.tif",    url: `${USGS}/Dione_Cassini_Voyager_mosaic_global_154m.tif`, roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS + Voyager mosaic (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/dione_cassini_voyager_global_mosaic_154m") },
  "usgs-rhea":     { file: "rhea.tif",     url: `${USGS}/Rhea_Cassini_Voyager_mosaic_global_417m.tif`, roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS + Voyager mosaic (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/rhea_cassini_voyager_global_mosaic_417m") },
  "usgs-titan":    { file: "titan.tif",    url: `${USGS}/Titan_ISS_P19658_Mosaic_Global_4km.tif`, roll: 0.5, ...usgsCredit("NASA/JPL/SSI Cassini ISS near-IR mosaic (USGS)", "https://astrogeology.usgs.gov/search/map/titan_cassini_iss_global_mosaic_4km") },
  "usgs-iapetus":  { file: "iapetus.tif",  url: `${USGS}/Iapetus_Cassini_Voyager_mosaic_global_783m.tif`, roll: 0, ...usgsCredit("NASA/JPL/SSI Cassini ISS + Voyager mosaic (DLR/USGS)", "https://astrogeology.usgs.gov/search/map/iapetus_cassini_voyager_global_mosaic_783m") },
  "usgs-triton":   { file: "triton.tif",   url: `${USGS}/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif`, roll: 0, ...usgsCredit("NASA/JPL/USGS Voyager 2 colour mosaic (unimaged areas filled)", "https://astrogeology.usgs.gov/search/map/triton_voyager_2_global_color_mosaic_600m") },
  "usgs-pluto":    { file: "pluto.tif",    url: `${USGS}/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`, roll: 0.5, ...usgsCredit("NASA/JHUAPL/SwRI New Horizons LORRI+MVIC mosaic (USGS)", "https://astrogeology.usgs.gov/search/map/pluto_new_horizons_lorri_mvic_global_mosaic_300m") },
  "usgs-charon":   { file: "charon.tif",   url: `${USGS}/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`, roll: 0, ...usgsCredit("NASA/JHUAPL/SwRI New Horizons LORRI+MVIC mosaic (USGS)", "https://astrogeology.usgs.gov/search/map/charon_new_horizons_lorri_mvic_global_mosaic_300m") },
  "usgs-ceres":    { file: "ceres.tif",    url: `${USGS}/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif`, roll: 0.5, ...usgsCredit("NASA/JPL-Caltech/UCLA/MPS/DLR/IDA Dawn FC mosaic", "https://astrogeology.usgs.gov/search/map/ceres_dawn_fc_dlr_global_mosaic_20ppd") },

  // Voyager 2 imaged only the southern hemispheres of the Uranian moons; the
  // unimaged north is filled with a flat neutral tone.
  "jpl-miranda": { file: "miranda.jpg", url: `${COMMONS}/8/81/Miranda_map_JPL_USGS.jpg`, roll: 0, credit: "NASA/JPL/USGS Voyager 2 mosaic", license: "Public domain", licenseUrl: "https://commons.wikimedia.org/wiki/File:Miranda_map_JPL_USGS.jpg", page: "https://commons.wikimedia.org/wiki/File:Miranda_map_JPL_USGS.jpg" },
  "jpl-ariel":   { file: "ariel.jpg",   url: `${COMMONS}/7/74/Ariel_map_JPL_USGS.jpg`, roll: 0, credit: "NASA/JPL/USGS Voyager 2 mosaic", license: "Public domain", licenseUrl: "https://commons.wikimedia.org/wiki/File:Ariel_map_JPL_USGS.jpg", page: "https://commons.wikimedia.org/wiki/File:Ariel_map_JPL_USGS.jpg" },
  "jpl-umbriel": { file: "umbriel.jpg", url: `${COMMONS}/4/42/Umbriel_map_JPL_USGS.jpg`, roll: 0, credit: "NASA/JPL/USGS Voyager 2 mosaic", license: "Public domain", licenseUrl: "https://commons.wikimedia.org/wiki/File:Umbriel_map_JPL_USGS.jpg", page: "https://commons.wikimedia.org/wiki/File:Umbriel_map_JPL_USGS.jpg" },
  "jpl-titania": { file: "titania.jpg", url: `${COMMONS}/8/85/Titania_map_JPL_USGS.jpg`, roll: 0, credit: "NASA/JPL/USGS Voyager 2 mosaic", license: "Public domain", licenseUrl: "https://commons.wikimedia.org/wiki/File:Titania_map_JPL_USGS.jpg", page: "https://commons.wikimedia.org/wiki/File:Titania_map_JPL_USGS.jpg" },
  "jpl-oberon":  { file: "oberon.jpg",  url: `${COMMONS}/1/1d/Oberon_map_JPL_USGS.jpg`, roll: 0, credit: "NASA/JPL/USGS Voyager 2 mosaic", license: "Public domain", licenseUrl: "https://commons.wikimedia.org/wiki/File:Oberon_map_JPL_USGS.jpg", page: "https://commons.wikimedia.org/wiki/File:Oberon_map_JPL_USGS.jpg" },
};

/**
 * Outputs. `tint` maps a greyscale source onto a dark->bright colour ramp
 * (approximate true colour for single-band mosaics). `fillNoData` replaces the
 * black unimaged area with the mean tone.
 */
const OUTPUTS = [
  { id: "earth",     src: "sss-earth-day",   size: 4096 },
  { id: "earth-aux", src: "earth-aux",       size: 4096, special: "earth-aux" },
  { id: "moon",      src: "sss-moon",        size: 4096 },
  { id: "mercury",   src: "sss-mercury",     size: 4096 },
  { id: "venus",     src: "sss-venus-atmo",  size: 2048 },
  { id: "mars",      src: "sss-mars",        size: 4096 },
  { id: "jupiter",   src: "sss-jupiter",     size: 4096 },
  { id: "saturn",    src: "sss-saturn",      size: 4096 },
  { id: "saturn-ring", src: "sss-saturn-ring", special: "ring" },
  { id: "uranus",    src: "sss-uranus",      size: 2048 },
  { id: "neptune",   src: "sss-neptune",     size: 2048 },

  { id: "io",        src: "usgs-io",         size: 2048 },
  { id: "europa",    src: "usgs-europa",     size: 2048, tint: ["rgb(96,74,52)", "rgb(246,238,222)"], fillNoData: true },
  { id: "ganymede",  src: "usgs-ganymede",   size: 2048, fillNoData: true },
  { id: "callisto",  src: "usgs-callisto",   size: 2048, tint: ["rgb(30,26,22)", "rgb(214,200,178)"], fillNoData: true, level: "0%,88%" },
  { id: "mimas",     src: "usgs-mimas",      size: 2048, tint: ["rgb(58,56,54)", "rgb(238,236,232)"] },
  { id: "enceladus", src: "usgs-enceladus",  size: 2048, tint: ["rgb(92,98,108)", "rgb(252,253,255)"] },
  { id: "tethys",    src: "usgs-tethys",     size: 2048, tint: ["rgb(70,68,66)", "rgb(242,240,236)"] },
  { id: "dione",     src: "usgs-dione",      size: 2048, tint: ["rgb(58,56,54)", "rgb(236,233,228)"] },
  { id: "rhea",      src: "usgs-rhea",       size: 2048, tint: ["rgb(56,53,50)", "rgb(236,232,226)"] },
  { id: "titan",     src: "usgs-titan",      size: 2048, tint: ["rgb(150,92,34)", "rgb(226,160,72)"] },
  { id: "iapetus",   src: "usgs-iapetus",    size: 2048, tint: ["rgb(34,22,14)", "rgb(238,232,222)"] },
  { id: "miranda",   src: "jpl-miranda",     size: 1440, tint: ["rgb(52,52,52)", "rgb(222,220,218)"], fillNoData: true },
  { id: "ariel",     src: "jpl-ariel",       size: 1440, tint: ["rgb(60,59,58)", "rgb(232,230,228)"], fillNoData: true },
  { id: "umbriel",   src: "jpl-umbriel",     size: 1440, tint: ["rgb(34,33,33)", "rgb(170,168,166)"], fillNoData: true },
  { id: "titania",   src: "jpl-titania",     size: 1440, tint: ["rgb(50,48,46)", "rgb(214,208,202)"], fillNoData: true },
  { id: "oberon",    src: "jpl-oberon",      size: 1440, tint: ["rgb(44,40,38)", "rgb(200,190,182)"], fillNoData: true },
  { id: "triton",    src: "usgs-triton",     size: 2048, fillNoData: true },
  { id: "pluto",     src: "usgs-pluto",      size: 2048, tint: ["rgb(62,30,16)", "rgb(250,236,214)"], fillNoData: true },
  { id: "charon",    src: "usgs-charon",     size: 2048, tint: ["rgb(52,42,38)", "rgb(220,214,208)"], fillNoData: true },
  { id: "ceres",     src: "usgs-ceres",      size: 2048, tint: ["rgb(28,27,26)", "rgb(200,196,190)"] },
  // No imagery exists: Solar System Scope's fictional terrains recoloured to the
  // catalogue colours (presets.ts) so they read as generic surfaces.
  { id: "eris",      src: "sss-eris",        size: 2048, tint: ["rgb(120,118,116)", "rgb(240,236,232)"] },
  { id: "haumea",    src: "sss-haumea",      size: 2048, tint: ["rgb(118,114,110)", "rgb(236,232,228)"] },
  { id: "makemake",  src: "sss-makemake",    size: 2048, tint: ["rgb(110,84,62)", "rgb(228,206,184)"] },
];

function magick(args) {
  execFileSync("magick", args, { stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 26 });
}

async function download(url, dest) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (CosmosMap texture build)",
      Referer: url.startsWith(SSS) ? "https://www.solarsystemscope.com/textures/" : "",
    },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(`${dest}.part`, buf);
  await rename(`${dest}.part`, dest);
}

async function ensureSource(key) {
  const src = SOURCES[key];
  const dest = path.join(SRC_DIR, src.file);
  if (existsSync(dest) && (await stat(dest)).size > 0) return dest;
  console.log(`download ${src.url}`);
  if (src.zipMember) {
    const zip = path.join(SRC_DIR, `${key}.zip`);
    if (!existsSync(zip)) await download(src.url, zip);
    execFileSync("unzip", ["-o", "-q", "-j", zip, src.zipMember, "-d", SRC_DIR]);
  } else {
    await download(src.url, dest);
  }
  return dest;
}

const JPEG_ARGS = ["-strip", "-interlace", "JPEG", "-sampling-factor", "4:2:0", "-quality", "90"];

async function build(output, tmp) {
  const w = output.size ?? 2048;
  const h = w / 2;
  if (output.special === "earth-aux") {
    // R = night-lights luminance, G = cloud cover, B = 0. Stored 4:4:4 so the
    // channels do not bleed into each other through chroma subsampling.
    const night = await ensureSource("sss-earth-night");
    const clouds = await ensureSource("sss-earth-clouds");
    magick([
      "(", night, "-colorspace", "Gray", "-resize", `${w}x${h}!`, ")",
      "(", clouds, "-colorspace", "Gray", "-resize", `${w}x${h}!`, ")",
      "(", "-size", `${w}x${h}`, "xc:black", ")",
      "-set", "colorspace", "sRGB", "-combine",
      "-strip", "-interlace", "JPEG", "-sampling-factor", "4:4:4", "-quality", "85", tmp,
    ]);
    return ["sss-earth-night", "sss-earth-clouds"];
  }
  if (output.special === "ring") {
    // Radial ring profile: x = inner (74,658 km) -> outer (140,220 km) edge.
    const ring = await ensureSource(output.src);
    magick([ring, "-resize", "2048x8!", "-strip", `PNG32:${tmp}`]);
    return [output.src];
  }

  const src = SOURCES[output.src];
  const input = await ensureSource(output.src);
  const args = [input];
  if (output.tint) args.push("-colorspace", "Gray");
  args.push("-resize", `${w}x${h}!`);
  if (src.roll) args.push("-roll", `+${Math.round(w * src.roll)}+0`);
  if (output.fillNoData) {
    // Replace the black unimaged region with the mean colour of the imaged pixels.
    const rgb = execFileSync("magick", [input, "-resize", "360x180!", "-colorspace", "sRGB", "-depth", "8", "rgb:-"], { maxBuffer: 1 << 24 });
    let sum = [0, 0, 0];
    let count = 0;
    for (let i = 0; i + 2 < rgb.length; i += 3) {
      if (rgb[i] + rgb[i + 1] + rgb[i + 2] <= 12) continue;
      sum[0] += rgb[i]; sum[1] += rgb[i + 1]; sum[2] += rgb[i + 2];
      count++;
    }
    const [r, g, b] = sum.map(v => Math.round(v / Math.max(1, count)));
    // Feathered fill: blend the imaged terrain into the mean tone over a few
    // pixels instead of a hard black/flat edge.
    const feather = Math.max(2, Math.round(w / 400));
    args.splice(0, args.length,
      "-size", `${w}x${h}`, `xc:rgb(${r},${g},${b})`,
      "(", input, ...(output.tint ? ["-colorspace", "Gray"] : []), "-resize", `${w}x${h}!`,
      ...(src.roll ? ["-roll", `+${Math.round(w * src.roll)}+0`] : []), ")",
      "(", "+clone", "-colorspace", "Gray", "-threshold", "2%", "-morphology", "Erode", `Disk:${feather}`,
      "-blur", `0x${feather}`, ")",
      "-composite");
  }
  if (output.level) args.push("-level", output.level);
  if (output.tint) args.push("+level-colors", `${output.tint[0]},${output.tint[1]}`);
  args.push("-colorspace", "sRGB", "-type", "TrueColor", ...JPEG_ARGS, tmp);
  magick(args);
  return [output.src];
}

async function main() {
  await mkdir(SRC_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const previous = existsSync(path.join(OUT_DIR, "manifest.json"))
    ? JSON.parse(await readFile(path.join(OUT_DIR, "manifest.json"), "utf8"))
    : { textures: {} };
  const manifest = { generatedBy: "scripts/build-body-textures.mjs", convention: "equirectangular, u=0.5 at longitude 0, east to the right, north up", textures: { ...previous.textures } };
  const existing = await readdir(OUT_DIR);

  for (const output of OUTPUTS) {
    if (only.size > 0 && !only.has(output.id)) continue;
    const ext = output.special === "ring" ? "png" : "jpg";
    const tmp = path.join(OUT_DIR, `.${output.id}.tmp.${ext}`);
    const sourceKeys = await build(output, tmp);
    const hash = createHash("sha256").update(await readFile(tmp)).digest("hex").slice(0, 10);
    const name = `${output.id}.${hash}.${ext}`;
    for (const file of existing) {
      if (file !== name && file.startsWith(`${output.id}.`) && /^[a-z-]+\.[0-9a-f]{10}\.(jpg|png)$/.test(file)
        && file.slice(0, file.indexOf(".")) === output.id) {
        await unlink(path.join(OUT_DIR, file));
      }
    }
    await rename(tmp, path.join(OUT_DIR, name));
    manifest.textures[output.id] = {
      url: `${OUT_URL}/${name}`,
      sources: sourceKeys.map(key => {
        const { file: _file, roll: _roll, zipMember: _zip, ...meta } = SOURCES[key];
        return meta;
      }),
      processing: [
        output.tint ? `greyscale mosaic tinted ${output.tint[0]} -> ${output.tint[1]} (approximate colour)` : null,
        output.fillNoData ? "unimaged (black) area filled with the mean tone" : null,
        output.level ? `levels ${output.level}` : null,
        SOURCES[output.src]?.roll ? `rolled ${SOURCES[output.src].roll * 360} deg so longitude 0 is centred` : null,
      ].filter(Boolean),
    };
    console.log(`${name}  (${((await stat(path.join(OUT_DIR, name))).size / 1024).toFixed(0)} KiB)`);
  }

  await writeFile(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const urls = Object.fromEntries(Object.entries(manifest.textures).map(([id, t]) => [id, t.url]));
  await writeFile(TS_OUT, [
    "// Generated by scripts/build-body-textures.mjs. Do not edit by hand.",
    "// Content-hashed URLs of the equirectangular body textures (u = 0.5 at",
    "// longitude 0, east to the right). Sources/licences: public/textures/bodies/manifest.json.",
    `export const BODY_TEXTURE_URLS = ${JSON.stringify(urls, null, 2)} as const;`,
    "",
    "export type BodyTextureId = keyof typeof BODY_TEXTURE_URLS;",
    "",
  ].join("\n"));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
