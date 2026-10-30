import { handle } from '../lib/core.js';

export default async function handler(req, res) {
  const r = await handle('state', req);
  res.setHeader('Cache-Control', 'no-store');
  res.status(r.status).json(r.body);
}
