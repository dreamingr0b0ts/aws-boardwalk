#!/usr/bin/env node
// Builds frontend/geo/colorado.json — the vendored geometry behind the depth
// chart (the CSP allows only self-hosted assets, so no tile servers or CDN
// GeoJSON). Two public-domain Census sources:
//   - county boundaries: Census 500k cartographic boundary file, via the
//     GeoJSON conversion published in plotly/datasets (filtered to FIPS 08)
//   - ZCTA centroids: Census 2023 Gazetteer (national file, filtered to
//     Colorado's 800xx-816xx range)
// Output is committed; run this only to refresh the vintage.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COUNTIES_URL = 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';
const ZCTA_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../frontend/geo/colorado.json');

const round3 = (n) => Math.round(n * 1000) / 1000;

// Counties: keep Colorado (STATE 08), quantize to 3 decimals (~110 m), drop
// consecutive duplicates the quantization creates.
const all = await (await fetch(COUNTIES_URL)).json();
const counties = all.features
  .filter((f) => f.properties.STATE === '08')
  .map((f) => {
    const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) =>
      poly.map((ring) => {
        const q = ring.map(([lon, lat]) => [round3(lon), round3(lat)]);
        return q.filter((p, i) => i === 0 || p[0] !== q[i - 1][0] || p[1] !== q[i - 1][1]);
      })
    );
    return { name: f.properties.NAME, polys };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// ZCTA centroids: Colorado ZIPs are 80000-81699.
const zipPath = join(tmpdir(), 'gaz_zcta.zip');
const buf = Buffer.from(await (await fetch(ZCTA_URL)).arrayBuffer());
writeFileSync(zipPath, buf);
const txt = execSync(`unzip -p ${zipPath}`, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const zips = {};
for (const line of txt.split('\n').slice(1)) {
  const cols = line.split('\t').map((c) => c.trim());
  if (cols.length < 7) continue;
  const geoid = cols[0];
  const n = Number(geoid);
  if (n >= 80000 && n <= 81699) zips[geoid] = [round3(Number(cols[6])), round3(Number(cols[5]))];
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: 'US Census Bureau (public domain): 500k cartographic county boundaries + 2023 Gazetteer ZCTA centroids', counties, zips }));
console.log(`wrote ${OUT}: ${counties.length} counties, ${Object.keys(zips).length} ZCTA centroids`);
