// Storage for the whole event state (one JSON document + a version counter).
//
//  - On Netlify (no setup): Netlify Blobs, with etag compare-and-set.
//
//  - On Vercel with Upstash Redis connected (Vercel Marketplace -> Upstash):
//    uses the Redis REST API. Writes are compare-and-set on the version, so two
//    laptops pressing buttons at the same moment never overwrite each other.
//  - Locally (npm start): a JSON file in ./data, so a restart keeps everything.
//  - On Vercel WITHOUT Redis: in-memory only. Each serverless instance has its
//    own copy, so the master page shows a warning. Connect Redis before the event.
import fs from 'node:fs';
import path from 'node:path';

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'blackout:state';
const VER = 'blackout:ver';

// Netlify without Redis: Netlify Blobs (built in, no keys to set up).
// Vercel without Redis: memory only, the disk there is read-only.
const ON_NETLIFY = !process.env.VERCEL && !!(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.BLOBS_TEST_URL);
export const storageKind = R_URL && R_TOKEN ? 'redis' : ON_NETLIFY ? 'blobs' : process.env.VERCEL ? 'memory' : 'file';

// ---------- Netlify Blobs ----------
// One store; the event state is written only if its etag is unchanged (same idea as the Redis version).
let blobStore = null;
async function blobs() {
  if (blobStore) return blobStore;
  const { getStore } = await import('@netlify/blobs');
  const test = process.env.BLOBS_TEST_URL; // local testing against @netlify/blobs/server
  blobStore = getStore(test
    ? { name: 'blackout', edgeURL: test, uncachedEdgeURL: test, siteID: 'test', token: 'test', consistency: 'strong' }
    : { name: 'blackout', consistency: 'strong' });
  return blobStore;
}

// ---------- Redis (Upstash REST) ----------
const CAS = `if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2]); return redis.call('INCR', KEYS[2])
else return -1 end`;

async function redis(cmd) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

// ---------- file / memory ----------
const FILE = process.env.BLACKOUT_DATA || path.join(process.cwd(), 'data', 'state.json');
let mem = null;
let memVer = 0;

function fileLoad() {
  if (mem !== null || storageKind !== 'file') return;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    mem = j.data;
    memVer = j.ver || 0;
  } catch {
    mem = null;
  }
}

function fileSave() {
  if (storageKind !== 'file') return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify({ ver: memVer, data: mem }));
  fs.renameSync(FILE + '.tmp', FILE);
}

// ---------- public API ----------
export async function load() {
  if (storageKind === 'blobs') {
    const r = await (await blobs()).getWithMetadata('state', { type: 'json' });
    // 'any' only if the service ever answers without an etag: then write without the check rather than stall
    return { data: r?.data ?? null, ver: r ? r.etag || 'any' : 'new' };
  }
  if (storageKind === 'redis') {
    const [raw, ver] = await redis(['MGET', KEY, VER]);
    return { data: raw ? JSON.parse(raw) : null, ver: String(ver || '0') };
  }
  fileLoad();
  return { data: mem ? structuredClone(mem) : null, ver: String(memVer) };
}

// Returns true if saved, false if someone else saved first (caller retries).
export async function save(data, ver) {
  if (storageKind === 'blobs') {
    const st = await blobs();
    if (ver === 'any') { await st.setJSON('state', data); return true; }
    const r = await st.setJSON('state', data, ver === 'new' ? { onlyIfNew: true } : { onlyIfMatch: ver });
    return !!r?.modified;
  }
  if (storageKind === 'redis') {
    const r = await redis(['EVAL', CAS, '2', KEY, VER, ver, JSON.stringify(data)]);
    return r !== -1;
  }
  if (String(memVer) !== ver) return false;
  mem = structuredClone(data);
  memVer++;
  fileSave();
  return true;
}

// ---------- live board data from the Mac bridge (kept apart from the event state) ----------
// The bridge (bridge.mjs, on the Mac that is on the PuzzleBox hotspot) pushes every
// board's /api/state here twice a second, and picks up commands the pages queue
// (start grid, arm the room clock, new Morse code...). Nothing here changes scores.
const BOARDS = 'blackout:boards';
const CMDS = 'blackout:cmds';
const RES = 'blackout:res:';
const TAKE = `local v = redis.call('LRANGE', KEYS[1], 0, -1); redis.call('DEL', KEYS[1]); return v`;
let memBoards = null;
let memCmds = [];
const memRes = new Map();

export async function putBoards(obj) {
  if (storageKind === 'blobs') return (await blobs()).setJSON('boards', obj);
  if (storageKind === 'redis') return redis(['SET', BOARDS, JSON.stringify(obj), 'EX', '60']);
  memBoards = obj;
}

export async function getBoards() {
  if (storageKind === 'blobs') return (await blobs()).get('boards', { type: 'json' });
  if (storageKind === 'redis') {
    const raw = await redis(['GET', BOARDS]);
    return raw ? JSON.parse(raw) : null;
  }
  return memBoards;
}

export async function pushCmd(cmd) {
  if (storageKind === 'blobs') return (await blobs()).setJSON(`cmd/${cmd.t}-${cmd.id}`, cmd);
  if (storageKind === 'redis') {
    await redis(['RPUSH', CMDS, JSON.stringify(cmd)]);
    return redis(['EXPIRE', CMDS, '60']);
  }
  memCmds.push(cmd);
}

export async function takeCmds() {
  if (storageKind === 'blobs') {
    const st = await blobs();
    const { blobs: list } = await st.list({ prefix: 'cmd/' });
    const out = [];
    for (const b of list.sort((x, y) => x.key.localeCompare(y.key))) {
      const c = await st.get(b.key, { type: 'json' });
      await st.delete(b.key); // only keys listed here, so a command added meanwhile waits for the next round
      if (c) out.push(c);
    }
    return out;
  }
  if (storageKind === 'redis') return ((await redis(['EVAL', TAKE, '1', CMDS])) || []).map((x) => JSON.parse(x));
  const out = memCmds;
  memCmds = [];
  return out;
}

export async function putResult(res) {
  if (storageKind === 'blobs') return (await blobs()).setJSON(`res/${res.id}`, res);
  if (storageKind === 'redis') return redis(['SET', RES + res.id, JSON.stringify(res), 'EX', '60']);
  memRes.set(res.id, res);
  setTimeout(() => memRes.delete(res.id), 60e3).unref?.();
}

export async function getResult(id) {
  if (storageKind === 'blobs') {
    const st = await blobs();
    const r = await st.get(`res/${id}`, { type: 'json' });
    if (r) await st.delete(`res/${id}`); // one page waits for each command; tidy up once it has the answer
    return r;
  }
  if (storageKind === 'redis') {
    const raw = await redis(['GET', RES + id]);
    return raw ? JSON.parse(raw) : null;
  }
  return memRes.get(id) || null;
}
