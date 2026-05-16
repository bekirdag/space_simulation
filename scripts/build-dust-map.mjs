#!/usr/bin/env node
/**
 * Real 3D galactic dust map.
 *
 * Positions: sampled from the galactic thin disk in galactocentric coordinates
 *   — identical to how MW background stars are placed. Galaxy-centred, not Sun-centred.
 *
 * Density: for each galactocentric sample point, convert to heliocentric (l, b, d)
 *   and look up the REAL SFD98 E(B-V) column density from IRSA for that sky direction.
 *   The column is weighted by the fraction of dust within distance d to get the
 *   local volumetric density at that 3D point.
 *
 * NO made-up spiral arm sin-wave patterns. Spiral structure emerges naturally from
 * the real SFD data — the measured E(B-V) is already higher toward arm tangent points.
 *
 * Sources: Schlegel, Finkbeiner & Davis (1998) via IRSA DUST tool.
 */

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import https from "https";
import path from "path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT  = path.join(__dir, "../public/data/dust-map-mf2015.bin");
const META = path.join(__dir, "../public/data/dust-map-mf2015.meta.json");
mkdirSync(path.dirname(OUT), { recursive: true });

const R    = [[-0.054876,0.494109,-0.867666],[-0.993911,-0.111106,-0.000312],[-0.096390,0.862326,0.497159]];
const KPC  = 8_000;
const RSUN = 8.5;

function galToEcl(xgc, ygc, zgc) {
  const xh = xgc + RSUN;
  return [
    (R[0][0]*xh+R[0][1]*ygc+R[0][2]*zgc)*KPC,
    (R[1][0]*xh+R[1][1]*ygc+R[1][2]*zgc)*KPC,
    (R[2][0]*xh+R[2][1]*ygc+R[2][2]*zgc)*KPC,
  ];
}

// ── SFD lookup table from IRSA ────────────────────────────────────────────
function fetchSFD(l, b) {
  return new Promise((resolve) => {
    const url = `https://irsa.ipac.caltech.edu/cgi-bin/DUST/nph-dust?locstr=${l.toFixed(2)}+${b.toFixed(2)}+Gal`;
    let xml = "";
    const req = https.get(url, {timeout:15000}, (res)=>{
      res.on("data",c=>xml+=c);
      res.on("end",()=>{const m=xml.match(/<refPixelValueSFD>\s*([\d.]+)/);resolve(m?parseFloat(m[1]):null);});
    });
    req.on("error",()=>resolve(null));
    req.setTimeout(15000,()=>{req.destroy();resolve(null);});
  });
}
async function mapLimit(items,limit,fn){
  const results=new Array(items.length);let cursor=0;
  async function w(){while(cursor<items.length){const i=cursor++;results[i]=await fn(items[i],i);}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},w));
  return results;
}

// Dense grid: 72 longitude × 13 latitude = 936 real SFD measurements
const sfdDirs=[];
for(let i=0;i<72;i++){
  for(const b of [-35,-22,-14,-8,-4,-1,0,1,4,8,14,22,35]) sfdDirs.push({l:i*5,b});
}
console.log(`Fetching ${sfdDirs.length} real SFD measurements from IRSA…`);
const sfdRaw=await mapLimit(sfdDirs,12,async({l,b},i)=>{
  const ebv=await fetchSFD(l,b);
  if(i%72===0) process.stdout.write(`  ${i}/${sfdDirs.length}\r`);
  return {l,b,ebv:ebv??0};
});
console.log(`\n${sfdRaw.filter(d=>d.ebv>0).length}/${sfdDirs.length} fetched.`);

// Build a fast lookup: given (l_deg, b_deg), return nearest SFD E(B-V)
function lookupSFD(lDeg,bDeg) {
  const lR=lDeg*Math.PI/180, bR=bDeg*Math.PI/180;
  let best=0, bestDot=-2;
  for(const {l,b,ebv} of sfdRaw){
    if(!ebv) continue;
    const lR2=l*Math.PI/180, bR2=b*Math.PI/180;
    const dot=Math.sin(bR)*Math.sin(bR2)+Math.cos(bR)*Math.cos(bR2)*Math.cos(lR-lR2);
    if(dot>bestDot){bestDot=dot;best=ebv;}
  }
  return best;
}

// ── Disk density fraction for distance calibration ────────────────────────
// Used only to estimate what fraction of the total column is within distance d.
// No spiral arms — just an exponential disk.
const HR=3.5, HZ=0.10;
function diskRho(d,lR,bR){
  const xh=d*Math.cos(bR)*Math.cos(lR), yh=d*Math.cos(bR)*Math.sin(lR), zh=d*Math.sin(bR);
  const Rgc=Math.sqrt((xh+RSUN)**2+yh**2);
  return Math.exp(-Rgc/HR)*Math.exp(-Math.abs(zh)/HZ);
}
function fractionWithin(d,lR,bR){
  // Numerical integral 0→d vs 0→∞
  const N=20, dMax=20;
  let sum0d=0,sumAll=0;
  for(let i=0;i<N;i++){
    const dd=(i+0.5)*dMax/N;
    const rho=diskRho(dd,lR,bR);
    sumAll+=rho;
    if(dd<=d) sum0d+=rho;
  }
  return sumAll>0?sum0d/sumAll:0.5;
}

// ── Galactocentric sampling — same as MW background stars ─────────────────
let seed=0xcafe9876;
function rand(){seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/0xffffffff;}
function randn(){const u=Math.max(1e-9,rand()),v=rand();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

const N_CELLS=15000, cells=[];
let tried=0;

while(cells.length/8 < N_CELLS && tried < N_CELLS*20){
  tried++;
  // Sample galactocentric radius from exponential disk (no arm model)
  const HR_SAMP=3.5, RMAX=14;
  const Rgc=-HR_SAMP*Math.log(1-rand()*(1-Math.exp(-RMAX/HR_SAMP)));
  if(Rgc<0.3||Rgc>RMAX) continue;

  const theta=rand()*2*Math.PI;
  const z=randn()*HZ;

  // Galactocentric → heliocentric galactic
  const xgc=Rgc*Math.cos(theta), ygc=Rgc*Math.sin(theta);
  const xh=xgc+RSUN, yh=ygc, zh=z;
  const d=Math.sqrt(xh*xh+yh*yh+zh*zh);
  if(d<0.1) continue;

  // Sky direction from Sun to this point
  const lR=Math.atan2(yh,xh);
  const bR=Math.asin(Math.max(-1,Math.min(1,zh/d)));
  const lDeg=((lR*180/Math.PI)+360)%360;
  const bDeg=bR*180/Math.PI;

  // REAL SFD E(B-V) for this sky direction
  const ebvTotal=lookupSFD(lDeg,bDeg);
  if(ebvTotal<=0) continue;

  // Fraction of column within distance d
  const frac=fractionWithin(d,lR,bR);
  // Differential fraction: density near this point
  const df=fractionWithin(d+0.5,lR,bR)-fractionWithin(Math.max(0,d-0.5),lR,bR);
  const ebvLocal=ebvTotal*df*2.5;  // 2.5 = normalisation for 1-kpc bin

  if(ebvLocal<0.005||rand()>Math.min(1,ebvLocal/0.3)) continue;

  const [x,y,zz]=galToEcl(xgc,ygc,z);

  // Cell size in AU
  const size=Rgc*KPC*0.07*(0.6+rand()*0.8);

  // Alpha: sqrt-compressed real E(B-V) value
  const capped=Math.min(ebvLocal,6.0);
  const alpha=Math.min(0.48,Math.sqrt(capped/6)*0.52)*(0.7+rand()*0.6);
  if(alpha<0.012) continue;

  // Colour: very dark warm grey-brown, redder for denser dust
  const redness=Math.min(1,capped/4);
  cells.push(x,y,zz,size,
    0.08+redness*0.15, 0.05+redness*0.06, 0.03+redness*0.04,
    alpha);
}

const out=new Float32Array(cells);
writeFileSync(OUT,Buffer.from(out.buffer));
const n=cells.length/8;
let sa=0,ma=0;
for(let i=0;i<n;i++){const a=cells[i*8+7];sa+=a;ma=Math.max(ma,a);}
writeFileSync(META,JSON.stringify({
  sourceName: "NASA/IPAC IRSA SFD98 reddening — galaxy-centred, no procedural arms",
  description: `${sfdRaw.filter(d=>d.ebv>0).length} real SFD98 sightlines from IRSA. ` +
    "Positions sampled galactocentrically (same method as MW star catalog). " +
    "Dust density at each position from real SFD lookup — spiral structure from real data, not sin waves.",
  generated: new Date().toISOString(),
  sfdSightlines: sfdRaw.filter(d=>d.ebv>0).length,
  cellCount: n, scaleAUperKpc: KPC,
},null,2));
console.log(`Written ${n} cells. Alpha avg=${(sa/n).toFixed(3)} max=${ma.toFixed(3)}`);
