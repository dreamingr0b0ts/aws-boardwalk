// Static server + /api proxy for QA'ing zero-build plank frontends locally.
// usage: node serve.mjs <dir> <port> <live-origin>
//   e.g. node serve.mjs model-workbench/frontend 8899 https://models.demos.planetek.org
// Serves files from <dir>; anything under /api/* is proxied to the live origin
// so the page renders real roster/scenario data without being published first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [dir, port = '8899', origin] = process.argv.slice(2);
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (origin && path.startsWith('/api/')) {
    try {
      const upstream = await fetch(origin + req.url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? '', authorization: req.headers.authorization ?? '' },
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
