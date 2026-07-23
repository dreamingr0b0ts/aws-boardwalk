// Static server + live-API proxy for QA'ing zero-build plank frontends locally.
// usage: node serve.mjs <dir> <port> <live-origin> [proxy-prefixes]
//   e.g. node serve.mjs model-workbench/frontend 8899 https://models.demos.planetek.org
//        node serve.mjs api-platform/frontend 8899 https://api.demos.planetek.org /v1/,/v2/
// Serves files from <dir>; paths matching any proxy prefix (default /api/) are
// proxied to the live origin so the page renders real data without being published.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [dir, port = '8899', origin, prefixArg] = process.argv.slice(2);
const prefixes = (prefixArg ?? '/api/').split(',');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (origin && prefixes.some((p) => path.startsWith(p))) {
    try {
      const upstream = await fetch(origin + req.url, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? '',
          authorization: req.headers.authorization ?? '',
          'x-api-key': req.headers['x-api-key'] ?? '',
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502).end(String(err));
    }
    return;
  }
  const file = normalize(join(dir, path === '/' ? 'index.html' : path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(Number(port), () => console.log(`serving ${dir} on :${port}${origin ? ` (api → ${origin})` : ''}`));
