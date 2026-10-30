// Netlify version of the API: every /api/* request lands here and goes to the
// same handler the Vercel functions (api/*.js) and the offline server use.
import { handle } from '../../lib/core.js';

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const r = await handle(route, {
    method: req.method,
    query: Object.fromEntries(url.searchParams),
    body,
    headers: Object.fromEntries(req.headers),
  });
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/api/*' };
