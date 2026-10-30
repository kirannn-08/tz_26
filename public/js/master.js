// Master control: every station, team registrations, scores, devices, setup, log.
import {
  $, $$, esc, api, auth, run, toast, requireRole, topbar, wireTopbar, syncClock, now,
  elapsedMs, fmtClock, shownStatus, STATUS_TEXT, devGet, httpsBlockNote, runLeftMs,
  viaBridge, bridgeSnapshot, bridgeAlive,
} from './common.js';
import { LEVEL_INFO } from './levels.js';

requireRole(['master']);

const LV = [1, 2, 3, 4, 5, 6];
const BOARD_OF = { 1: 'st1', 2: 'st2', 3: null, 4: 'st4', 5: 'st56', 6: 'st56' };
const BOARD_NAMES = { st1: 'Level 1 · Morse + keypad', st2: 'Level 2 · Bridge', st4: 'Level 4 · Switch panel', st56: 'Levels 5 + 6 · Grid / AZ-5 (lfc.ino)' };

let S = null;
let tab = 'stations';
const devs = {}; // board -> { ok, data, at, err }
let l1Code = '';
let bridge = null; // { alive, at, now } from the last bridge snapshot
let l1Keys = { keys: '', lastWrong: '' }; // what the Level 1 keypad last sent (master only)

document.body.innerHTML = topbar('Master control', 'Blackout · control room',
  `<button class="btn btn-danger btn-sm" id="sirenBtn" type="button" aria-pressed="false">Siren ON</button>
   <button class="btn btn-ghost btn-sm" id="revealBtn" type="button" aria-pressed="true">Hide answers</button>`) + `
<main class="wrap">
  <div id="banners"></div>
  <section class="panel" aria-label="Safety">
    <div class="row">
      <h2 style="font-size:20px;margin:0">Safety</h2>
      <button class="btn btn-warn" id="pauseAll" type="button">Pause all timers</button>
      <button class="btn btn-danger" id="silence" type="button">Silence siren + red lights</button>
      <span class="muted grow" style="font-size:14px">The exit is never locked. Pause freezes every running station timer; press again to resume.</span>
    </div>
  </section>
  <section class="panel" aria-label="Team playing now" id="activePanel"></section>
  <section class="panel" aria-label="Station overview">
    <div class="track" id="mimic"></div>
  </section>
  <nav class="tabs" role="tablist" style="margin-top:16px">
    ${[['stations', 'Stations'], ['teams', 'Teams'], ['board', 'Leaderboard'], ['devices', 'Devices'], ['setup', 'Setup'], ['log', 'Event log']]
      .map(([k, n]) => `<button class="tab" role="tab" data-tab="${k}">${n}</button>`).join('')}
  </nav>
  <section class="panel" id="content" style="border-top-left-radius:0"></section>
</main>`;
wireTopbar();

// Answers are shown by default on the control-room laptop; the choice is remembered here.
function setReveal(on) {
  document.body.classList.toggle('reveal', on);
  $('#revealBtn').setAttribute('aria-pressed', String(on));
  $('#revealBtn').textContent = on ? 'Hide answers' : 'Show answers';
  try { localStorage.setItem('bo.reveal', on ? '1' : '0'); } catch {}
}
let revealPref = null;
try { revealPref = localStorage.getItem('bo.reveal'); } catch {}
setReveal(revealPref !== '0');
$('#revealBtn').addEventListener('click', () => setReveal(!document.body.classList.contains('reveal')));
// ----- siren switch (top bar) -----
// lfc.ino sounds the siren + red lights for 10 s on /api/l6/test?mode=lose, so while the
// switch is ON this page repeats it every 8 s. OFF = /api/event/stop (siren and red lights off).
let sirenTimer = null;
function sirenUi(on) {
  $('#sirenBtn').textContent = on ? 'Siren OFF' : 'Siren ON';
  $('#sirenBtn').className = 'btn btn-sm ' + (on ? 'btn-warn' : 'btn-danger');
  $('#sirenBtn').setAttribute('aria-pressed', String(on));
}
$('#sirenBtn').addEventListener('click', () => {
  if (sirenTimer) {
    clearInterval(sirenTimer);
    sirenTimer = null;
    sirenUi(false);
    boardCmd('st56', `/api/event/stop?key=${key()}`);
    return;
  }
  const t = teamById(S?.active);
  const live = t?.run.startedAt && !t.run.endedAt;
  if (live && !confirm(`${t.name} is playing. The 5+6 station counts the siren as the room clock running out, so their run would end as TIME UP. Sound the siren anyway?`)) return;
  const sound = () => boardCmd('st56', `/api/l6/test?mode=lose&key=${key()}`, true);
  sound();
  sirenTimer = setInterval(sound, 8000);
  sirenUi(true);
  toast('Siren on. Press "Siren OFF" to stop it.');
});
$('#pauseAll').addEventListener('click', async () => { if (await run('pauseAll', {})) refresh(); });
$('#silence').addEventListener('click', () => {
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; sirenUi(false); }
  boardCmd('st56', `/api/event/stop?key=${key()}`);
});
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; renderTab(true); }));

const key = () => encodeURIComponent(S?.settings.deviceKey || '');
const teamById = (id) => S?.teams.find((t) => t.id === id);
const seated = (l) => teamById(S?.seat[l]);

// ---------- server ----------
async function refresh() {
  try {
    const s = await api.state();
    if (s.role !== 'master') { auth.clear(); location.href = '/login?role=master'; return; }
    syncClock(s.now);
    S = s;
    renderBanners();
    renderActive();
    renderMimic();
    renderTab(false);
    $('#pauseAll').textContent = S.settings.paused ? 'Resume all timers' : 'Pause all timers';
  } catch (e) {
    $('#banners').innerHTML = `<div class="banner bad">Cannot reach the event server: ${esc(e.message)}</div>`;
  }
}

function renderBanners() {
  const b = [];
  if (S.storage === 'memory') {
    b.push(`<div class="banner bad"><b>No database connected.</b> Create a free Upstash Redis database and add <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code> to the site's environment variables (Netlify: Site configuration → Environment variables), then redeploy. Until then, laptops may see different data.</div>`);
  }
  if (S.settings.paused) b.push('<div class="banner"><b>All timers are paused.</b></div>');
  if (viaBridge() && bridge && !bridge.alive) {
    b.push(`<div class="banner bad"><b>Mac bridge not running</b>${bridge.at ? ` (last heard ${Math.round((bridge.now - bridge.at) / 1000)} s ago)` : ''}. Boards cannot reach the site.
      On the Mac joined to PuzzleBox, in the <code>blackout-web</code> folder, run <code>npm run bridge -- ${esc(location.origin)}</code>.</div>`);
  } else {
    const anyOff = Object.entries(devs).some(([k, d]) => d.ok === false && S.settings.devices[k]?.enabled);
    if (anyOff) b.push(`<div class="banner">Some boards are not answering${viaBridge() ? ' the Mac bridge' : ' this laptop'}. ${httpsBlockNote()}</div>`);
  }
  $('#banners').innerHTML = b.join('');
}

// ---------- team playing now (one team at a time) ----------
function renderActive() {
  const box = $('#activePanel');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  const t = teamById(S.active);
  const teams = [...S.teams].sort((a, b) => a.no - b.no);
  const next = t && LV.find((l) => !['solved', 'skipped', 'forced', 'found', 'failed'].includes(t.levels[l].status));
  const running = t && LV.find((l) => t.levels[l].status === 'playing');
  box.innerHTML = `<div class="row">
      <h2 style="font-size:20px;margin:0">Team playing now</h2>
      <select class="inp" id="activeSel" style="max-width:320px"><option value="">— nobody —</option>${teams.map((x) =>
        `<option value="${x.id}" ${x.id === S.active ? 'selected' : ''}>#${x.no} ${esc(x.name)} (${x.members.length} members)${x.totals.finished ? ' · finished' : ''}</option>`).join('')}</select>
      ${t && !running && next === 1 && t.levels[1].status === 'waiting' ? `<button class="btn btn-go" id="startRun">Start Level 1</button><button class="btn btn-ghost" id="skipRun">Skip Level 1 → start Level 2</button>` : ''}
      ${t && !running && next && next !== 1 ? `<button class="btn btn-go" id="startNext">Start Level ${next}</button>` : ''}
      ${t && t.run.startedAt ? `<button class="btn btn-ghost btn-sm" id="resetRun">Reset this team's run</button>` : ''}
      ${t ? `<span class="grow"></span><span class="readout big">${t.totals.points} pts</span>
        <span class="muted" style="font-size:14px">Room clock</span><span class="readout big" id="runClock">--:--</span>` : ''}
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:14px">${t
      ? `${t.members.map(esc).join(', ')} · ${t.run.result === 'finished' ? `<b class="ok">FINISHED</b> with ${fmtClock(t.totals.leftMs)} left (+${t.totals.bonus} bonus)`
        : t.run.result === 'timeout' ? '<b class="bad">TIME UP</b> (siren)'
        : running ? `now on <b>Level ${running}</b>` : next ? `next: Level ${next}` : 'all levels done'}.
        The ${Math.round(S.settings.runLimit / 60)}-minute room clock starts with the first level; each finished level starts the next one.`
      : 'Pick the team that is about to play. Every station screen switches to that team.'}</p>`;
  tickRunClock();
  $('#activeSel').addEventListener('change', async (e) => {
    const cur = teamById(S.active);
    if (cur && LV.some((l) => cur.levels[l].status === 'playing') && !confirm(`${cur.name} is still playing. Pause them and switch?`)) { e.target.value = S.active; return; }
    if (await run('activate', { teamId: e.target.value || null }, 'Team switched')) refresh();
  });
  $('#startRun')?.addEventListener('click', async () => { if (await run('start', { level: 1 }, 'Level 1 started')) refresh(); });
  $('#skipRun')?.addEventListener('click', async () => { if (confirm('Team skips Level 1 for good?') && await run('skip', { level: 1 }, 'Level 2 started')) refresh(); });
  $('#startNext')?.addEventListener('click', async () => { if (await run('start', { level: next }, `Level ${next} started`)) refresh(); });
  $('#resetRun')?.addEventListener('click', async () => {
    if (!confirm(`Reset ${t.name}: clear every level, score and the room clock?`)) return;
    if (await run('teamResetAll', { id: t.id }, 'Run reset')) {
      boardCmd('st56', `/api/event/stop?key=${key()}`, true);
      boardCmd('st56', `/api/stop?key=${key()}`, true);
      refresh();
    }
  });
}

// Room clock in the panel, every second; reports time-up if no board did.
let timeUpSent = '';
function tickRunClock() {
  const el = $('#runClock');
  const t = S && teamById(S.active);
  if (!el || !t) return;
  const left = runLeftMs(t, S.settings);
  const r = t.run;
  el.textContent = r.result === 'timeout' ? 'TIME UP' : fmtClock(Math.max(0, left));
  el.className = 'readout big' + (r.result === 'timeout' || (r.startedAt && !r.endedAt && left <= 60000) ? ' alarm' : r.result === 'finished' ? ' done' : '');
  const k = `${t.id}:${r.startedAt}`;
  if (r.startedAt && !r.endedAt && !r.pausedAt && left <= 0 && timeUpSent !== k) {
    timeUpSent = k;
    api.act('timeUp', {}).then(refresh).catch(() => { timeUpSent = ''; });
  }
}
setInterval(tickRunClock, 1000);

// ---------- overview strip ----------
const levelTime = (rec) => (rec?.startedAt ? fmtClock(elapsedMs(rec)) : '');

function renderMimic() {
  $('#mimic').innerHTML = LV.map((l) => {
    const t = seated(l);
    const rec = t?.levels[l];
    const st = t ? shownStatus(rec) : 'waiting';
    const bd = BOARD_OF[l];
    const dot = !bd || !S.settings.devices[bd]?.enabled ? 'none' : devs[bd]?.ok ? 'ok' : devs[bd]?.ok === false ? 'bad' : '';
    const next = seated(l + 1);
    const lit = t && ['solved', 'skipped', 'forced'].includes(rec.status) && next?.id === t.id;
    return `<button class="node ${lit ? 'lit' : ''}" data-s="${st}" data-go="${l}" type="button" title="${STATUS_TEXT[st]}">
      <span class="big-lamp"><b>${l}</b><span class="dev-dot ${dot}"></span></span>
      <span class="n-name">${esc(LEVEL_INFO[l].name)}</span>
      <span class="n-team">${t ? '#' + t.no + ' ' + esc(t.name) : '—'}</span>
      <span class="n-time">${levelTime(rec)}</span></button>`;
  }).join('');
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
    tab = 'stations';
    renderTab(true);
    document.getElementById('card' + b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// ---------- tabs ----------
function renderTab(force) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (!S) return;
  const c = $('#content');
  // Don't wipe a form while someone is typing in it.
  if (!force && c.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  // ...or while a fold-out form is open (the 2 s refresh used to snap it shut)
  if (!force && c.querySelector('details[open]')) return;
  if (!force && (tab === 'setup' || tab === 'devices') && c.dataset.tab === tab) {
    if (tab === 'devices') updateDeviceStatus();
    return;
  }
  c.dataset.tab = tab;
  ({ stations: renderStations, teams: renderTeams, board: renderBoard, devices: renderDevices, setup: renderSetup, log: renderLog })[tab](c);
}

// ----- stations -----
// The code the team must find for a level. L1 comes live from the Morse board,
// L5 from lfc.ino's CODES[] for the team number the board was started with.
function answerFor(l, t) {
  const set = S.settings.answers[l];
  if (set) return { code: set };
  if (l === 1) return S.settings.devices.st1.enabled && devs.st1?.ok
    ? { code: l1Code || '…', note: 'live from the board, changes after each solve' }
    : { code: '?', note: 'board offline' };
  if (l === 5) {
    const live = devs.st56?.ok && devs.st56.data.code;
    if (live) return { code: live, note: 'shown on the board' };
    return t ? { code: String(150 + ((t.no - 1) % 10) + 1), note: `lfc.ino code for team ${((t.no - 1) % 10) + 1}` } : null;
  }
  return null;
}

function boardLine(l) {
  const bd = BOARD_OF[l];
  if (!bd) return '<span class="muted">Paper station, no board. Check the answer below or mark it solved.</span>';
  const d = devs[bd];
  if (!S.settings.devices[bd]?.enabled) return '<span class="muted">Board disabled on the Devices page</span>';
  if (!d || d.ok === null) return '<span class="muted">Checking board…</span>';
  if (!d.ok) return `<span class="bad-t">Board offline (${esc(d.err)})</span>`;
  const j = d.data;
  if (l === 1) return `Board online · solved ${j.solves} · wrong entries ${j.wrongs} · code below${l1Keys.keys ? `<br><span class="muted">Keypad last sent:</span> <b class="mono">${esc(l1Keys.keys.split('').join(' '))}</b>` : ''}${l1Keys.lastWrong ? ` · <span class="muted">last wrong entry:</span> <b class="mono bad-t">${esc(l1Keys.lastWrong)}</b>` : ''}`;
  if (l === 2) return `Board online · bridge <b class="mono">${Number(j.volts).toFixed(3)} V</b> (A ${Math.round(j.mvA)} mV − B ${Math.round(j.mvB)} mV) · balanced within ±${Math.round(j.window)} mV · ${j.unlocked ? '<b class="ok">UNLOCKED</b>' : 'locked'}`;
  if (l === 4) return `Board online · lamps lit ${(j.led || []).filter(Boolean).length}/6 · ${j.solved ? '<b class="ok">ALL ON</b>' : 'not solved'}`;
  if (l === 5) return `Board online · ${['idle', 'running', '<b class="ok">SUCCESS</b>'][j.state] || '?'} · ${Number(j.f).toFixed(2)} Hz · stable ${Number(j.hold).toFixed(1)}/${j.HOLD} s · turbine ${j.fan > 0 ? Math.round(j.fan / 2.55) + '%' : j.state ? 'stalled' : 'off'} · board team ${j.team}`;
  if (l === 6) return `Board online · AZ-5 ${['idle', 'clock running ' + fmtClock(j.left * 1000), '<b class="ok">BUTTON PRESSED</b>', '<b class="bad">TIME RAN OUT</b>'][j.l6] || '?'}`;
  return '';
}

function renderStations(c) {
  const sc = S.settings.scoring;
  c.innerHTML = `<div class="cards">${LV.map((l) => {
    const t = seated(l);
    const rec = t?.levels[l];
    const st = t ? shownStatus(rec) : 'waiting';
    const pts = t ? (['playing', 'waiting', 'found'].includes(rec.status)
      ? sc.base - rec.attempts * sc.wrong - rec.hints * sc.hint
      : t.points[l]) : '–';
    const devBtns = {
      1: `<button class="btn btn-ghost btn-sm" data-cmd="st1|/api/newcode?key=${key()}">New code</button>`,
      5: `<button class="btn btn-ghost btn-sm" data-cmd="st56|g5start">Start grid</button><button class="btn btn-ghost btn-sm" data-cmd="st56|/api/stop?key=${key()}">Stop grid</button>`,
      6: `<button class="btn btn-ghost btn-sm" data-cmd="st56|l6start">Re-sync room clock to board</button><button class="btn btn-ghost btn-sm" data-cmd="st56|/api/event/stop?key=${key()}">Stop / silence</button>`,
    }[l] || '';
    return `<article class="card" id="card${l}" data-s="${st}">
      <div class="card-head"><span class="plate">${l}</span>
        <div class="grow"><h3>${esc(LEVEL_INFO[l].name)}</h3><p>${STATUS_TEXT[st]}${rec?.hints ? ' · ' + rec.hints + ' hint(s)' : ''}</p></div>
        <span class="readout big ${st === 'solved' ? 'done' : ''}" title="Time spent on this level">${rec?.startedAt ? fmtClock(elapsedMs(rec)) : '--:--'}</span></div>
      <div class="card-body">
        <p style="margin:0">Team: <b>${t ? `#${t.no} ${esc(t.name)}` : '—'}</b></p>
        <dl class="stats">
          <div><dt>Attempts</dt><dd>${rec ? rec.attempts : 0}/${sc.maxAttempts}</dd></div>
          <div><dt>Hints</dt><dd>${rec ? rec.hints : 0}</dd></div>
          <div><dt>Penalty</dt><dd>${rec ? -(rec.attempts * sc.wrong + rec.hints * sc.hint) : 0}</dd></div>
          <div><dt>${rec && !['playing', 'waiting', 'found'].includes(rec.status) ? 'Points' : 'If solved now'}</dt><dd>${pts}</dd></div>
        </dl>
        <div style="font-size:15px">${boardLine(l)}</div>
        ${(() => { const a = answerFor(l, t); return a ? `<div class="kv"><span>Answer${a.note ? ` <small class="muted">· ${esc(a.note)}</small>` : ''}</span><b class="secret mono answer-code">${esc(a.code)}</b></div>` : ''; })()}
        ${l !== 6 || S.settings.answers[6] ? `<form class="row" data-answer="${l}"><input class="inp grow mono" placeholder="Code the team found" style="max-width:220px" autocomplete="off"><button class="btn" type="submit">Enter code</button></form>` : ''}
        ${l === 3 ? '<a class="btn btn-ghost btn-sm" href="/level3-logs" target="_blank" style="justify-self:start">Print Level 3 log sheets</a>' : ''}
      </div>
      <div class="card-foot">
        <button class="btn btn-go btn-sm" data-act="start|${l}">Start</button>
        <button class="btn btn-warn btn-sm" data-act="pause|${l}">Pause</button>
        <button class="btn btn-sm" data-act="wrong|${l}">Wrong</button>
        <button class="btn btn-sm" data-act="hint|${l}">Hint</button>
        ${l !== 1 && l !== 6 ? `<button class="btn btn-sm" data-act="found|${l}" title="Task finished; points come when the code is entered">Task done</button>` : ''}
        <button class="btn btn-go btn-sm" data-act="solve|${l}">Solved</button>
        <button class="btn btn-danger btn-sm" data-act="open|${l}">Give up · open</button>
        ${l === 1 ? `<button class="btn btn-ghost btn-sm" data-act="skip|1">Skip</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="reset|${l}">Reset</button>
        ${devBtns}
      </div></article>`;
  }).join('')}</div>`;

  $$('[data-act]', c).forEach((b) => b.addEventListener('click', async () => {
    const [a, l] = b.dataset.act.split('|');
    const ask = { open: 'Open this level for the team (time-over penalty)?', reset: 'Reset this level for this team?', skip: 'Team skips Level 1 for good?' }[a];
    if (ask && !confirm(ask)) return;
    if (await run(a, { level: Number(l) }, 'Done')) refresh();
  }));
  $$('[data-answer]', c).forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const l = Number(f.dataset.answer);
    let boardCode = '';
    try {
      if (l === 1 && S.settings.devices.st1.enabled) boardCode = (await devGet(S.settings.devices.st1, `/api/answer?key=${key()}`)).code || '';
      if (l === 5) boardCode = devs.st56?.data?.code || '';
    } catch {}
    const r = await run('answer', { level: l, value: f.querySelector('input').value, boardCode });
    if (r) { toast(r.correct ? `Correct: Level ${l} solved${r.points !== undefined ? `, ${r.points} points` : ''}` : `Wrong code: ${r.attemptsLeft} attempt(s) left`, !r.correct); refresh(); }
  }));
  $$('[data-cmd]', c).forEach((b) => b.addEventListener('click', () => {
    const [bd, p] = b.dataset.cmd.split('|');
    if (p.startsWith('/')) boardCmd(bd, p); else stationCmd(p);
  }));
}

function stationCmd(which) {
  const l = which === 'g5start' ? 5 : 6;
  const t = seated(l);
  if (!t) return toast(`Assign a team to Level ${l} first`, true);
  const n = ((t.no - 1) % 10) + 1; // lfc.ino takes team 1..10
  boardCmd('st56', which === 'g5start'
    ? `/api/start?team=${n}&key=${key()}`
    : `/api/event/start?team=${n}&secs=${Math.max(1, Math.ceil(runLeftMs(t, S.settings) / 1000))}&key=${key()}`);
}

async function boardCmd(bd, path, quiet = false) {
  const d = S?.settings.devices[bd];
  if (!d?.enabled) return quiet || toast('That board is disabled on the Devices page', true);
  try { await devGet(d, path, 2500); if (!quiet) toast('Board: OK'); }
  catch (e) { if (!quiet) toast('Board did not answer: ' + e.message, true); }
}

// ----- teams -----
function renderTeams(c) {
  const teams = [...S.teams].sort((a, b) => a.no - b.no);
  c.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <h2 class="grow" style="font-size:22px">Registered teams (${teams.length})</h2>
      <label class="row" style="gap:6px"><input type="checkbox" id="regOpen" ${S.settings.registrationOpen ? 'checked' : ''}> Registration open</label>
      <a class="btn btn-ghost btn-sm" href="/register" target="_blank">Open registration page</a>
    </div>
    <details class="drawer" style="margin-bottom:14px"><summary>Add a team by hand</summary>
      <form id="addTeam" class="fields" style="margin-top:10px">
        <label class="field">Team name<input name="name" required maxlength="40"></label>
        <label class="field">Member 1<input name="m1" required maxlength="40"></label>
        <label class="field">Member 2<input name="m2" required maxlength="40"></label>
        <label class="field">Member 3 (optional)<input name="m3" maxlength="40"></label>
        <label class="field">Member 4 (optional)<input name="m4" maxlength="40"></label>
        <label class="field">College<input name="college"></label>
        <label class="field">Contact<input name="contact"></label>
        <button class="btn btn-go" type="submit" style="align-self:end">Add team</button>
      </form></details>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">#</th><th>Team</th><th>Members</th><th>College</th><th>Contact</th><th>Registered</th><th>Progress</th><th></th></tr></thead>
      <tbody>${teams.map((t) => `<tr>
        <td class="num">${t.no}</td><td><b>${esc(t.name)}</b></td><td>${t.members.map(esc).join(', ')}</td>
        <td>${esc(t.college || '')}</td><td>${esc(t.contact || '')}</td>
        <td class="mono">${new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${LV.map((l) => `<span class="lamp ${{ solved: 'ok', skipped: 'ok', playing: 'warn', found: 'warn', failed: 'bad', forced: 'bad' }[t.levels[l].status] || ''}" title="L${l}: ${STATUS_TEXT[t.levels[l].status]}"></span>`).join(' ')}</td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${t.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-resetteam="${t.id}">Reset scores</button>
          <button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No teams yet.</td></tr>'}</tbody>
    </table></div>`;

  $('#regOpen').addEventListener('change', async (e) => { await run('settings', { patch: { registrationOpen: e.target.checked } }, 'Saved'); refresh(); });
  $('#addTeam').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const members = ['m1', 'm2', 'm3', 'm4'].map((k) => f.get(k).trim()).filter(Boolean);
    const r = await run('teamAdd', { name: f.get('name'), members, college: f.get('college'), contact: f.get('contact') });
    if (r) { toast(`Team #${r.team.no} added`); await refresh(); renderTab(true); }
  });
  $$('[data-edit]', c).forEach((b) => b.addEventListener('click', () => editTeam(teamById(b.dataset.edit))));
  $$('[data-del]', c).forEach((b) => b.addEventListener('click', async () => {
    const t = teamById(b.dataset.del);
    if (!confirm(`Delete team #${t.no} ${t.name} and all its results?`)) return;
    if (await run('teamDelete', { id: t.id }, 'Team deleted')) { await refresh(); renderTab(true); }
  }));
  $$('[data-resetteam]', c).forEach((b) => b.addEventListener('click', async () => {
    const t = teamById(b.dataset.resetteam);
    if (!confirm(`Clear every level result for #${t.no} ${t.name}?`)) return;
    if (await run('teamResetAll', { id: t.id }, 'Team reset')) { await refresh(); renderTab(true); }
  }));
}

function editTeam(t) {
  const dlg = document.createElement('dialog');
  dlg.className = 'panel';
  dlg.style.maxWidth = '480px';
  dlg.innerHTML = `<form method="dialog" style="display:grid;gap:12px">
    <h2 style="font-size:24px">Edit team #${t.no}</h2>
    <label class="field">Team name<input name="name" value="${esc(t.name)}" required></label>
    <label class="field">Members (comma separated, 2–4)<input name="members" value="${esc(t.members.join(', '))}"></label>
    <label class="field">College<input name="college" value="${esc(t.college || '')}"></label>
    <label class="field">Contact<input name="contact" value="${esc(t.contact || '')}"></label>
    <div class="row"><button class="btn btn-go" value="save">Save</button><button class="btn btn-ghost" value="cancel">Cancel</button></div></form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'save') {
      const f = new FormData(dlg.querySelector('form'));
      const ok = await run('teamEdit', { id: t.id, name: f.get('name'), members: f.get('members').split(',').map((s) => s.trim()).filter(Boolean), college: f.get('college'), contact: f.get('contact') }, 'Saved');
      if (ok) { await refresh(); renderTab(true); }
    }
    dlg.remove();
  });
  dlg.showModal();
}

// ----- leaderboard -----
function ranked() {
  return [...S.teams].sort((a, b) => b.totals.points - a.totals.points || a.totals.timeMs - b.totals.timeMs);
}

function renderBoard(c) {
  const rows = ranked();
  c.innerHTML = `<div class="row" style="margin-bottom:12px"><h2 class="grow" style="font-size:22px">Leaderboard</h2>
      <button class="btn btn-ghost btn-sm" id="csv">Download scores (CSV)</button></div>
    <p class="note">Points: ${S.settings.scoring.base} per level solved, minus penalties, plus a finish bonus of up to ${S.settings.scoring.bonus} (scaled by the time left when AZ-5 is pressed). Ties are broken by time used (each wrong attempt adds ${S.settings.scoring.wrongSecs} s).</p>
    <div class="table-wrap"><table><thead><tr><th class="num">Rank</th><th>Team</th>${LV.map((l) => `<th class="num">L${l}</th>`).join('')}<th class="num">Bonus</th><th class="num">Points</th><th class="num">Time used</th></tr></thead>
    <tbody>${rows.map((t, i) => `<tr><td class="num">${i + 1}</td><td><b>#${t.no} ${esc(t.name)}</b>${t.totals.finished ? ' <span class="ok-t">✔ finished</span>' : t.totals.timeout ? ' <span class="bad-t">time up</span>' : ''}</td>
      ${LV.map((l) => {
        const s = t.levels[l].status;
        return `<td class="num" title="${STATUS_TEXT[s]}">${s === 'waiting' ? '–' : s === 'skipped' ? 'skip' : t.points[l]}</td>`;
      }).join('')}
      <td class="num">${t.totals.bonus || '–'}</td><td class="num"><b>${t.totals.points}</b></td><td class="num mono">${fmtClock(t.totals.usedMs)}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">No teams yet.</td></tr>'}</tbody></table></div>`;
  $('#csv').addEventListener('click', exportCSV);
}

function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Rank', 'Team no', 'Team', 'Members', 'College', 'Contact', ...LV.flatMap((l) => [`L${l} status`, `L${l} points`, `L${l} time (s)`, `L${l} wrong`, `L${l} hints`]), 'Total points', 'Total time (s)'];
  const lines = [head.map(q).join(',')];
  ranked().forEach((t, i) => {
    lines.push([i + 1, t.no, t.name, t.members.join('; '), t.college, t.contact,
      ...LV.flatMap((l) => { const r = t.levels[l]; return [r.status, t.points[l], Math.round(elapsedMs(r) / 1000), r.attempts, r.hints]; }),
      t.totals.points, Math.round(t.totals.timeMs / 1000)].map(q).join(','));
  });
  download(`blackout-scores-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`, lines.join('\n'), 'text/csv');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ----- devices -----
function renderDevices(c) {
  const d = S.settings.devices;
  c.innerHTML = `<h2 style="font-size:22px;margin-bottom:6px">How laptops reach the boards</h2>
    <form id="linkForm" class="row" style="margin-bottom:8px">
      <label class="row" style="gap:6px"><input type="radio" name="link" value="bridge" ${S.settings.boardLink !== 'direct' ? 'checked' : ''}> <b>Through the Mac bridge</b></label>
      <label class="row" style="gap:6px"><input type="radio" name="link" value="direct" ${S.settings.boardLink === 'direct' ? 'checked' : ''}> <b>Directly</b> (every laptop on PuzzleBox)</label>
      <span id="bridgeTxt" class="muted" style="font-size:14px"></span>
    </form>
    <p class="note">Bridge: only the Mac joins PuzzleBox and runs <code>npm run bridge -- ${esc(location.origin)}</code>; station laptops can be on any internet connection. Use this with the Vercel site.</p>
    <h2 style="font-size:22px;margin:18px 0 6px">ESP32 boards</h2>
    <p class="note"> Each board prints its IP address on the Serial Monitor (115200 baud) when it connects. Type it here and save; every station laptop picks it up within a few seconds.
    The boards and the Mac (bridge mode) or every laptop (direct mode) join the PuzzleBox hotspot.
    Windows Mobile Hotspot gives addresses like <span class="mono">192.168.137.x</span>; you can also see connected devices in Windows Settings → Mobile hotspot.</p>
    <form id="devForm"><div class="table-wrap"><table>
      <thead><tr><th>Board</th><th>Used</th><th>IP address</th><th>Port</th><th>Status</th><th></th></tr></thead>
      <tbody>${Object.keys(BOARD_NAMES).map((k) => `<tr>
        <td><b>${BOARD_NAMES[k]}</b></td>
        <td><input type="checkbox" name="${k}.enabled" ${d[k].enabled ? 'checked' : ''} aria-label="Board used"></td>
        <td><input class="inp mono" name="${k}.ip" value="${esc(d[k].ip)}" style="min-width:150px" inputmode="decimal" aria-label="IP address"></td>
        <td><input class="inp mono" name="${k}.port" value="${d[k].port}" style="width:6em" inputmode="numeric" aria-label="Port"></td>
        <td id="dst-${k}">…</td>
        <td><a class="btn btn-ghost btn-sm" href="http://${esc(d[k].ip)}${Number(d[k].port) !== 80 ? ':' + d[k].port : ''}/api/state" target="_blank">Open</a></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="row" style="margin-top:12px"><button class="btn btn-go" type="submit">Save IP addresses</button>
      <span class="muted" style="font-size:14px">Level 3 is a paper station and has no board.</span></div></form>`;
  $$('#linkForm input').forEach((r) => r.addEventListener('change', async () => {
    if (await run('settings', { patch: { boardLink: r.value } }, r.value === 'bridge' ? 'Boards now go through the Mac bridge' : 'Laptops now talk to the boards directly')) { await refresh(); renderTab(true); }
  }));
  $('#devForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const patch = {};
    for (const k of Object.keys(BOARD_NAMES)) patch[k] = { ip: f.get(k + '.ip'), port: f.get(k + '.port'), enabled: f.get(k + '.enabled') === 'on' };
    if (await run('settings', { patch: { devices: patch } }, 'IP addresses saved')) { await refresh(); renderTab(true); }
  });
  updateDeviceStatus();
}

function updateDeviceStatus() {
  const bt = $('#bridgeTxt');
  if (bt) bt.innerHTML = !viaBridge() ? '' : !bridge ? 'checking the bridge…'
    : bridge.alive ? '<span class="lamp ok"></span> bridge running' : '<span class="lamp bad"></span> bridge not running';
  for (const k of Object.keys(BOARD_NAMES)) {
    const el = document.getElementById('dst-' + k);
    if (!el) continue;
    const d = devs[k];
    if (!S.settings.devices[k].enabled) el.innerHTML = '<span class="lamp"></span> not used';
    else if (!d || d.ok === null) el.innerHTML = '<span class="lamp"></span> checking…';
    else if (d.ok) el.innerHTML = `<span class="lamp ok"></span> online${d.data.rssi ? ` · signal ${d.data.rssi} dBm` : ''}${d.data.uptime ? ` · up ${fmtClock(d.data.uptime * 1000)}` : ''}`;
    else el.innerHTML = `<span class="lamp bad"></span> offline · ${esc(d.err)}${d.at ? ` · last seen ${Math.round((Date.now() - d.at) / 1000)} s ago` : ''}`;
  }
}

// ----- setup -----
function renderSetup(c) {
  const s = S.settings;
  const num = (name, val, label) => `<label class="field">${label}<input name="${name}" type="number" min="0" value="${val}"></label>`;
  c.innerHTML = `<form id="setupForm">
    <h2 style="font-size:22px">Answer key</h2>
    <p class="note">Hidden until you press <b>Show answers</b>. Teams score a level only when they enter its code. Leave <b>L1</b> empty to check against the board's current Morse code, and <b>L5</b> empty to use the code the grid board showed the team (<span class="mono">CODES[]</span> in lfc.ino). <b>L4</b> is the fixed switch code (302). Level 3's answer also sets the printed log sheets. L6 only needs a code if the final lock code should be typed in too.</p>
    <div class="fields">${LV.map((l) => `<label class="field">L${l} ${esc(LEVEL_INFO[l].name)}<input name="ans${l}" value="${esc(s.answers[l])}" class="secret mono" autocomplete="off"></label>`).join('')}</div>
    <h2 style="font-size:22px;margin-top:20px">Room clock</h2>
    <p class="note">One clock for the whole escape room. It starts with the first level. If it runs out, the siren sounds and the team's run ends.</p>
    <div class="fields">${num('runLimit', s.runLimit / 60, 'Total time (minutes)')}</div>
    <h2 style="font-size:22px;margin-top:20px">Scoring</h2>
    <div class="fields">
      ${num('base', s.scoring.base, 'Base points per level')}${num('bonus', s.scoring.bonus, 'Max finish bonus')}
      ${num('wrong', s.scoring.wrong, 'Points lost per wrong attempt')}${num('wrongSecs', s.scoring.wrongSecs, 'Seconds added per wrong attempt')}
      ${num('hint', s.scoring.hint, 'Points lost per hint')}${num('timeOver', s.scoring.timeOver, 'Open-box penalty')}
      ${num('maxAttempts', s.scoring.maxAttempts, 'Attempts per level')}</div>
    <h2 style="font-size:22px;margin-top:20px">Logins and board key</h2>
    <div class="fields">
      ${['st1', 'st2', 'st4', 'st56'].map((k) => `<label class="field">${k.replace('st', 'Station ').replace('56', '5+6')} password<input name="pw.${k}" value="${esc(s.passwords[k])}" class="secret" autocomplete="off"></label>`).join('')}
      <label class="field">New master password<input name="masterPassword" type="password" placeholder="leave blank to keep" autocomplete="new-password"></label>
      <label class="field">Board key (KEY in lfc.ino)<input name="deviceKey" value="${esc(s.deviceKey)}" class="secret mono" autocomplete="off"></label>
    </div>
    <div class="row" style="margin-top:16px"><button class="btn btn-go" type="submit">Save setup</button></div>
  </form>
  <h2 style="font-size:22px;margin-top:26px">Data</h2>
  <div class="row">
    <button class="btn btn-ghost" id="backup">Download backup</button>
    <label class="btn btn-ghost">Restore backup…<input type="file" id="restore" accept="application/json" hidden></label>
    <button class="btn btn-danger" id="erase">Erase all teams and results</button>
  </div>`;

  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const patch = {
      answers: Object.fromEntries(LV.map((l) => [l, f.get('ans' + l)])),
      runLimit: Math.round(Number(f.get('runLimit')) * 60),
      scoring: Object.fromEntries(['base', 'bonus', 'wrong', 'wrongSecs', 'hint', 'timeOver', 'maxAttempts'].map((k) => [k, Number(f.get(k))])),
      passwords: Object.fromEntries(['st1', 'st2', 'st4', 'st56'].map((k) => [k, f.get('pw.' + k)])),
      deviceKey: f.get('deviceKey'),
    };
    if (f.get('masterPassword')) patch.masterPassword = f.get('masterPassword');
    if (await run('settings', { patch }, 'Setup saved')) { await refresh(); renderTab(true); }
  });
  $('#backup').addEventListener('click', () => {
    const data = { settings: S.settings, seat: S.seat, nextNo: S.nextNo, log: S.log,
      teams: S.teams.map(({ totals, points, ...t }) => t) };
    download(`blackout-backup-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`, JSON.stringify(data, null, 1), 'application/json');
  });
  $('#restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.teams)) throw new Error('Not a Blackout backup file');
      if (!confirm(`Replace everything with this backup (${data.teams.length} teams)?`)) return;
      if (await run('restore', { data }, 'Backup restored')) { await refresh(); renderTab(true); }
    } catch (err) { toast(err.message, true); }
  });
  $('#erase').addEventListener('click', async () => {
    if (!confirm('Erase ALL teams, results and the log? Settings are kept.')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    if (await run('eraseAll', {}, 'Erased')) { await refresh(); renderTab(true); }
  });
}

// ----- log -----
function renderLog(c) {
  c.innerHTML = `<h2 style="font-size:22px;margin-bottom:10px">Event log</h2>
    <div class="table-wrap"><table><tbody>${S.log.map((e) => `<tr><td class="mono" style="white-space:nowrap">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</td>
      <td>${e.level ? 'L' + e.level : ''}</td><td>${esc(e.msg)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`;
}

// ---------- boards (read-only here; station laptops relay results) ----------
async function pollBoards() {
  if (S && viaBridge()) {
    try { const snap = await bridgeSnapshot(); bridge = { alive: bridgeAlive(snap), at: snap.at, now: snap.now }; } catch {}
  }
  if (S) {
    await Promise.all(Object.keys(BOARD_NAMES).map(async (k) => {
      const d = S.settings.devices[k];
      if (!d.enabled) { devs[k] = { ok: null }; return; }
      try {
        const j = await devGet(d, '/api/state');
        devs[k] = { ok: true, data: j, at: Date.now() };
      } catch (e) {
        devs[k] = { ...devs[k], ok: false, err: e.name === 'AbortError' ? 'timeout' : e.message };
      }
    }));
    if (devs.st1?.ok) {
      try {
        const a = await devGet(S.settings.devices.st1, `/api/answer?key=${key()}`);
        l1Code = a.code || '';
        l1Keys = { keys: a.keys || '', lastWrong: a.lastWrong || '' };
      } catch {}
    }
    renderMimic();
    if (tab === 'devices') updateDeviceStatus();
  }
  setTimeout(pollBoards, viaBridge() ? 1000 : 2000);
}

await refresh();
renderTab(true);
setInterval(refresh, 2000);
pollBoards();
