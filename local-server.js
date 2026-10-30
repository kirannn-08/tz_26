// Offline server: same pages and API as Vercel, no internet needed.
//   npm start            -> http://localhost:3000
// Other laptops on the hotspot open http://<this-laptop-ip>:3000
// Data is saved in ./data/state.json.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/core.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    const route = url.pathname.slice(5).replace(/\/$/, '');
    let body = '';
    for await (const chunk of req) body += chunk;
    const r = await handle(route, {
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers,
    });
    return send(res, r.status, 'application/json', JSON.stringify(r.body));
  }

  // static files, with clean URLs (/master -> master.html)
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) return send(res, 403, 'text/plain', 'Forbidden');
  if (!path.extname(file)) file += '.html';
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBlackout control room running (offline mode)\n`);
  console.log(`  This laptop : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Hotspot/LAN : http://${a.address}:${PORT}`);
    }
  }
  console.log('');
});
