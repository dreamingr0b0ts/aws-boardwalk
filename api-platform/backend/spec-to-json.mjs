// Publish-time converter: infra/openapi.yaml (the single source of truth that
// terraform imports into API Gateway) → frontend/openapi.json (what the docs
// page renders). Strips the x-amazon-apigateway-* wiring — it's deployment
// detail, not API contract — and pins the public server URL.
// Usage: node spec-to-json.mjs <in.yaml> <out.json> <serverUrl>
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const [, , inPath, outPath, serverUrl] = process.argv;
if (!inPath || !outPath || !serverUrl) {
  console.error('usage: node spec-to-json.mjs <in.yaml> <out.json> <serverUrl>');
  process.exit(1);
}

function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !k.startsWith('x-amazon-apigateway'))
        .map(([k, v]) => [k, strip(v)])
    );
  }
  return node;
}

const spec = strip(parse(readFileSync(inPath, 'utf8')));
spec.servers = [{ url: serverUrl }];
writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`wrote ${outPath}`);
