// Mac bridge: the only computer that needs to be on the PuzzleBox hotspot.
// It reads every ESP32 board twice a second and relays the readings to the site,
// and carries the pages' board commands (start grid, arm room clock, new Morse
// code, silence...) back to the boards. The boards and their firmware are unchanged.
//
//   npm run bridge -- https://your-site.vercel.app      (or http://localhost:3000)
//
// Asks for the master password once (or set MASTER_PASSWORD=... before the command).
// Board IPs come from the master Devices page, so change them there, not here.
import readline from 'node:readline/promises';

const SITE = (process.argv[2] || process.env.BLACKOUT_SITE || 'http://localhost:3000').replace(/\/$/, '');
const EVERY_MS = 500;      // how often boards are read and the site is updated
const BOARD_TIMEOUT = 1200; // a board slower than this counts as offline for that round
const CMD_MAX_AGE = 15000;  // commands older than this are dropped (e.g. queued while the bridge was off)

let password = process.env.MASTER_PASSWORD || '';
let token = '';
let devices = {};
let deviceKey = '';
let lastSettings = 0;
let results = [];
const lastSeen = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString([], { hour12: false });

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

async function site(path, body) {
  const r = await fetch(SITE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

async function login() {
  for (;;) {
    if (!password) password = await ask('Master password: ');
    try {
      token = (await site('/api/action', { action: 'login', role: 'master', password })).token;
      console.log(`${stamp()}  logged in to ${SITE}`);
      return;
    } catch (e) {
      console.log(`${stamp()}  login failed: ${e.message}`);
      if (e.status === 401) password = '';
      else await sleep(3000);
    }
  }
}

function boardUrl(d, path) {
  const port = Number(d.port) && Number(d.port) !== 80 ? ':' + d.port : '';
  return `http://${d.ip}${port}${path}`;
}

async function boardGet(d, path, timeout = BOARD_TIMEOUT) {
  const r = await fetch(boardUrl(d, path), { signal: AbortSignal.timeout(timeout) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`.trim());
  try { return JSON.parse(text); } catch { return text; }
}

const why = (e) => (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message);

// One reading of every enabled board. Level 1 also sends its current code (master only).
async function readBoards() {
  const out = {};
  await Promise.all(Object.entries(devices).map(async ([k, d]) => {
    if (!d.enabled) return;
    try {
      const data = await boardGet(d, '/api/state');
      out[k] = { ok: true, data, at: Date.now() };
      if (k === 'st1') {
        try { out[k].answer = await boardGet(d, `/api/answer?key=${encodeURIComponent(deviceKey)}`); } catch {}
      }
      lastSeen[k] = Date.now();
    } catch (e) {
      out[k] = { ok: false, err: why(e), at: lastSeen[k] || 0 };
    }
  }));
  return out;
}

async function runCmd(c) {
  const d = devices[c.dev];
  if (!d) return { id: c.id, ok: false, err: 'unknown board' };
  if (Date.now() - c.t > CMD_MAX_AGE) return { id: c.id, ok: false, err: 'expired' };
  try {
    const data = await boardGet(d, c.path, 3000);
    console.log(`${stamp()}  ${c.dev} ${c.path.replace(/key=[^&]*/, 'key=…')}  OK`);
    return { id: c.id, ok: true, data };
  } catch (e) {
    console.log(`${stamp()}  ${c.dev} ${c.path.replace(/key=[^&]*/, 'key=…')}  FAILED ${why(e)}`);
    return { id: c.id, ok: false, err: why(e) };
  }
}

let lastLine = 0;
function statusLine(boards, ok) {
  if (Date.now() - lastLine < 5000) return;
  lastLine = Date.now();
  const parts = Object.entries(devices).filter(([, d]) => d.enabled)
    .map(([k, d]) => `${k} ${boards[k]?.ok ? 'OK' : 'OFF(' + (boards[k]?.err || '?') + ')'} ${d.ip}`);
  console.log(`${stamp()}  site ${ok ? 'OK' : 'unreachable'} · ${parts.join(' · ') || 'no boards enabled'}`);
}

async function main() {
  console.log(`\nBlackout bridge → ${SITE}\nKeep this window open during the event. Ctrl+C stops it.\n`);
  await login();
  let boards = {};
  for (;;) {
    const t0 = Date.now();
    let ok = false;
    try {
      const want = Date.now() - lastSettings > 5000;
      const r = await site('/api/bridge', { boards, results, want });
      results = [];
      ok = true;
      if (r.devices) { devices = r.devices; deviceKey = r.deviceKey || ''; lastSettings = Date.now(); }
      if (r.cmds?.length) results = await Promise.all(r.cmds.map(runCmd));
    } catch (e) {
      if (e.status === 401 || e.status === 403) await login();
      else console.log(`${stamp()}  site error: ${why(e)}`);
    }
    boards = await readBoards();
    statusLine(boards, ok);
    if (!results.length) await sleep(Math.max(0, EVERY_MS - (Date.now() - t0)));
  }
}

main();
