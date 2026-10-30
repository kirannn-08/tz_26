// Event state, scoring, logins and every action the pages can take.
// Shared by the Vercel functions (api/*.js) and the offline server (local-server.js).
import crypto from 'node:crypto';
import { load, save, storageKind, putBoards, getBoards, pushCmd, takeCmds, putResult, getResult } from './store.js';

export const LEVELS = [1, 2, 3, 4, 5, 6];

// Which levels each login controls. Level 3 is a paper station run from master.
export const ROLES = {
  st1: [1],
  st2: [2],
  st4: [4],
  st56: [5, 6],
  master: LEVELS,
};

// Token signing key: SESSION_SECRET if set, otherwise a random key created once and kept in storage.
let SECRET = process.env.SESSION_SECRET || null;
const TOKEN_HOURS = 24;
const LOG_MAX = 300;

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---------- defaults ----------
export function defaults() {
  return {
    settings: {
      masterPassword: process.env.MASTER_PASSWORD || 'blackout-master',
      passwords: { st1: 'station1', st2: 'station2', st4: 'station4', st56: 'station56' },
      deviceKey: 'admin', // must match KEY in lfc.ino and DEVICE_KEY in the firmware/ sketches
      registrationOpen: true,
      runLimit: 420, // seconds for the WHOLE room (7 min). The siren sounds if it runs out.
      limits: { 1: 300, 2: 420, 3: 420, 4: 300, 5: 300, 6: 300 }, // old per-level limits (no longer used)
      // bonus = finish bonus, scaled by the time left when AZ-5 is pressed
      scoring: { base: 100, bonus: 120, wrong: 10, wrongSecs: 60, hint: 15, timeOver: 50, maxAttempts: 3 },
      // '' = take the code from the board (L1: current Morse code, L5: code the board showed)
      answers: { 1: '', 2: 'ALPHA-7392-ZETA', 3: '204', 4: '302', 5: '', 6: '' },
      // Windows Mobile Hotspot hands out 192.168.137.x; change these on the Devices page.
      devices: {
        st1: { ip: '192.168.137.101', port: 80, enabled: true },
        st2: { ip: '192.168.137.102', port: 80, enabled: false }, // Level 2 is code entry only
        st4: { ip: '192.168.137.104', port: 80, enabled: true },
        st56: { ip: '192.168.137.105', port: 80, enabled: true },
      },
      // 'bridge': laptops get board data through the site, from bridge.mjs on the Mac (Vercel setup).
      // 'direct': each laptop talks to the boards itself (all laptops on the PuzzleBox hotspot).
      boardLink: 'bridge',
      paused: false,
    },
    teams: [],
    active: null, // one team plays at a time; every station follows this team
    seat: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null }, // team id at each level
    nextNo: 1,
    log: [],
  };
}

function freshRun() {
  return { startedAt: 0, pausedAt: 0, pausedMs: 0, endedAt: 0, result: '' }; // result: '' | finished | timeout
}

function freshLevel() {
  return { status: 'waiting', startedAt: 0, pausedAt: 0, pausedMs: 0, endedAt: 0, attempts: 0, hints: 0 };
}

// Fill in anything missing (older saved data, restored backups).
function normalize(s) {
  const d = defaults();
  if (!s || typeof s !== 'object') return d;
  const out = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
  for (const k of ['passwords', 'limits', 'scoring', 'answers', 'devices']) {
    out.settings[k] = { ...d.settings[k], ...(s.settings?.[k] || {}) };
  }
  out.seat = { ...d.seat, ...(s.seat || {}) };
  out.teams = (s.teams || []).map((t) => {
    const levels = {};
    for (const l of LEVELS) levels[l] = { ...freshLevel(), ...(t.levels?.[l] || {}) };
    return { ...t, levels, run: { ...freshRun(), ...(t.run || {}) } };
  });
  return out;
}

// ---------- timing & scoring ----------
export function elapsedMs(rec, now) {
  if (!rec.startedAt) return 0;
  const end = rec.endedAt || rec.pausedAt || now;
  return Math.max(0, end - rec.startedAt - rec.pausedMs);
}

// Time left on the whole-room clock.
export function runLeftMs(team, settings, now) {
  const r = team.run;
  const limit = settings.runLimit * 1000;
  if (!r.startedAt) return limit;
  const end = r.endedAt || r.pausedAt || now;
  return limit - Math.max(0, end - r.startedAt - r.pausedMs);
}
const runLive = (t) => !!t.run.startedAt && !t.run.endedAt;

export function levelPoints(rec, level, settings) {
  const sc = settings.scoring;
  const penalty = rec.attempts * sc.wrong + rec.hints * sc.hint;
  if (rec.status === 'skipped') return 0;
  if (rec.status === 'forced') return sc.base - sc.timeOver - penalty;
  if (rec.status === 'solved') return sc.base - penalty;
  return -penalty; // unsolved: penalties still count
}

function teamTotals(t, settings, now) {
  const sc = settings.scoring;
  const limit = settings.runLimit * 1000;
  let points = 0;
  let attempts = 0;
  for (const l of LEVELS) {
    points += levelPoints(t.levels[l], l, settings);
    attempts += t.levels[l].attempts;
  }
  const leftMs = runLeftMs(t, settings, now);
  const bonus = t.run.result === 'finished' ? Math.round(sc.bonus * Math.max(0, leftMs) / limit) : 0;
  const usedMs = t.run.startedAt ? Math.min(limit, limit - leftMs) : 0;
  return {
    points: points + bonus,
    bonus,
    timeMs: usedMs + attempts * sc.wrongSecs * 1000, // ranking tiebreak
    usedMs,
    leftMs,
    finished: t.run.result === 'finished',
    timeout: t.run.result === 'timeout',
  };
}

function pauseRun(t, now, on) {
  const r = t.run;
  if (!runLive(t)) return;
  if (on && !r.pausedAt) r.pausedAt = now;
  if (!on && r.pausedAt) { r.pausedMs += now - r.pausedAt; r.pausedAt = 0; }
}

// ---------- auth ----------
function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

function makeToken(role) {
  const body = Buffer.from(JSON.stringify({ r: role, e: Date.now() + TOKEN_HOURS * 3600e3 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readToken(headers = {}) {
  const h = headers.authorization || headers.Authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { r, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return e > Date.now() && ROLES[r] ? r : null;
  } catch {
    return null;
  }
}

function canLevel(role, level) {
  return !!role && ROLES[role]?.includes(Number(level));
}

// ---------- read-modify-write with retry ----------
async function transact(fn) {
  for (let i = 0; i < 8; i++) {
    const { data, ver } = await load();
    const state = normalize(data);
    const result = fn(state, Date.now());
    if (result?.noSave) return result;
    if (await save(state, ver)) return result;
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
  }
  fail(503, 'Busy, try again');
}

function log(state, now, msg, level = null) {
  state.log.unshift({ t: now, msg, level });
  if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
}

function cleanText(v, max = 60) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanMembers(list) {
  const m = (Array.isArray(list) ? list : []).map((x) => cleanText(x, 40)).filter(Boolean);
  if (m.length < 2 || m.length > 4) fail(400, 'A team needs 2 to 4 members');
  return m;
}

function findTeam(state, id) {
  return state.teams.find((t) => t.id === id) || fail(404, 'Team not found');
}

function seated(state, level) {
  const id = state.seat[level];
  if (!id) fail(400, `No team assigned to Level ${level}`);
  return findTeam(state, id);
}

function newTeam(state, p, now, source) {
  const name = cleanText(p.name, 40);
  if (!name) fail(400, 'Team name is required');
  if (state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) fail(409, 'That team name is taken');
  const t = {
    id: crypto.randomUUID().slice(0, 8),
    no: state.nextNo++,
    name,
    members: cleanMembers(p.members),
    contact: cleanText(p.contact, 60),
    college: cleanText(p.college, 60),
    createdAt: now,
    levels: Object.fromEntries(LEVELS.map((l) => [l, freshLevel()])),
    run: freshRun(),
  };
  state.teams.push(t);
  log(state, now, `Team #${t.no} ${t.name} registered (${source})`);
  return t;
}

// Stop the clock on a level: freeze at the pause point if paused.
function endLevel(rec, now) {
  if (!rec.startedAt) rec.startedAt = now;
  rec.endedAt = rec.pausedAt || now;
  rec.pausedAt = 0;
}

const DONE = ['solved', 'forced', 'skipped'];

function startLevel(state, team, level, now, how) {
  if (team.run.endedAt) fail(400, "This team's run is over. Reset the team to play again.");
  if (!team.run.startedAt) {
    team.run.startedAt = now;
    if (state.settings.paused) { team.run.pausedAt = now; team.run.globalPause = true; }
    log(state, now, `${team.name}: ROOM CLOCK STARTED (${Math.round(state.settings.runLimit / 60)} min)`);
  }
  const rec = team.levels[level];
  if (!rec.startedAt) rec.startedAt = now;
  if (rec.pausedAt) {
    rec.pausedMs += now - rec.pausedAt;
    rec.pausedAt = 0;
  }
  rec.status = 'playing';
  if (state.settings.paused) {
    rec.pausedAt = now;
    rec.globalPause = true;
  }
  log(state, now, `L${level}: ${team.name} timer started (${how})`, level);
}

// One team at a time: when a level is finished, the next level's timer starts.
function advance(state, team, level, now) {
  const next = level + 1;
  if (next > 6 || team.run.endedAt) return;
  state.seat[next] = state.seat[next] || team.id;
  if (state.seat[next] === team.id && team.levels[next].status === 'waiting') startLevel(state, team, next, now, 'auto');
}

function markSolved(state, team, level, now, how) {
  const rec = team.levels[level];
  if (DONE.includes(rec.status)) return false;
  const wasFound = rec.status === 'found';
  rec.status = 'solved';
  if (!rec.endedAt) endLevel(rec, now); // keep the time the task was actually finished
  log(state, now, `L${level}: ${team.name} SOLVED (${how})`, level);
  if (level === 6 && runLive(team)) {
    team.run.endedAt = team.run.pausedAt || now;
    team.run.pausedAt = 0;
    team.run.result = 'finished';
    log(state, now, `${team.name}: FINISHED with ${Math.round(runLeftMs(team, state.settings, now) / 1000)} s left`);
  }
  if (!wasFound) advance(state, team, level, now);
  return true;
}

function addWrong(state, team, level, now, how) {
  const rec = team.levels[level];
  if (!['playing', 'waiting', 'found'].includes(rec.status)) return false;
  const max = state.settings.scoring.maxAttempts;
  if (rec.attempts >= max) return false;
  rec.attempts++;
  log(state, now, `L${level}: ${team.name} wrong attempt ${rec.attempts}/${max} (${how})`, level);
  if (rec.attempts >= max) {
    rec.status = 'failed';
    if (!rec.endedAt) endLevel(rec, now);
    log(state, now, `L${level}: ${team.name} used all attempts`, level);
  }
  return true;
}

// Codes are compared without spaces, dashes or case: "alpha 7392 zeta" = "ALPHA-7392-ZETA".
const codeKey = (v) => cleanText(v, 40).toLowerCase().replace(/[\s-]/g, '');

// ---------- actions ----------
const LEVEL_ACTIONS = {
  seat(state, p, now) {
    const id = p.teamId || null;
    if (id) findTeam(state, id);
    state.seat[p.level] = id;
    const t = id && findTeam(state, id);
    log(state, now, `L${p.level}: ${t ? t.name + ' assigned' : 'station cleared'}`, p.level);
  },
  start(state, p, now) {
    const t = seated(state, p.level);
    const rec = t.levels[p.level];
    if (DONE.includes(rec.status)) fail(400, 'Level already finished; reset it first');
    if (rec.status === 'found') fail(400, 'Task is done; waiting for the team to enter the code');
    if (rec.status === 'playing' && !rec.pausedAt) return;
    startLevel(state, t, p.level, now, 'coordinator');
  },
  pause(state, p, now) {
    const t = seated(state, p.level);
    const rec = t.levels[p.level];
    if (rec.status !== 'playing') fail(400, 'Timer is not running');
    if (rec.pausedAt) {
      rec.pausedMs += now - rec.pausedAt;
      rec.pausedAt = 0;
      pauseRun(t, now, false);
      log(state, now, `L${p.level}: ${t.name} resumed (room clock running)`, p.level);
    } else {
      rec.pausedAt = now;
      pauseRun(t, now, true);
      log(state, now, `L${p.level}: ${t.name} paused (room clock paused)`, p.level);
    }
  },
  wrong(state, p, now) {
    addWrong(state, seated(state, p.level), p.level, now, p.source || 'coordinator');
  },
  hint(state, p, now) {
    const t = seated(state, p.level);
    t.levels[p.level].hints++;
    log(state, now, `L${p.level}: ${t.name} took a hint`, p.level);
  },
  solve(state, p, now) {
    markSolved(state, seated(state, p.level), p.level, now, p.source || 'coordinator');
  },
  // Board says the task is done (bridge balanced, lamps lit, grid stable). The clock
  // stops and the next level starts, but points come only when the code is entered.
  found(state, p, now) {
    const t = seated(state, p.level);
    const rec = t.levels[p.level];
    if (p.code) rec.code = cleanText(p.code, 40);
    if (t.run.result === 'timeout') return;
    if (rec.status !== 'playing' && rec.status !== 'waiting') return;
    rec.status = 'found';
    endLevel(rec, now);
    log(state, now, `L${p.level}: ${t.name} finished the task (${p.source || 'coordinator'}); code not entered yet`, p.level);
    advance(state, t, p.level, now);
  },
  open(state, p, now) {
    // Time over / attempts used: coordinator opens the box so the team can continue.
    const t = seated(state, p.level);
    const rec = t.levels[p.level];
    if (DONE.includes(rec.status)) return;
    const wasFound = rec.status === 'found';
    rec.status = 'forced';
    if (!rec.endedAt) endLevel(rec, now);
    log(state, now, `L${p.level}: ${t.name} opened by coordinator (-${state.settings.scoring.timeOver})`, p.level);
    if (!wasFound) advance(state, t, p.level, now);
  },
  skip(state, p, now) {
    if (Number(p.level) !== 1) fail(400, 'Only Level 1 can be skipped');
    const t = seated(state, 1);
    const rec = t.levels[1];
    if (rec.status === 'solved') fail(400, 'Already solved');
    Object.assign(rec, freshLevel(), { status: 'skipped' });
    log(state, now, `L1: ${t.name} skipped Level 1`, 1);
    advance(state, t, 1, now);
  },
  reset(state, p, now) {
    const t = seated(state, p.level);
    t.levels[p.level] = freshLevel();
    log(state, now, `L${p.level}: ${t.name} level reset`, p.level);
  },
  // The team types the code they found. Correct = level solved (points). Wrong = attempt.
  answer(state, p, now) {
    const t = seated(state, p.level);
    const rec = t.levels[p.level];
    const max = state.settings.scoring.maxAttempts;
    if (DONE.includes(rec.status)) return { correct: true, already: true };
    if (t.run.result === 'timeout') fail(400, 'Time is up.');
    if (rec.status === 'failed') fail(400, 'All attempts are used. Ask the coordinator.');
    const want = codeKey(state.settings.answers[p.level]) || codeKey(rec.code) || codeKey(p.boardCode);
    if (!want) fail(400, 'The code for this level is not available. Ask the coordinator.');
    const got = codeKey(p.value);
    if (!got) fail(400, 'Type the code first');
    const correct = got === want;
    if (correct) markSolved(state, t, p.level, now, 'code entered');
    else addWrong(state, t, p.level, now, `entered "${cleanText(p.value, 20)}"`);
    return {
      correct,
      attemptsLeft: Math.max(0, max - rec.attempts),
      points: correct ? levelPoints(rec, p.level, state.settings) : undefined,
    };
  },
};

const MASTER_ACTIONS = {
  activate(state, p, now) {
    const id = p.teamId || null;
    const t = id ? findTeam(state, id) : null;
    const prev = state.teams.find((x) => x.id === state.active);
    if (prev && prev !== t) {
      for (const l of LEVELS) {
        const r = prev.levels[l];
        if (r.status === 'playing' && !r.pausedAt) r.pausedAt = now;
      }
    }
    state.active = id;
    for (const l of LEVELS) state.seat[l] = id;
    log(state, now, t ? `Team #${t.no} ${t.name} is now playing` : 'No team playing');
  },
  teamAdd(state, p, now) {
    return { team: newTeam(state, p, now, 'master') };
  },
  teamEdit(state, p, now) {
    const t = findTeam(state, p.id);
    if (p.name !== undefined) {
      const name = cleanText(p.name, 40);
      if (!name) fail(400, 'Team name is required');
      if (state.teams.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) fail(409, 'That team name is taken');
      t.name = name;
    }
    if (p.members !== undefined) t.members = cleanMembers(p.members);
    if (p.contact !== undefined) t.contact = cleanText(p.contact, 60);
    if (p.college !== undefined) t.college = cleanText(p.college, 60);
    log(state, now, `Team #${t.no} ${t.name} edited`);
  },
  teamDelete(state, p, now) {
    const t = findTeam(state, p.id);
    state.teams = state.teams.filter((x) => x !== t);
    for (const l of LEVELS) if (state.seat[l] === t.id) state.seat[l] = null;
    if (state.active === t.id) state.active = null;
    log(state, now, `Team #${t.no} ${t.name} removed`);
  },
  teamResetAll(state, p, now) {
    const t = findTeam(state, p.id);
    for (const l of LEVELS) t.levels[l] = freshLevel();
    t.run = freshRun();
    log(state, now, `Team #${t.no} ${t.name}: all levels and the room clock reset`);
  },
  settings(state, p, now) {
    const s = state.settings;
    const patch = p.patch || {};
    if (typeof patch.registrationOpen === 'boolean') s.registrationOpen = patch.registrationOpen;
    if (patch.deviceKey !== undefined) s.deviceKey = cleanText(patch.deviceKey, 32) || s.deviceKey;
    if (['bridge', 'direct'].includes(patch.boardLink)) s.boardLink = patch.boardLink;
    if (patch.masterPassword) s.masterPassword = cleanText(patch.masterPassword, 64);
    for (const [k, v] of Object.entries(patch.passwords || {})) if (s.passwords[k] !== undefined && v) s.passwords[k] = cleanText(v, 64);
    if (patch.runLimit !== undefined) s.runLimit = Math.max(60, Math.round(Number(patch.runLimit)) || s.runLimit);
    for (const [k, v] of Object.entries(patch.limits || {})) if (s.limits[k] !== undefined) s.limits[k] = Math.max(30, Number(v) || s.limits[k]);
    for (const [k, v] of Object.entries(patch.scoring || {})) if (s.scoring[k] !== undefined) s.scoring[k] = Math.max(0, Number(v) || 0);
    for (const [k, v] of Object.entries(patch.answers || {})) if (s.answers[k] !== undefined) s.answers[k] = cleanText(v, 40);
    for (const [k, v] of Object.entries(patch.devices || {})) {
      if (!s.devices[k]) continue;
      const d = s.devices[k];
      if (v.ip !== undefined) d.ip = cleanText(v.ip, 64).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (v.port !== undefined) d.port = Math.min(65535, Math.max(1, Number(v.port) || 80));
      if (v.enabled !== undefined) d.enabled = !!v.enabled;
    }
    log(state, now, 'Settings changed');
  },
  pauseAll(state, p, now) {
    const s = state.settings;
    s.paused = !s.paused;
    for (const t of state.teams) {
      if (s.paused && runLive(t) && !t.run.pausedAt) { t.run.pausedAt = now; t.run.globalPause = true; }
      else if (!s.paused && t.run.globalPause) { pauseRun(t, now, false); delete t.run.globalPause; }
      for (const l of LEVELS) {
        const rec = t.levels[l];
        if (rec.status !== 'playing') continue;
        if (s.paused && !rec.pausedAt) {
          rec.pausedAt = now;
          rec.globalPause = true;
        } else if (!s.paused && rec.globalPause) {
          rec.pausedMs += now - rec.pausedAt;
          rec.pausedAt = 0;
          delete rec.globalPause;
        }
      }
    }
    log(state, now, s.paused ? 'ALL TIMERS PAUSED' : 'All timers resumed');
  },
  restore(state, p, now) {
    const keepPw = state.settings.masterPassword;
    Object.assign(state, normalize(p.data));
    state.settings.masterPassword = keepPw;
    log(state, now, 'Data restored from backup');
  },
  eraseAll(state, p, now) {
    const keep = state.settings;
    Object.assign(state, defaults(), { settings: { ...keep, paused: false } });
    log(state, now, 'All teams and results erased (settings kept)');
  },
  note(state, p, now) {
    log(state, now, cleanText(p.text, 120), p.level ? Number(p.level) : null);
  },
};

// The room clock ran out (reported by the 5+6 board's own deadline, or by any page).
function timeUp(state, p, now) {
  const t = state.teams.find((x) => x.id === state.active);
  if (!t || !runLive(t)) return { already: true };
  const left = runLeftMs(t, state.settings, now);
  if (left > 2000 && p.source !== 'board') fail(400, 'Time is not up yet');
  t.run.endedAt = t.run.pausedAt || now;
  t.run.pausedAt = 0;
  t.run.result = 'timeout';
  for (const l of LEVELS) {
    const rec = t.levels[l];
    if (rec.status === 'playing') { rec.status = 'failed'; endLevel(rec, now); }
  }
  log(state, now, `${t.name}: TIME UP (siren)`);
  return {};
}

// ---------- views ----------
function view(state, role, now) {
  const s = state.settings;
  const base = { now, role, storage: storageKind };
  if (!role) {
    return { ...base, registrationOpen: s.registrationOpen, teamCount: state.teams.length };
  }
  const teams = state.teams.map((t) => ({
    ...t,
    levels: role === 'master' ? t.levels
      : Object.fromEntries(LEVELS.map((l) => { const { code, ...r } = t.levels[l]; return [l, r]; })),
    contact: role === 'master' ? t.contact : undefined,
    totals: teamTotals(t, s, now),
    points: Object.fromEntries(LEVELS.map((l) => [l, levelPoints(t.levels[l], l, s)])),
  }));
  const settings = {
    runLimit: s.runLimit,
    limits: s.limits,
    scoring: s.scoring,
    devices: s.devices,
    deviceKey: s.deviceKey,
    boardLink: s.boardLink,
    paused: s.paused,
    registrationOpen: s.registrationOpen,
  };
  if (role === 'master') {
    settings.answers = s.answers;
    settings.passwords = s.passwords;
    return { ...base, settings, teams, seat: state.seat, active: state.active, log: state.log, nextNo: state.nextNo };
  }
  const mine = ROLES[role];
  return { ...base, settings, teams, seat: state.seat, active: state.active, log: state.log.filter((e) => mine.includes(e.level)).slice(0, 30) };
}

async function ensureSecret() {
  if (SECRET) return;
  const { data } = await load();
  if (data?.secret) { SECRET = data.secret; return; }
  await transact((state) => {
    if (!state.secret) state.secret = crypto.randomBytes(32).toString('base64url');
    SECRET = state.secret;
  });
}

// ---------- HTTP entry point ----------
// req: { method, query, body, headers } -> { status, body }
export async function handle(route, req) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const query = req.query || {};
    await ensureSecret();
    const role = readToken(req.headers);

    if (route === 'state') {
      const { data } = await load();
      return ok(view(normalize(data), role, Date.now()));
    }

    // ----- Mac bridge -----
    // Pages read live board data here (the L1 answer and keypad log only for master).
    if (route === 'boards') {
      if (!role) fail(403, 'Login required');
      const b = (await getBoards()) || { at: 0, boards: {} };
      const boards = {};
      for (const [k, v] of Object.entries(b.boards || {})) {
        const { answer, ...rest } = v || {};
        boards[k] = role === 'master' ? v : rest;
      }
      return ok({ now: Date.now(), at: b.at || 0, boards });
    }
    // bridge.mjs pushes board readings and command results, and collects queued commands.
    if (route === 'bridge') {
      if (role !== 'master') fail(403, 'Master login required');
      if (body.boards) await putBoards({ at: Date.now(), boards: body.boards });
      for (const r of Array.isArray(body.results) ? body.results.slice(0, 50) : []) if (r?.id) await putResult(r);
      const cmds = await takeCmds();
      const out = { now: Date.now(), cmds };
      if (body.want) {
        const s = normalize((await load()).data).settings;
        Object.assign(out, { devices: s.devices, deviceKey: s.deviceKey, boardLink: s.boardLink });
      }
      return ok(out);
    }

    if (route === 'action') {
      const { action, ...p } = body;
      // A page asks the bridge to send one request to a board; stations only to their own board.
      if (action === 'boardCmd') {
        const dev = String(p.dev || '');
        if (!['st1', 'st2', 'st4', 'st56'].includes(dev) || !(role === 'master' || role === dev)) fail(403, 'Not allowed for this login');
        const path = String(p.path || '');
        if (!/^\/api\/[\w/]+(\?[\w=&%.\-]*)?$/.test(path)) fail(400, 'bad board path');
        const id = crypto.randomBytes(8).toString('hex');
        await pushCmd({ id, dev, path, t: Date.now() });
        return ok({ id });
      }
      if (action === 'cmdResult') {
        if (!role) fail(403, 'Login required');
        const r = await getResult(String(p.id || ''));
        return ok(r ? { done: true, ...r } : { done: false });
      }
      if (action === 'login') {
        const { data } = await load();
        const s = normalize(data).settings;
        const want = p.role === 'master' ? s.masterPassword : s.passwords[p.role];
        if (!want || String(p.password || '') !== want) fail(401, 'Wrong password');
        return ok({ token: makeToken(p.role), role: p.role });
      }
      if (action === 'register') {
        return ok(await transact((state, now) => {
          if (!state.settings.registrationOpen) fail(403, 'Registration is closed');
          const t = newTeam(state, p, now, 'self-registered');
          return { team: { no: t.no, name: t.name } };
        }));
      }
      if (action === 'timeUp') {
        if (!role) fail(403, 'Login required');
        return ok(await transact((state, now) => timeUp(state, p, now)));
      }
      if (LEVEL_ACTIONS[action]) {
        p.level = Number(p.level);
        if (action === 'answer' && (p.level === 1 || p.level === 5)) {
          const b = await getBoards();
          if (b && Date.now() - b.at < 10000) {
            const code = p.level === 1 ? b.boards?.st1?.answer?.code : b.boards?.st56?.data?.code;
            p.boardCode = code || '';
          }
        }
        // Any station may take a code for any level (late entry); other actions only for its own levels.
        const allowed = action === 'answer' ? !!role && LEVELS.includes(p.level) : canLevel(role, p.level);
        if (!allowed) fail(403, 'Not allowed for this login');
        return ok((await transact((state, now) => LEVEL_ACTIONS[action](state, p, now))) || {});
      }
      if (MASTER_ACTIONS[action]) {
        if (role !== 'master') fail(403, 'Master login required');
        return ok((await transact((state, now) => MASTER_ACTIONS[action](state, p, now))) || {});
      }
      fail(400, 'Unknown action');
    }

    // Board -> site reporting, compatible with lfc.ino (USE_SITE 1):
    //   GET  /api/code?team=N&game=5&key=K      -> {"code":"..."}
    //   POST /api/complete?team=N&game=5&key=K  -> marks that level solved
    if (route === 'code' || route === 'complete') {
      const team = Number(query.team);
      const game = Number(query.game);
      if (!LEVELS.includes(game)) fail(400, 'bad game');
      if (route === 'code') {
        const { data } = await load();
        const s = normalize(data).settings;
        if (query.key !== s.deviceKey) fail(401, 'bad key');
        const code = s.answers[game] || '';
        return ok({ code: code.length <= 8 ? code : '' });
      }
      return ok(await transact((state, now) => {
        if (query.key !== state.settings.deviceKey) fail(401, 'bad key');
        const t = state.teams.find((x) => x.no === team) || fail(404, 'no such team');
        return { solved: markSolved(state, t, game, now, 'board report') };
      }));
    }
    fail(404, 'Not found');
  } catch (e) {
    return { status: e.status || 500, body: { error: e.status ? e.message : 'Server error: ' + e.message } };
  }
}

const ok = (body) => ({ status: 200, body });
