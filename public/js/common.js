// Shared helpers for every page: API client, login token, device polling, formatting.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TREFOIL = `<svg class="trefoil" viewBox="0 0 40 40" aria-hidden="true">
  <circle cx="20" cy="20" r="19" fill="#F2C230" stroke="#1B1B1B" stroke-width="2"/>
  <g fill="#1B1B1B"><circle cx="20" cy="20" r="3.2"/>
  <path d="M20 20 L13.1 8.05 A13.8 13.8 0 0 1 26.9 8.05 Z"/>
  <path d="M20 20 L13.1 8.05 A13.8 13.8 0 0 1 26.9 8.05 Z" transform="rotate(120 20 20)"/>
  <path d="M20 20 L13.1 8.05 A13.8 13.8 0 0 1 26.9 8.05 Z" transform="rotate(240 20 20)"/></g>
  <circle cx="20" cy="20" r="5.5" fill="none" stroke="#F2C230" stroke-width="2.2"/></svg>`;

export const ROLE_NAMES = {
  st1: 'Station 1 · Dead Signal',
  st2: 'Station 2 · Failing Instrument',
  st4: 'Station 4 · Shutdown Interlock',
  st56: 'Station 5 + 6 · Grid & AZ-5',
  master: 'Master control',
};

// ---------- storage (wrapped: private windows can throw) ----------
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export const auth = {
  get token() { return ls.get('bo.token'); },
  get role() { return ls.get('bo.role'); },
  save(token, role) { ls.set('bo.token', token); ls.set('bo.role', role); },
  clear() { ls.del('bo.token'); ls.del('bo.role'); },
};

// Send the user to the login page unless they hold one of the allowed roles.
export function requireRole(allowed) {
  const r = auth.role;
  if (!auth.token || !allowed.includes(r)) {
    location.href = '/login' + (allowed.length === 1 ? `?role=${allowed[0]}` : '');
    throw new Error('redirecting to login');
  }
  return r;
}

export function logout() {
  auth.clear();
  location.href = '/login';
}

// ---------- API ----------
async function call(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const r = await fetch(path, { ...opts, headers, cache: 'no-store' });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export const api = {
  state: async () => {
    const s = await call('/api/state');
    if (s.settings) link.settings = s.settings; // devGet needs the board list and link mode
    return s;
  },
  act: (action, payload = {}) => call('/api/action', { method: 'POST', body: JSON.stringify({ action, ...payload }) }),
};

// Server clock offset so every laptop shows the same timer.
let skew = 0;
export function syncClock(serverNow) {
  if (serverNow) skew = serverNow - Date.now();
}
export const now = () => Date.now() + skew;

// ---------- formatting ----------
export function fmtClock(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const t = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return neg ? '-' + t : t;
}

export function elapsedMs(rec, t = now()) {
  if (!rec?.startedAt) return 0;
  const end = rec.endedAt || rec.pausedAt || t;
  return Math.max(0, end - rec.startedAt - rec.pausedMs);
}

// Time left on the team's whole-room clock (same maths as the server).
export function runLeftMs(team, settings, t = now()) {
  const r = team?.run;
  const limit = settings.runLimit * 1000;
  if (!r?.startedAt) return limit;
  const end = r.endedAt || r.pausedAt || t;
  return limit - Math.max(0, end - r.startedAt - r.pausedMs);
}

export const STATUS_TEXT = {
  waiting: 'Waiting',
  playing: 'Playing',
  paused: 'Paused',
  found: 'Task done · code not entered',
  solved: 'Solved',
  skipped: 'Skipped',
  failed: 'Attempts used',
  forced: 'Opened by coordinator',
};

export function shownStatus(rec) {
  if (!rec) return 'waiting';
  if (rec.status === 'playing' && rec.pausedAt) return 'paused';
  return rec.status;
}

let toastTimer;
export function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

// Run an API action with a toast on error. Returns the result or null.
export async function run(action, payload, okMsg) {
  try {
    const r = await api.act(action, payload);
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

// ---------- theme ----------
export function initTheme() {
  const t = ls.get('bo.theme');
  if (t) document.documentElement.dataset.theme = t;
}
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  ls.set('bo.theme', next);
}

// ---------- ESP32 boards on the hotspot ----------
// Boards speak plain http on the local network. From an https page (Vercel),
// Chrome allows this only with the Local Network Access permission (the
// targetAddressSpace hint below) or with "Insecure content: Allow" in site settings.
export function devUrl(dev, path) {
  const port = Number(dev.port) && Number(dev.port) !== 80 ? ':' + dev.port : '';
  return `http://${dev.ip}${port}${path}`;
}

// Chrome rejects the request if this hint does not match the real address, so derive it from the IP.
function addressSpace(ip) {
  if (/^(127\.|localhost$|\[?::1\]?$)/.test(ip)) return 'loopback';
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip.endsWith('.local')) return 'local';
  return undefined;
}

// ---------- boards: through the Mac bridge, or direct on the same Wi-Fi ----------
// 'bridge' (default): bridge.mjs on the Mac reads the boards and relays them through
// the site, so laptops only need internet. 'direct': each laptop calls the board IP.
const link = { settings: null, snap: null, at: 0, inflight: null };
export const viaBridge = () => (link.settings?.boardLink || 'bridge') === 'bridge';

function boardKey(dev) {
  const ds = link.settings?.devices || {};
  return Object.keys(ds).find((k) => ds[k] === dev || (ds[k].ip === dev.ip && Number(ds[k].port) === Number(dev.port)));
}

// Latest readings of every board as relayed by the bridge (shared by all callers for 400 ms).
export async function bridgeSnapshot() {
  if (link.snap && Date.now() - link.at < 400) return link.snap;
  if (!link.inflight) {
    link.inflight = call('/api/boards')
      .then((j) => { link.snap = j; link.at = Date.now(); return j; })
      .finally(() => { link.inflight = null; });
  }
  return link.inflight;
}
export const bridgeAlive = (snap) => !!snap?.at && snap.now - snap.at < 8000;

async function bridgeGet(dev, path, timeoutMs) {
  const k = boardKey(dev);
  if (!k) throw new Error('unknown board');
  if (path === '/api/state' || path.startsWith('/api/answer')) {
    const snap = await bridgeSnapshot();
    if (!bridgeAlive(snap)) throw new Error('Mac bridge not running');
    const b = snap.boards?.[k];
    if (!b) throw new Error('no reading yet');
    if (!b.ok) throw new Error(b.err || 'offline');
    if (path === '/api/state') return b.data;
    if (!b.answer) throw new Error('answer not available');
    return b.answer;
  }
  // Anything else is a command: queue it for the bridge and wait for the board's reply.
  const { id } = await api.act('boardCmd', { dev: k, path });
  const until = Date.now() + Math.max(timeoutMs, 8000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    const r = await api.act('cmdResult', { id });
    if (r.done) {
      if (!r.ok) throw new Error(r.err || 'board error');
      return r.data;
    }
  }
  throw new Error('Mac bridge did not answer');
}

export async function devGet(dev, path, timeoutMs = 1500) {
  if (viaBridge()) return bridgeGet(dev, path, timeoutMs);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const opts = { signal: ctl.signal, cache: 'no-store' };
  const space = addressSpace(String(dev.ip));
  if (space) opts.targetAddressSpace = space;
  try {
    const r = await fetch(devUrl(dev, path), opts);
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timer);
  }
}

export const httpsBlockNote = () => viaBridge()
  ? `Boards are read by the Mac bridge. On the Mac (joined to PuzzleBox) run <code>npm run bridge -- ${esc(location.origin)}</code>,
     and check the board's IP on the master Devices page.`
  : location.protocol === 'https:'
  ? `This page is on https, so the browser may block it from talking to the board on <code>http://</code>.
     In Chrome, allow <b>Local network access</b> when asked, or open site settings (padlock icon) →
     <b>Insecure content → Allow</b>, then reload. Or run the offline server (<code>npm start</code>) on this laptop.`
  : 'Check the board is powered, on the same hotspot, and that its IP on the master Devices page is right.';

// Top bar used by station and master pages.
export function topbar(title, subtitle, extra = '') {
  return `<header class="topbar">
    <a class="brand" href="/">${TREFOIL}<div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div></a>
    <div class="top-actions">${extra}
      <span class="readout" id="clock">--:--:--</span>
      <button class="btn btn-ghost btn-sm" id="themeBtn" type="button">Day / night</button>
      <button class="btn btn-ghost btn-sm" id="logoutBtn" type="button">Log out</button>
    </div></header>`;
}

export function wireTopbar() {
  $('#themeBtn')?.addEventListener('click', toggleTheme);
  $('#logoutBtn')?.addEventListener('click', logout);
  const tick = () => {
    const el = $('#clock');
    if (el) el.textContent = new Date(now()).toLocaleTimeString([], { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}
