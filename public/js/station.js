// Station laptop screen: shows one level's briefing to the players, mirrors the
// board live, and relays board results (solved / wrong code) to the server.
import {
  $, $$, esc, api, auth, run, toast, requireRole, topbar, wireTopbar, syncClock, now,
  fmtClock, shownStatus, STATUS_TEXT, ROLE_NAMES, devGet, httpsBlockNote, runLeftMs, viaBridge,
} from './common.js';
import { LEVEL_INFO, MORSE } from './levels.js';

const role = requireRole(['st1', 'st2', 'st4', 'st56']);
const MY_LEVELS = { st1: [1], st2: [2], st4: [4], st56: [5, 6] }[role];
const UNLOCK_MS = 5 * 60 * 1000;

let S = null;          // last server state
let level = MY_LEVELS[0];
let dev = null;        // last board reading
let devOk = null;      // true / false / null (no board)
let devErr = '';
let unlockedUntil = 0;
const prev = {};       // last board values, for detecting changes
let chart = [];        // level 5 history [gen, load]

// ---------- shell ----------
document.body.innerHTML = topbar(ROLE_NAMES[role], 'Blackout · station screen') + `
<main class="wrap">
  <div id="banners"></div>
  ${MY_LEVELS.length > 1 ? `<div class="lvtabs" role="tablist">${MY_LEVELS.map((l) =>
    `<button class="btn" role="tab" data-lv="${l}">Level ${l} · ${LEVEL_INFO[l].name}</button>`).join('')}</div>` : ''}
  <div id="lvarea"></div>
</main>`;
wireTopbar();
$$('[data-lv]').forEach((b) => b.addEventListener('click', () => showLevel(Number(b.dataset.lv))));

function briefHTML(l) {
  const i = LEVEL_INFO[l];
  return `<p class="muted" style="margin:0">Level ${l}</p>
    <h2>${esc(i.name)}</h2>
    <p class="tag">${esc(i.tag)}</p>
    <p style="font-size:18px;margin:0">${esc(i.story)}</p>
    <h3>How it works</h3><ol>${i.how.map((x) => `<li>${x}</li>`).join('')}</ol>
    <h3>Rules</h3><ul>${i.rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function liveHTML(l) {
  const lamp = `<div class="row" style="margin-top:12px;font-size:14px"><span class="lamp" id="devLamp"></span><span id="devText" class="muted">Connecting to the board…</span></div>`;
  if (l === 1) {
    return `<h2>Morse chart</h2>
      <div class="morse-grid">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => `<div class="mdigit"><b>${d}</b><span class="msym">${
        [...MORSE[d]].map((c) => `<i class="${c === '.' ? 'dot' : 'dash'}"></i>`).join('')}</span></div>`).join('')}</div>
      <p class="muted" style="margin:10px 0 0;font-size:14px">Dot = short flash · Dash = long flash (three dots long) · Long dark gap = the code starts again.</p>
      ${lamp}<div id="res"></div>`;
  }
  if (l === 2 && S && !S.settings.devices.st2?.enabled) {
    // Level 2 without a board on the site: the bridge shows the code itself, the team types it above.
    return `<h2>Balance the bridge</h2>
      <p style="font-size:18px">Find the resistor that brings the bridge voltage to <b>zero</b>. When it is balanced, the instrument shows your code.</p>
      <p class="note">Type that code in the box above to score Level 2.</p><div id="res"></div>`;
  }
  if (l === 2) {
    const ticks = [];
    for (let a = -60; a <= 60; a += 10) {
      const r = (a - 90) * Math.PI / 180;
      const r1 = a % 30 === 0 ? 100 : 108;
      ticks.push(`<line class="tick" x1="${150 + r1 * Math.cos(r)}" y1="${150 + r1 * Math.sin(r)}" x2="${150 + 120 * Math.cos(r)}" y2="${150 + 120 * Math.sin(r)}"/>`);
    }
    return `<h2>Galvanometer</h2>
      <svg class="gauge" viewBox="0 0 300 180" role="img" aria-label="Bridge balance needle">
        <path id="zone" class="zone" d=""/>
        ${ticks.join('')}
        <text x="34" y="92">−</text><text x="146" y="22">0</text><text x="258" y="92">+</text>
        <text x="150" y="172" text-anchor="middle">BRIDGE BALANCE</text>
        <line id="needle" class="needle" x1="150" y1="150" x2="150" y2="36"/>
        <circle cx="150" cy="150" r="8" fill="#222825"/>
      </svg>
      <p class="muted" style="text-align:center;margin:10px 0 0">Voltage reading</p>
      <div style="text-align:center"><span id="g2volts" class="readout huge">-- V</span></div>
      <p id="g2text" style="text-align:center;font-size:24px;font-weight:700;margin:12px 0 0">—</p>
      ${lamp}<div id="res"></div>`;
  }
  if (l === 4) {
    const six = [1, 2, 3, 4, 5, 6];
    return `<h2>Panel lamps</h2>
      <div class="bank">${six.map((i) => `<div><span class="led" id="led${i}"></span><small>L${i}</small></div>`).join('')}</div>
      <p style="text-align:center;margin:12px 0"><span class="readout big" id="lit">0 / 6</span></p>
      <h2>Switches</h2>
      <div class="bank">${six.map((i) => `<div><span class="toggle" id="sw${i}"><i></i></span><small>S${i} <b id="swt${i}">–</b></small></div>`).join('')}</div>
      ${lamp}<div id="res"></div>`;
  }
  if (l === 5) {
    return `<h2>Grid frequency</h2>
      <div class="chart"><canvas id="cv" width="900" height="260"></canvas></div>
      <div class="row" style="margin:12px 0">
        <div class="grow"><div class="muted">Frequency</div><div class="readout big" id="f5">-</div></div>
        <div class="grow"><div class="muted">Generation <span style="color:#46aaff">■</span></div><div class="readout big" id="g5">-</div></div>
        <div class="grow"><div class="muted">Load <span style="color:#ff9628">■</span></div><div class="readout big" id="l5">-</div></div>
        <div class="grow"><div class="muted">Turbine</div><div class="readout big" id="fan5">-</div></div>
      </div>
      <div class="bar"><div id="bar5"></div></div>
      <p class="muted" id="ht5" style="margin:6px 0 0"></p>
      ${lamp}<div id="res"></div>`;
  }
  return `<h2>AZ-5 emergency shutdown</h2>
    <div style="text-align:center">
      <p class="muted" style="margin:0 0 6px">Reactor clock</p>
      <div class="readout huge" id="l6left">--:--</div>
      <p id="l6text" style="font-size:26px;font-weight:700;margin:14px 0 0">—</p>
    </div>
    ${lamp}<div id="res"></div>`;
}

function showLevel(l) {
  level = l;
  $$('[data-lv]').forEach((b) => {
    b.classList.toggle('btn-ghost', Number(b.dataset.lv) !== l);
    b.setAttribute('aria-selected', String(Number(b.dataset.lv) === l));
  });
  $('#lvarea').innerHTML = `<div class="st-grid">
    <section class="panel brief">${briefHTML(l)}</section>
    <section>
      <div class="panel">
        <div class="status-strip">
          <div class="grow"><span>Team</span><span class="readout big" id="team" style="text-align:left">—</span></div>
          <div><span>Room clock</span><span class="readout big" id="timer">--:--</span></div>
          <div><span>Attempts left</span><span class="readout big" id="att">-</span></div>
        </div>
        <p id="status" style="margin:10px 0 0;font-weight:600"></p>
        <form id="codeForm" class="code-entry" hidden>
          <label for="codeIn">${l === 6 ? 'Final lock code' : 'Enter the code you found'}</label>
          <div class="row"><input id="codeIn" class="inp code-inp" autocomplete="off" autocapitalize="characters" spellcheck="false">
            <button class="btn btn-go btn-lg" type="submit">Submit code</button></div>
          <p id="codeMsg" class="muted" role="status" style="margin:6px 0 0"></p>
        </form>
      </div>
      ${l === 6 ? '<div class="panel" id="lateBox" hidden><h2>Codes not entered yet</h2><p class="note">Enter any code from an earlier level that you have not typed in yet. Points count only once the code is entered.</p><div id="lateList"></div></div>' : ''}
      <div class="panel" id="live">${liveHTML(l)}</div>
      <div class="panel"><details class="drawer" id="drawer"><summary>Coordinator controls</summary><div id="ctrls"></div></details></div>
    </section></div>`;
  $('#drawer').addEventListener('toggle', renderControls);
  $('#codeForm').addEventListener('submit', (e) => { e.preventDefault(); submitCode(level, $('#codeIn'), $('#codeMsg')); });
  chart = [];
  renderControls();
  update();
  if (dev) updateLive(dev);
}

// ---------- coordinator controls ----------
function renderControls() {
  const box = $('#ctrls');
  if (!box || !$('#drawer').open) return;
  if (now() > unlockedUntil) {
    box.innerHTML = `<form class="ctrl" id="unlockForm">
      <input class="inp" type="password" id="unlockPw" placeholder="Station password" style="max-width:240px" autocomplete="current-password">
      <button class="btn" type="submit">Unlock</button></form>`;
    $('#unlockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.act('login', { role, password: $('#unlockPw').value });
        unlockedUntil = now() + UNLOCK_MS;
        renderControls();
      } catch (err) { toast(err.message, true); }
    });
    return;
  }
  const t = seatedTeam(level);
  const devBtns = {
    1: `<button class="btn btn-ghost" data-dev="newcode">New code on board</button>`,
    2: '',
    4: '',
    5: `<button class="btn btn-ghost" data-dev="g5start">Start grid on board</button>
        <button class="btn btn-ghost" data-dev="g5stop">Stop grid on board</button>`,
    6: `<button class="btn btn-ghost" data-dev="l6arm">Re-sync room clock to board</button>
        <button class="btn btn-ghost" data-dev="l6stop">Stop clock / silence siren</button>
        <button class="btn btn-ghost" data-dev="l6win">Test win sound</button>
        <button class="btn btn-ghost" data-dev="l6lose">Test lose siren + red lights</button>`,
  }[level];
  box.innerHTML = `
    <p style="margin:10px 0 0">Team playing: <b>${t ? `#${t.no} ${esc(t.name)}` : 'none'}</b> <span class="muted">(chosen on master control)</span></p>
    <div class="ctrl">
      <button class="btn btn-go" data-a="start">Start / resume</button>
      <button class="btn btn-warn" data-a="pause">Pause / resume</button>
      <button class="btn" data-a="wrong">Wrong attempt</button>
      <button class="btn" data-a="hint">Give hint</button>
      ${level !== 6 && level !== 1 ? '<button class="btn" data-a="found">Task done · code later</button>' : ''}
      <button class="btn btn-go" data-a="solve">Mark solved</button>
      <button class="btn btn-danger" data-a="open">Give up · open box</button>
      ${level === 1 ? '<button class="btn btn-ghost" data-a="skip">Team skips Level 1</button>' : ''}
      <button class="btn btn-ghost" data-a="reset">Reset level for team</button>
    </div>
    ${devBtns ? `<div class="ctrl">${devBtns}</div>` : ''}
    <div class="ctrl"><button class="btn btn-ghost btn-sm" id="lockBtn">Lock controls</button>
      <span class="muted" style="font-size:14px">Board: ${esc(devAddr())} · locks again after 5 minutes</span></div>`;

  $$('[data-a]', box).forEach((b) => b.addEventListener('click', () => coordinatorAction(b.dataset.a)));
  $$('[data-dev]', box).forEach((b) => b.addEventListener('click', () => boardCommand(b.dataset.dev)));
  $('#lockBtn').addEventListener('click', () => { unlockedUntil = 0; $('#drawer').open = false; });
}

const CONFIRM = {
  open: 'Open this level for the team so they can continue? This costs points.',
  reset: 'Reset this level for this team? Their timer, attempts and result here are cleared.',
  skip: 'This team skips Level 1 and cannot come back. Continue?',
  solve: 'Mark this level solved for the team?',
};

async function coordinatorAction(a) {
  unlockedUntil = now() + UNLOCK_MS;
  if (CONFIRM[a] && !confirm(CONFIRM[a])) return;
  const r = await run(a, { level }, 'Done');
  if (!r) return;
  // Levels 5 and 6 run their own clock on the board. Starting is handled by
  // watchStarts() (it also catches the automatic start); stopping is done here.
  if (a === 'reset' && level === 5) boardCommand('g5stop');
  if (a === 'reset' && level === 6) boardCommand('l6stop');
  if (a === 'reset' && level === 1) boardCommand('newcode');
  refresh();
}

function devAddr() {
  const d = S?.settings.devices[role];
  return d ? `${d.ip}:${d.port}${d.enabled ? '' : ' (disabled)'}` : '—';
}

function seatedTeam(l) {
  const id = S?.seat[l];
  return id ? S.teams.find((t) => t.id === id) : null;
}

async function boardCommand(cmd, forLevel = level, quiet = false) {
  const d = S?.settings.devices[role];
  if (!d?.enabled) return toast('No board enabled for this station', true);
  const key = encodeURIComponent(S.settings.deviceKey);
  const t = seatedTeam(forLevel);
  const espTeam = t ? ((t.no - 1) % 10) + 1 : 1; // lfc.ino accepts team 1..10
  const secs = t ? Math.max(1, Math.ceil(runLeftMs(t, S.settings) / 1000)) : S.settings.runLimit;
  const path = {
    newcode: `/api/newcode?key=${key}`,
    g5start: `/api/start?team=${espTeam}&key=${key}`,
    g5stop: `/api/stop?key=${key}`,
    l6arm: `/api/event/start?team=${espTeam}&secs=${secs}&key=${key}`,
    l6stop: `/api/event/stop?key=${key}`,
    l6win: `/api/l6/test?mode=win&key=${key}`,
    l6lose: `/api/l6/test?mode=lose&key=${key}`,
  }[cmd];
  try {
    await devGet(d, path, 2500);
    if (!quiet) toast('Board: OK');
  } catch (e) {
    if (!quiet) toast('Board did not answer: ' + e.message, true);
  }
}

// ---------- server state ----------
async function refresh() {
  try {
    const s = await api.state();
    if (s.role !== role) { auth.clear(); location.href = '/login?role=' + role; return; }
    syncClock(s.now);
    S = s;
    if (level === 2 && $('#live') && !!$('#needle') !== !!S.settings.devices.st2?.enabled) $('#live').innerHTML = liveHTML(2);
    update();
    watchStarts();
    // don't rebuild the drawer while someone is typing the password in it
    if (!$('#ctrls')?.contains(document.activeElement)) renderControls();
  } catch (e) {
    $('#banners').innerHTML = `<div class="banner bad">Cannot reach the event server: ${esc(e.message)}</div>`;
  }
}

function update() {
  if (!S || !$('#team')) return;
  const t = seatedTeam(level);
  const rec = t?.levels[level];
  const sc = S.settings.scoring;
  $('#team').textContent = t ? `#${t.no} ${t.name}` : 'No team';
  // One clock for the whole room (7 min by default), shown on every station.
  const timer = $('#timer');
  const left = t ? runLeftMs(t, S.settings) : S.settings.runLimit * 1000;
  const r = t?.run;
  timer.classList.remove('alarm', 'done');
  timer.textContent = r?.result === 'timeout' ? 'TIME UP' : fmtClock(Math.max(0, left));
  if (r?.result === 'timeout' || (r?.startedAt && !r.endedAt && left <= 60000)) timer.classList.add('alarm');
  if (r?.result === 'finished') timer.classList.add('done');
  if (r?.startedAt && !r.endedAt && !r.pausedAt && left <= 0) reportTimeUp(t);
  $('#att').textContent = rec ? Math.max(0, sc.maxAttempts - rec.attempts) : sc.maxAttempts;
  const st = shownStatus(rec);
  $('#status').textContent = !t ? 'Waiting for the coordinator to pick a team.'
    : r.result === 'timeout' ? 'Time is up.'
    : r.pausedAt ? 'Paused by the coordinator.'
    : STATUS_TEXT[st] + (rec.hints ? ` · hints used: ${rec.hints}` : '');
  $('#status').className = st === 'solved' || st === 'skipped' ? 'ok-t' : st === 'failed' || st === 'forced' ? 'bad-t' : '';
  $('#status').style.fontWeight = '600';

  const banners = [];
  if (S.settings.paused) banners.push('<div class="banner">All timers are paused by the control room.</div>');
  if (devOk === false) banners.push(`<div class="banner bad"><b>Board not responding</b> (${esc(devAddr())}: ${esc(devErr)}).<br>${httpsBlockNote()}</div>`);
  $('#banners').innerHTML = banners.join('');
  updateCodeEntry();
  updateResult();
}

// ---------- board ----------
async function pollDevice() {
  const d = S?.settings.devices[role];
  if (d?.enabled) {
    try {
      const j = await devGet(d, '/api/state');
      if (typeof j !== 'object') throw new Error('unexpected reply');
      dev = j;
      devOk = true;
      relay(j);
      ensureBoardStarted(j);
      updateLive(j);
    } catch (e) {
      devOk = false;
      devErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
  } else {
    devOk = null;
  }
  const lamp = $('#devLamp');
  if (lamp) {
    lamp.className = 'lamp ' + (devOk ? 'ok' : devOk === false ? 'bad' : '');
    $('#devText').textContent = devOk ? `Board online · ${devAddr()}` : devOk === false ? `Board offline · ${devAddr()}` : 'No board for this station';
  }
  setTimeout(pollDevice, viaBridge() ? 500 : role === 'st56' ? 250 : 700); // the bridge relays twice a second
}

// Fire an action when a board value changes (never on the first reading,
// so reloading this page does not repeat a result).
function watch(key, value, onChange) {
  const p = prev[key];
  prev[key] = value;
  if (p !== undefined && p !== value) onChange(p, value);
}

async function boardResult(l, action, code) {
  const t = seatedTeam(l);
  if (!t) return toast(`Board reported a result on Level ${l} but no team is playing`, true);
  if (await run(action, { level: l, source: 'board', code })) refresh();
}

// When Level 5 or 6 starts (by a button or automatically after the previous level),
// start the board too: the grid game, or the AZ-5 clock with the siren.
const boardStarted = {}; // level -> start already sent to the board for this run
const startKey = (l) => {
  const t = seatedTeam(l);
  const rec = t?.levels[l];
  return rec?.status === 'playing' && rec.startedAt ? `${t.id}:${rec.startedAt}` : '';
};

function watchStarts() {
  if (role !== 'st56') return;
  watch('start5', startKey(5), (a, b) => { if (b) { boardStarted[5] = b; g5RetryAt = Date.now(); boardCommand('g5start', 5, true); } });
}

// While Level 5 is playing, the grid must be running. If the board sits idle (page opened
// mid-level, or the first start was missed because the board was off), start it again,
// at most every 5 s. A running or finished game is never restarted (only state 0 = idle).
let g5RetryAt = 0;
function ensureBoardStarted(j) {
  if (role !== 'st56') return;
  const key = startKey(5);
  if (key && j.state === 0 && (boardStarted[5] !== key || Date.now() - g5RetryAt > 5000)) {
    boardStarted[5] = key;
    g5RetryAt = Date.now();
    boardCommand('g5start', 5, true);
  } else if (key) boardStarted[5] = key;
  syncRoomClock(j);
}

// The 5+6 board keeps its own copy of the room deadline, so the siren still
// sounds on time if a laptop dies. Keep it in step with the server's clock.
let armedKey = '';
let lastBoardFix = 0;
let loseSentFor = '';
function syncRoomClock(j) {
  const t = seatedTeam(6);
  const r = t?.run;
  if (!r?.startedAt) return;
  const runKey = `${t.id}:${r.startedAt}`;
  const live = !r.endedAt && !r.pausedAt;
  const fixDue = Date.now() - lastBoardFix > 3000;
  if (live) {
    const key = `${runKey}:${r.pausedMs}`; // changes on every resume -> re-arm with the time left
    if (armedKey !== key || (j.l6 === 0 && fixDue)) {
      armedKey = key;
      lastBoardFix = Date.now();
      boardCommand('l6arm', 6, true);
    }
    if (j.l6 === 3) reportTimeUp(t, 'board'); // board's deadline passed first
  } else if (r.pausedAt && j.l6 === 1 && fixDue) {
    lastBoardFix = Date.now();
    boardCommand('l6stop', 6, true); // paused: stop the board's countdown (re-armed on resume)
  } else if (r.result === 'timeout' && j.l6 !== 3 && loseSentFor !== runKey) {
    loseSentFor = runKey;
    boardCommand('l6lose', 6, true); // server says time is up: make sure the siren sounds
  }
}

let timeUpSentFor = '';
function reportTimeUp(t, source) {
  const k = `${t.id}:${t.run.startedAt}`;
  if (timeUpSentFor === k) return;
  timeUpSentFor = k;
  api.act('timeUp', { source }).then(refresh).catch(() => { timeUpSentFor = ''; });
}

// ---------- code entry ----------
// Level 1's code lives on its board (it changes every round); Level 5's is shown by its board.
async function boardCodeFor(l) {
  try {
    if (l === 1 && S.settings.devices.st1?.enabled) {
      return (await devGet(S.settings.devices.st1, `/api/answer?key=${encodeURIComponent(S.settings.deviceKey)}`)).code || '';
    }
    if (l === 5 && role === 'st56') return dev?.code || '';
  } catch {}
  return '';
}

async function submitCode(l, input, msg) {
  const value = input.value.trim();
  if (!value) return;
  msg.textContent = 'Checking…';
  msg.className = 'muted';
  try {
    const r = await api.act('answer', { level: l, value, boardCode: await boardCodeFor(l) });
    if (r.correct) {
      msg.textContent = r.already ? 'Already entered.' : `Correct! Level ${l} scored ${r.points} points.`;
      msg.className = 'ok-t';
      input.value = '';
    } else {
      msg.textContent = r.attemptsLeft ? `Wrong code. ${r.attemptsLeft} attempt${r.attemptsLeft > 1 ? 's' : ''} left.` : 'Wrong code. No attempts left; ask the coordinator.';
      msg.className = 'bad-t';
    }
    refresh();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'bad-t';
  }
}

const NEEDS_CODE = ['waiting', 'playing', 'found'];

function updateCodeEntry() {
  const t = seatedTeam(level);
  const rec = t?.levels[level];
  const form = $('#codeForm');
  // Level 6 ends with the AZ-5 button; it only takes a typed code if one is set on master.
  form.hidden = !t || !NEEDS_CODE.includes(rec.status) || level === 6 || t.run.result === 'timeout';
  const late = $('#lateBox');
  if (!late) return;
  const pending = t && t.run.result !== 'timeout' ? [1, 2, 3, 4, 5].filter((l) => t.levels[l].status === 'found' || (t.levels[l].status === 'playing' && l !== level)) : [];
  late.hidden = !pending.length;
  const ids = pending.join(',');
  if (late.dataset.ids === ids) return;
  late.dataset.ids = ids;
  $('#lateList').innerHTML = pending.map((l) => `<form class="row" data-late="${l}" style="margin:8px 0">
      <b style="min-width:12ch">Level ${l} · ${esc(LEVEL_INFO[l].name)}</b>
      <input class="inp grow" style="max-width:220px" autocomplete="off" aria-label="Level ${l} code">
      <button class="btn btn-go" type="submit">Submit</button><span class="muted" role="status"></span></form>`).join('');
  $$('[data-late]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    submitCode(Number(f.dataset.late), f.querySelector('input'), f.querySelector('span'));
  }));
}

function relay(j) {
  if (role === 'st1') {
    watch('solves', j.solves, (a, b) => b > a && boardResult(1, 'solve'));
    watch('wrongs', j.wrongs, (a, b) => { for (let i = a; i < b; i++) boardResult(1, 'wrong'); });
  }
  if (role === 'st2') watch('unlocked', !!j.unlocked, (a, b) => b && boardResult(2, 'found', j.code));
  if (role === 'st4') watch('solved', !!j.solved, (a, b) => b && boardResult(4, 'found'));
  if (role === 'st56') {
    watch('g5', j.state, (a, b) => b === 2 && boardResult(5, 'found', j.code));
    watch('l6', j.l6, (a, b) => b === 2 && boardResult(6, 'solve'));
  }
}

function updateLive(j) {
  if (level === 2 && $('#needle')) {
    // Needle follows the bridge voltage A - B. Square-root scale: lively near zero, full scale at 8x the window.
    const v = Number(j.volts);
    const win = Number(j.window) || 40;
    const full = Math.max(win * 8, 300);
    const open = j.volts === undefined || !isFinite(v);
    const mv = open ? 0 : v * 1000;
    const deg = Math.sign(mv) * 60 * Math.min(1, Math.sqrt(Math.abs(mv) / full));
    $('#needle').style.transform = `rotate(${deg}deg)`;
    const z = Math.max(3, 60 * Math.sqrt(win / full));
    const pt = (a) => { const r = (a - 90) * Math.PI / 180; return `${150 + 125 * Math.cos(r)} ${150 + 125 * Math.sin(r)}`; };
    $('#zone').setAttribute('d', `M ${pt(-z)} A 125 125 0 0 1 ${pt(z)}`);
    const inZone = !open && Math.abs(deg) <= z;
    $('#g2volts').textContent = isFinite(v) && j.volts !== undefined ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} V` : '-- V';
    $('#g2volts').className = 'readout huge' + (j.unlocked ? ' done' : '');
    $('#g2text').textContent = j.unlocked ? 'Zero volts detected! BALANCED' : open ? 'Waiting for a reading' : inZone ? 'Almost… hold it' : 'Locked · bring the voltage to zero';
    $('#g2text').className = j.unlocked ? 'ok-t' : inZone ? 'warn-t' : '';
  }
  if (level === 4 && $('#lit')) {
    const led = j.led || [];
    const sw = j.sw || [];
    for (let i = 1; i <= 6; i++) {
      $('#led' + i).classList.toggle('on', !!led[i - 1]);
      $('#sw' + i).classList.toggle('up', !!sw[i - 1]);
      $('#swt' + i).textContent = sw[i - 1] ? 'ON' : 'OFF';
    }
    const n = led.filter(Boolean).length;
    $('#lit').textContent = `${n} / 6`;
    $('#lit').className = 'readout big' + (n === 6 ? ' done' : '');
  }
  if (level === 5 && $('#cv')) drawGrid(j);
  if (level === 6 && $('#l6left')) {
    const txt = ['Waiting for the coordinator', 'Clock running · find the code and press AZ-5', 'REACTOR SHUT DOWN', 'TIME RAN OUT'][j.l6] || '—';
    $('#l6left').textContent = j.l6 === 1 ? fmtClock((j.left || 0) * 1000) : j.l6 === 2 ? 'SAFE' : j.l6 === 3 ? '00:00' : '--:--';
    $('#l6left').className = 'readout huge' + (j.l6 === 2 ? ' done' : j.l6 === 3 || (j.l6 === 1 && j.left <= 60) ? ' alarm' : '');
    $('#l6text').textContent = txt;
    $('#l6text').className = j.l6 === 2 ? 'ok-t' : j.l6 === 3 ? 'bad-t' : '';
  }
  updateResult();
}

function drawGrid(j) {
  if (j.state === 1) { chart.push([j.gen, j.load]); if (chart.length > 300) chart.shift(); }
  if (j.state === 0) chart = [];
  const c = $('#cv');
  const x = c.getContext('2d');
  const W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  x.strokeStyle = '#2a3750'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
  const y = (v) => Math.max(2, Math.min(H - 2, H - (v - 250) / 100 * H));
  [[1, '#ff9628'], [0, '#46aaff']].forEach(([k, col]) => {
    x.strokeStyle = col; x.lineWidth = 3; x.beginPath();
    chart.forEach((p, i) => { const px = i * W / 300, py = y(p[k]); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
  });
  const tol = Number(j.TOL) || 0.15;
  const ok = Math.abs(j.f - 50) <= tol;
  $('#f5').textContent = Number(j.f).toFixed(3) + ' Hz';
  $('#f5').className = 'readout big ' + (j.state ? (ok ? 'done' : 'alarm') : '');
  $('#g5').textContent = Number(j.gen).toFixed(0) + ' MW';
  $('#l5').textContent = Number(j.load).toFixed(0) + ' MW';
  const fanPct = Math.round((Number(j.fan) || 0) / 255 * 100);
  $('#fan5').textContent = !j.state ? 'OFF' : fanPct > 0 ? `RUN ${fanPct}%` : 'STALLED';
  $('#fan5').className = 'readout big ' + (j.state ? (fanPct > 0 ? 'done' : 'alarm') : '');
  $('#bar5').style.width = Math.min(100, j.hold / j.HOLD * 100) + '%';
  $('#bar5').style.background = ok ? 'var(--green)' : 'var(--red)';
  $('#ht5').textContent = j.state ? `Stable ${Number(j.hold).toFixed(1)} / ${Number(j.HOLD).toFixed(0)} s  (keep 50 ± ${tol} Hz)` : 'Waiting for the coordinator to start the grid…';
}

// Big result box under the live view.
function updateResult() {
  const box = $('#res');
  if (!box || !S) return;
  const t = seatedTeam(level);
  const rec = t?.levels[level];
  let html = '';
  if (level === 2 && dev?.unlocked && dev.code) html = resultBox('BRIDGE BALANCED · YOUR CODE', dev.code);
  else if (level === 5 && dev?.state === 2) {
    // Setup's L5 code wins over the code built into lfc.ino (sent once the site has the task as done)
    const code = S.settings.l5Setup ? S.settings.l5Code : dev.code;
    html = resultBox('GRID STABILISED · YOUR CODE', code || '…', code ? '' : 'Getting your code…');
  }
  else if (rec?.status === 'solved') {
    html = {
      1: resultBox('CODE CORRECT', '', 'The coordinator will open Box 1.'),
      2: resultBox('BRIDGE BALANCED', '', 'The coordinator will open Box 2.'),
      4: resultBox('INTERLOCK RELEASED', '', 'Read the labels on the switches that are ON, then collect your code slip.'),
      5: resultBox('GRID STABILISED', '', 'Collect your code slip from the coordinator.'),
      6: resultBox('REACTOR SHUT DOWN', '', `Mission complete, ${esc(t.name)}. Total ${t.totals.points} points.`),
    }[level];
  } else if (rec?.status === 'found' && level !== 2 && level !== 5) {
    html = resultBox(level === 4 ? 'INTERLOCK RELEASED' : 'TASK DONE', '', 'Type your code in the box above to score the points.');
  } else if (t?.run.result === 'timeout') {
    html = resultBox('TIME UP', '', 'The reactor could not be shut down in time.', true);
  } else if (rec?.status === 'failed') html = resultBox('ALL ATTEMPTS USED', '', 'Wait for the coordinator.', true);
  else if (rec?.status === 'forced') html = resultBox('TIME OVER', '', 'The coordinator has opened this level so you can continue.', true);
  else if (rec?.status === 'skipped') html = resultBox('LEVEL SKIPPED', '', 'Go to Level 2.');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

function resultBox(title, code, sub = '', bad = false) {
  return `<div class="result${bad ? ' bad' : ''}" style="margin-top:14px"><h3>${esc(title)}</h3>
    ${code ? `<div class="code${String(code).length > 6 ? ' long' : ''}">${esc(code)}</div>` : ''}${sub ? `<p style="margin:8px 0 0;color:var(--dial)">${sub}</p>` : ''}</div>`;
}

// ---------- start ----------
showLevel(level);
await refresh();
setInterval(refresh, 2000);
setInterval(update, 1000);
pollDevice();

// On the 5+6 laptop, jump to whichever level the team is playing.
if (MY_LEVELS.length > 1) {
  setInterval(() => {
    // stay on a finished task until its code is typed in (Level 5 shows its code on screen)
    if (seatedTeam(level)?.levels[level].status === 'found') return;
    const playing = MY_LEVELS.find((l) => seatedTeam(l)?.levels[l].status === 'playing');
    if (playing && playing !== level && !$('#drawer').open) showLevel(playing);
  }, 2000);
}
