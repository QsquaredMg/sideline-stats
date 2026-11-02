(function () {
  'use strict';
  const U = window.UI;
  const { $, $$, esc, api } = U;
  const Engine = window.StatEngine, Sports = window.StatSports;
  const code = location.pathname.split('/')[2];
  const store = U.safeStorage();

  const qp = new URLSearchParams(location.search);
  if (qp.get('key')) { store.setItem(`key:${code}`, qp.get('key')); history.replaceState(null, '', location.pathname); }

  const state = {
    key: store.getItem(`key:${code}`) || '', admin: '',
    data: null, sport: null, c: null,
    team: null, sel: null, period: 1,
    queue: [], rejected: [], online: true, flushing: false, authError: false,
    sheet: null,
    clock: null,   // { period, elapsed, running, at } once the keeper has set or started the game clock for this period
  };
  try { state.queue = JSON.parse(store.getItem(`queue:${code}`) || '[]'); } catch (e) { state.queue = []; }
  const saveQueue = () => store.setItem(`queue:${code}`, JSON.stringify(state.queue));

  const newId = () => {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  };
  const hdr = () => {
    const h = { 'x-keeper-key': state.key };
    if (state.admin) h['x-admin-pin'] = state.admin;
    return h;
  };
  const isFinal = () => state.data.game.status === 'final';
  const canEdit = () => !!state.key && (!isFinal() || !!state.admin);
  const players = () => state.data.players;
  const playerById = (id) => players().find((p) => p.id === id);
  const plabel = (p) => `#${p.jersey}${p.name ? ' ' + p.name : ''}`;
  const lastName = (p) => (p.name ? p.name.split(' ').slice(-1)[0] : '');
  const teamOf = (id) => state.data.teams.find((t) => t.id === id);
  const ctx = () => ({ playersById: new Map(players().map((p) => [p.id, p])), homeId: state.data.teams[0].id, awayId: state.data.teams[1].id,
    liveEvents: localEvents().filter((e) => /^dec_/.test(e.type)) });

  /* ---------- game clock ----------
   * Stored as seconds ELAPSED in the period (what the server keeps). The keeper reads and types the time
   * exactly as the scoreboard shows it, and this converts: countdown clocks (basketball, football) are
   * length minus elapsed, count-up clocks (soccer) are elapsed. The clock only stamps plays once it has been
   * set or started, so a play is never given a made-up time. */
  const periodLen = () => Sports.periodLength(state.sport, state.period) || 3600;
  function clockElapsed() {
    const k = state.clock;
    if (!k || k.period !== state.period) return null;
    const live = k.running ? (Date.now() - k.at) / 1000 : 0;
    return Math.max(0, Math.min(periodLen(), Math.floor(k.elapsed + live)));
  }
  function clockSetElapsed(sec, running) {
    state.clock = { period: state.period, elapsed: Math.max(0, Math.min(periodLen(), sec)), running: !!running, at: Date.now() };
    store.setItem(`clock:${code}`, JSON.stringify(state.clock));
  }
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const toShownFor = (e) => (state.sport.clockDir === 'down' ? (Sports.periodLength(state.sport, e.period) || 3600) - e.clock_s : e.clock_s);
  const toShown = (el) => (state.sport.clockDir === 'down' ? periodLen() - el : el);
  const fromShown = (sh) => (state.sport.clockDir === 'down' ? periodLen() - sh : sh);
  function clockHTML() {
    if (!state.sport.clock) return '';
    const el = clockElapsed();
    const k = state.clock && state.clock.period === state.period ? state.clock : null;
    return `<div class="clockbar"><span class="clk num" id="clk" aria-label="Game clock">${el === null ? '--:--' : mmss(toShown(el))}</span>
      <button class="btn small" data-act="clockrun" ${canEdit() ? '' : 'disabled'}>${k && k.running ? 'Stop' : 'Start'}</button>
      <button class="btn small quiet" data-act="clockset" ${canEdit() ? '' : 'disabled'}>Set clock</button>
      <span class="muted small">${el === null ? 'Not set. Plays are saved without a time.' : (state.sport.clockDir === 'down' ? 'counting down' : 'counting up')}</span></div>`;
  }
  setInterval(() => {
    const el = $('#clk');
    if (!el || !state.clock || !state.clock.running) return;
    const e = clockElapsed();
    if (e !== null) el.textContent = mmss(toShown(e));
  }, 500);
  const stampClock = (payload) => { const e = clockElapsed(); if (e !== null && state.sport.clock) payload.clock_s = e; };

  /* ---------- derived state ---------- */
  function localEvents() {
    const pend = state.queue.map((q, i) => Object.assign({ id: 1e12 + i, client_id: q.client_id, voided: false, pending: true, entered_by: 'keeper', created_at: q.ts }, q.event));
    return state.data.events.concat(pend);
  }
  function recompute() {
    const ce = clockElapsed();
    state.c = Engine.computeGame({
      sport: state.sport, format: state.data.game.format, teams: state.data.teams, players: players(), events: localEvents(),
      final: isFinal(), currentPeriod: state.period, liveClock: ce === null ? null : { period: state.period, clock_s: ce },
    });
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg, tone, undo) {
    const t = $('#toast');
    t.className = 'toast' + (tone === 'bad' ? ' bad' : '');
    t.innerHTML = `<span>${msg}</span>${undo ? '<button type="button" data-act="undo">Undo</button>' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), tone === 'bad' ? 7000 : 5000);
  }

  /* ---------- rendering ---------- */
  function render() {
    const { c, sport } = state;
    const game = state.data.game;
    document.title = `Keeper: ${c.teams[0].name} vs ${c.teams[1].name}`;
    const maxP = sport.maxPeriods;
    const cp = state.period;
    const pName = c.periodNames[cp - 1] || Engine.periodName(sport, cp);

    // alerts
    const alerts = [];
    if (!state.key) alerts.push(`<div class="notice bad"><b>This link has no stat-keeper key.</b> You can watch but not enter stats. Open the link the game creator shared with you, or <a href="/g/${esc(code)}">view the public page</a>.</div>`);
    if (state.authError) alerts.push('<div class="notice bad"><b>The stat-keeper key was not accepted.</b> Plays are saved on this phone. Open the original keeper link again.</div>');
    if (isFinal()) alerts.push(`<div class="notice warn"><b>This game is final.</b> ${state.admin ? 'Admin mode is on. Every change needs a reason and is recorded.' : 'Only the athletic department can make changes now.'}</div>`);
    if (state.queue.length) alerts.push(`<div class="notice ${state.online ? '' : 'warn'}"><b>${state.queue.length} ${state.queue.length === 1 ? 'play' : 'plays'} waiting to send.</b> ${state.online ? 'Sending…' : 'No connection. Your plays are saved on this phone and will send on their own.'} <button class="btn small" data-act="retry">Send now</button></div>`);
    for (const r of state.rejected) alerts.push(`<div class="notice bad"><b>Not saved:</b> ${esc(r.text)}. ${esc(r.error)} <button class="btn small" data-act="dismiss">Dismiss</button></div>`);
    for (const w of c.warnings) alerts.push(`<div class="notice warn">${esc(w)}</div>`);
    const checks = Engine.checkCheckpoints(c, state.data.checkpoints);
    if (checks.length) {
      const sum = U.checksSummary(c, checks);
      if (sum.tone === 'warn') alerts.push(`<div class="notice warn">${sum.html} <button class="btn small" data-act="check">Check again</button></div>`);
    }
    if (cp > 1 && !isFinal() && !state.data.checkpoints.some((x) => x.period === cp - 1)) {
      alerts.push(`<div class="notice"><b>${esc(c.periodNames[cp - 2] || '')} has not been checked</b> against the scoreboard. <button class="btn small" data-act="check" data-period="${cp - 1}">Check it</button></div>`);
    }

    // team tabs
    const tabs = c.teams.map((t) => `<button class="tt ${t.side === 'away' ? 'away' : ''}" data-team="${t.id}" aria-pressed="${state.team === t.id}"><b>${esc(t.name)}</b><span>${t.currentRole ? esc(sport.roleLabel) + ': ' + esc(t.currentRole) : (t.side === 'home' ? 'Home' : 'Away')}</span></button>`).join('');

    // players
    const ti = c.teams.findIndex((t) => t.id === state.team);
    const roleLabel = c.teams[ti].currentRole;
    const roster = players().filter((p) => p.team_id === state.team).sort((a, b) => Engine.jerseySort(a.jersey, b.jersey));
    const grid = roster.map((p) => {
      const s = c.playerStats[p.id] || {};
      const chip = sport.chip ? sport.chip(s) : '';
      const warn = sport.chipWarn && sport.chipWarn(s);
      const isRole = roleLabel && roleLabel === plabel(p);
      const onCourt = sport.minutes && c.teams[ti].onCourt.includes(p.id);
      return `<button class="pl ${warn ? 'warn' : ''} ${isRole ? 'role' : ''} ${onCourt ? 'on' : ''}" data-player="${p.id}" aria-pressed="${state.sel === p.id}" aria-label="${esc(plabel(p))}"><span class="j">${esc(p.jersey)}</span><span class="n">${esc(lastName(p))}</span><span class="c">${esc(chip)}</span></button>`;
    }).join('') + (canEdit() ? '<button class="pl add" data-act="addplayer">Add player</button>' : '')
      + (canEdit() && sport.minutes ? `<button class="pl add" data-act="lineup">${c.teams[ti].lineupTracked ? 'Subs' : 'Starters'}</button>` : '');

    // actions
    const sel = state.sel ? playerById(state.sel) : null;
    const groups = [];
    for (const e of sport.events) if (!e.hidden && !groups.includes(e.group)) groups.push(e.group);
    const disabled = !canEdit();
    const abuttons = groups.map((g) => {
      const evs = sport.events.filter((e) => e.group === g && !e.hidden);
      const btns = evs.map((e) => {
        const needsPlayer = e.scope !== 'team';
        const soft = needsPlayer && !sel;
        return `<button class="act ${e.tone}" data-ev="${e.id}" ${disabled ? 'disabled' : ''} aria-disabled="${soft}">${esc(e.label)}${e.badge ? `<small>${esc(e.badge)}</small>` : ''}</button>`;
      }).join('');
      return `<div class="agroup"><h3>${esc(g)}</h3><div class="agrid">${btns}</div></div>`;
    }).join('');
    const forline = sel ? `Logging for <b>${esc(plabel(sel))}</b> (${esc(teamOf(sel.team_id).name)})` : 'Tap a player above, then tap what they did.';

    // log
    const recent = c.log.filter((e) => !e.voided).slice(-12).reverse();
    const logItems = recent.length ? `<ol class="plays klog-list">${recent.map((e) => `<li><span class="when">${esc(c.periodNames[e.period - 1] || '')}${e.clock_s === null || e.clock_s === undefined ? '' : ' ' + mmss(toShownFor(e))}</span><span class="what"><span class="tm ${e.team_id === c.teams[1].id ? 'away' : ''}" aria-hidden="true"></span>${U.playText(e)}${e.pending ? ' <span class="muted small">(sending)</span>' : ''}</span><span class="pts">${e.pts ? '+' + e.pts : ''}</span><button class="btn small quiet x" data-void="${esc(e.client_id)}" aria-label="Remove this play">Remove</button></li>`).join('')}</ol>` : '<p class="muted">No plays yet.</p>';

    const base = location.origin;
    $('#app').innerHTML = `
      <div class="k-sticky">
        ${U.boardHTML(c, game).replace('class="board"', 'class="board compact"')}
        <div class="pbar">
          <button class="btn" data-act="prevp" aria-label="Previous ${esc(sport.periodWord.toLowerCase())}" ${cp <= 1 ? 'disabled' : ''}>&lsaquo;</button>
          <div class="plabel">${esc(pName)}<small>${esc(sport.periodWord)} ${cp}${sport.allowOT ? '' : ' of ' + sport.periods}</small></div>
          <button class="btn" data-act="nextp" aria-label="Next ${esc(sport.periodWord.toLowerCase())}" ${cp >= maxP ? 'disabled' : ''}>&rsaquo;</button>
        </div>
        ${clockHTML()}
      </div>
      ${alerts.join('')}
      <div class="teamtabs" role="group" aria-label="Team">${tabs}</div>
      <div class="pgrid" id="pgrid" role="group" aria-label="Players">${grid}</div>
      <div class="forline ${sel ? '' : 'need'}" id="forline" aria-live="polite">${forline}</div>
      ${abuttons}
      <div class="ktools">
        <button class="btn" data-act="undo" ${canEdit() ? '' : 'disabled'}>Undo last play</button>
        <button class="btn" data-act="check" ${state.key && !isFinal() ? '' : 'disabled'}>Check scoreboard</button>
        ${isFinal() ? (state.admin ? '<button class="btn danger" data-act="reopen">Reopen game</button>' : '') : `<button class="btn danger" data-act="finish" ${state.key ? '' : 'disabled'}>End game</button>`}
        ${state.admin ? '' : '<button class="btn quiet" data-act="admin">Admin</button>'}
      </div>
      <section class="klog"><h2>Latest plays</h2>${logItems}</section>
      <details class="share"><summary>Links and sharing</summary>
        <div class="field"><label>Public link for fans and parents</label><div class="row"><input type="text" readonly value="${esc(base)}/g/${esc(code)}" id="pl-link"><button class="btn" data-copy="pl-link">Copy</button></div></div>
        ${state.key ? `<div class="field"><label>Stat-keeper link (private)</label><div class="row"><input type="text" readonly value="${esc(base)}/k/${esc(code)}?key=${esc(state.key)}" id="kl-link"><button class="btn" data-copy="kl-link">Copy</button></div><p class="hint">Anyone with this link can enter stats.</p></div>` : ''}
        <p><a href="/rules/${esc(sport.id)}">How ${esc(sport.name.toLowerCase())} stats are counted</a></p>
      </details>`;
  }

  /* ---------- committing plays ---------- */
  function describe(def, p1, p2, value) {
    let s = def.scope === 'team' ? `${esc(teamOf(state.team).name)}: ${esc(def.label)}` : `${esc(plabel(p1))}: ${esc(def.label)}`;
    if (p2) s += ` (${esc(def.secondary.prompt.toLowerCase())} ${esc(plabel(p2))})`;
    if (def.value && value !== null && value !== undefined) {
      const ch = def.value.kind === 'choice' ? def.value.choices.find((x) => x.value === value) : null;
      s += ch ? `, ${esc(ch.label.toLowerCase())}` : `, ${value}`;
    }
    return s;
  }

  function commit(def, p1, p2, value) {
    if (!canEdit()) { toast(isFinal() ? 'This game is final. Use Admin to make a change.' : 'No stat-keeper key on this link.', 'bad'); return false; }
    const payload = { type: def.id, period: state.period };
    stampClock(payload);
    if (def.scope === 'team') payload.team_id = state.team; else payload.player_id = p1.id;
    if (p2) payload.player2_id = p2.id;
    if (value !== null && value !== undefined) payload.value = value;
    const v = Engine.validateEvent(state.sport, payload, ctx());
    if (!v.ok) { toast(esc(v.error), 'bad'); return false; }
    const text = describe(def, p1, p2, v.event.value);
    if (isFinal()) { adminAdd(v.event, text); return true; }
    state.queue.push({ client_id: newId(), event: v.event, ts: new Date().toISOString() });
    saveQueue(); recompute(); render();
    toast(text, '', true);
    flush();
    return true;
  }

  async function adminAdd(event, text) {
    const reason = (window.prompt('Reason for this change (kept on the record):') || '').trim();
    if (!reason) { toast('A reason is required.', 'bad'); return; }
    try {
      await api('POST', `/api/games/${code}/events`, Object.assign({ client_id: newId(), reason }, event), hdr());
      await refresh();
      toast(text);
    } catch (e) { if (e.status === 401) state.admin = ''; toast(esc(e.message), 'bad'); render(); }
  }

  function handleAction(id) {
    const def = state.sport.eventMap[id];
    if (!def) return;
    if (!canEdit()) { toast(isFinal() ? 'This game is final. Use Admin to make a change.' : 'No stat-keeper key on this link.', 'bad'); return; }
    const p1 = state.sel ? playerById(state.sel) : null;
    if (def.scope !== 'team' && !p1) {
      toast('Tap a player first.', 'bad');
      const g = $('#pgrid'); if (g) { g.classList.remove('shake'); void g.offsetWidth; g.classList.add('shake'); }
      return;
    }
    if (!def.secondary && !def.value) { commit(def, p1, null, null); return; }
    openSheet({ mode: 'action', def, p1, p2: null, value: def.value ? def.value.default : null });
  }

  /* ---------- sheet (bottom dialog) ---------- */
  const dlg = $('#sheet');
  function closeSheet() { if (dlg.open) dlg.close(); state.sheet = null; }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
  dlg.addEventListener('close', () => { state.sheet = null; });

  const chipHTML = (p, selected) => `<button class="chip" type="button" data-p2="${p.id}" aria-pressed="${selected}"><span class="j">${esc(p.jersey)}</span><span class="n">${esc(lastName(p) || ' ')}</span></button>`;

  function openSheet(s) {
    state.sheet = s;
    if (s.mode === 'action') drawActionSheet();
    else if (s.mode === 'check') drawCheckSheet();
    else if (s.mode === 'addplayer') drawAddPlayerSheet();
    else if (s.mode === 'finish') drawFinishSheet();
    else if (s.mode === 'clock') drawClockSheet();
    else if (s.mode === 'lineup') drawLineupSheet();
    if (!dlg.open) dlg.showModal();
  }

  function drawActionSheet() {
    const { def, p1, p2, value } = state.sheet;
    const sec = def.secondary;
    let chips = '';
    if (sec) {
      const teamId = sec.team === 'same' ? (p1 ? p1.team_id : state.team) : (p1 ? (p1.team_id === state.data.teams[0].id ? state.data.teams[1].id : state.data.teams[0].id) : null);
      const cand = players().filter((p) => p.team_id === teamId && (!p1 || p.id !== p1.id)).sort((a, b) => Engine.jerseySort(a.jersey, b.jersey));
      chips = `<h3>${esc(sec.prompt)}${sec.team === 'opp' ? ` <span class="muted">(${esc(teamOf(teamId).name)})</span>` : ''}</h3><div class="chips">${cand.map((p) => chipHTML(p, p2 && p2.id === p.id)).join('')}${sec.required ? '' : '<button class="chip none" type="button" data-p2="none"><span class="j">None</span></button>'}</div>`;
    }
    let val = '';
    if (def.value) {
      if (def.value.kind === 'choice') {
        val = `<h3>${esc(def.value.label)}</h3><div class="chips">${def.value.choices.map((c) => `<button class="chip" type="button" data-choice="${c.value}" aria-pressed="${value === c.value}"><span class="j" style="font-size:1.05rem">${esc(c.label)}</span></button>`).join('')}</div>`;
      } else {
        val = `<h3>${esc(def.value.label)}</h3><div class="stepper"><button class="btn" type="button" data-step="-1" aria-label="Minus one">&minus;</button><input type="number" inputmode="numeric" id="valin" value="${value}" min="${def.value.min}" max="${def.value.max}" aria-label="${esc(def.value.label)}"><button class="btn" type="button" data-step="1" aria-label="Plus one">+</button></div>
          <div class="quick">${[-5, 5, 10].map((n) => `<button class="btn small quiet" type="button" data-step="${n}">${n > 0 ? '+' : '&minus;'}${Math.abs(n)}</button>`).join('')}<button class="btn small quiet" type="button" data-setval="0">0</button></div>`;
      }
    }
    const instant = sec && !def.value; // tapping a chip saves right away
    const needs = sec && sec.required && !p2;
    dlg.innerHTML = `<h2 id="sheet-title">${esc(def.label)}</h2><div class="who">${def.scope === 'team' ? esc(teamOf(state.team).name) : esc(plabel(p1))}</div>${chips}${val}
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Cancel</button>${instant ? '' : `<button class="btn primary" type="button" data-sheet="save" ${needs ? 'disabled' : ''}>Save play</button>`}</div>`;
  }

  function saveActionSheet() {
    const s = state.sheet;
    if (s.def.value && s.def.value.kind !== 'choice') {
      const raw = $('#valin') ? $('#valin').value : s.value;
      s.value = raw === '' ? null : Number(raw);
    }
    const def = s.def, p1 = s.p1, p2 = s.p2, value = s.value;
    if (commit(def, p1, p2, value)) closeSheet();
  }

  function drawCheckSheet() {
    const s = state.sheet;
    const c = state.c;
    const sets = c.scoreMode === 'sets';
    const per = c.periodNames[s.period - 1] || '';
    dlg.innerHTML = `<h2 id="sheet-title">Check the scoreboard</h2>
      <p class="muted">Look at the official scoreboard and enter ${sets ? `the points in ${esc(per)}` : `the score after ${esc(per)}`}. Our stats say <b class="num">${s.ours[0]}</b> to <b class="num">${s.ours[1]}</b>.</p>
      <div class="cols two"><div class="field"><label for="ch-h">${esc(c.teams[0].name)}</label><input id="ch-h" type="number" inputmode="numeric" min="0" max="999"></div>
      <div class="field"><label for="ch-a">${esc(c.teams[1].name)}</label><input id="ch-a" type="number" inputmode="numeric" min="0" max="999"></div></div>
      <div id="ch-msg"></div>
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Cancel</button><button class="btn primary" type="button" data-sheet="docheck">Compare</button></div>`;
  }

  function oursFor(period) {
    const c = state.c;
    const [h, a] = c.teams;
    return c.scoreMode === 'sets' ? [h.periodPts[period - 1] || 0, a.periodPts[period - 1] || 0] : [h, a].map((t) => t.periodPts.slice(0, period).reduce((x, y) => x + y, 0));
  }

  async function doCheck() {
    const s = state.sheet;
    const hs = $('#ch-h').value, as = $('#ch-a').value;
    const msg = $('#ch-msg');
    if (hs === '' || as === '') { msg.innerHTML = '<div class="notice bad">Enter both scores.</div>'; return; }
    if (state.queue.length) await flush();
    if (state.queue.length) { msg.innerHTML = '<div class="notice bad">Some plays are still sending. Try again in a moment.</div>'; return; }
    try {
      const r = await api('POST', `/api/games/${code}/checkpoints`, { period: s.period, home: Number(hs), away: Number(as) }, hdr());
      await refresh();
      if (r.result.match) { closeSheet(); toast('Scoreboard matches the stats.'); }
      else {
        const d = r.result.diff;
        const who = (n, name) => (n === 0 ? '' : `${esc(name)} is ${Math.abs(n)} ${n > 0 ? 'short' : 'over'}`);
        const parts = [who(d[0], state.c.teams[0].name), who(d[1], state.c.teams[1].name)].filter(Boolean).join(' and ');
        msg.innerHTML = `<div class="notice warn"><b>Doesn't match.</b> The scoreboard shows ${r.result.official[0]} to ${r.result.official[1]}; the stats add up to ${r.result.ours[0]} to ${r.result.ours[1]}. ${parts}. Look for a missed or doubled play, fix it, then check again.</div>`;
      }
    } catch (e) { msg.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  }

  function drawAddPlayerSheet() {
    const t = state.data.teams;
    dlg.innerHTML = `<h2 id="sheet-title">Add a player</h2>
      <div class="field"><label for="np-team">Team</label><select id="np-team"><option value="${t[0].id}" ${state.team === t[0].id ? 'selected' : ''}>${esc(t[0].name)}</option><option value="${t[1].id}" ${state.team === t[1].id ? 'selected' : ''}>${esc(t[1].name)}</option></select></div>
      <div class="cols two"><div class="field"><label for="np-j">Jersey number</label><input id="np-j" type="text" maxlength="4" inputmode="numeric"></div>
      <div class="field"><label for="np-n">Name (optional)</label><input id="np-n" type="text" maxlength="40"></div></div>
      <div id="np-msg"></div>
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Cancel</button><button class="btn primary" type="button" data-sheet="addplayer">Add player</button></div>`;
  }

  async function doAddPlayer() {
    try {
      await api('POST', `/api/games/${code}/players`, { team_id: Number($('#np-team').value), jersey: $('#np-j').value, name: $('#np-n').value }, hdr());
      await refresh(); closeSheet(); toast('Player added.');
    } catch (e) { $('#np-msg').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  }

  /* ---------- clock sheet ---------- */
  function drawClockSheet() {
    const sh = state.sheet.shown;
    const down = state.sport.clockDir === 'down';
    dlg.innerHTML = `<h2 id="sheet-title">Set the game clock</h2>
      <p class="muted">Type the time exactly as the scoreboard shows it for ${esc(state.c.periodNames[state.period - 1] || '')}. It ${down ? 'counts down' : 'counts up'}.</p>
      <div class="cols two"><div class="field"><label for="clk-m">Minutes</label><input id="clk-m" type="number" inputmode="numeric" min="0" max="${Math.floor(periodLen() / 60)}" value="${Math.floor(sh / 60)}"></div>
      <div class="field"><label for="clk-s">Seconds</label><input id="clk-s" type="number" inputmode="numeric" min="0" max="59" value="${sh % 60}"></div></div>
      <div id="clk-msg"></div>
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Cancel</button><button class="btn primary" type="button" data-sheet="saveclock">Set clock</button></div>`;
  }
  function saveClockSheet() {
    const m = Number($('#clk-m').value), sec = Number($('#clk-s').value);
    const shown = m * 60 + sec;
    if (!Number.isInteger(m) || !Number.isInteger(sec) || m < 0 || sec < 0 || sec > 59 || shown > periodLen()) {
      $('#clk-msg').innerHTML = `<div class="notice bad">Enter a time from 0:00 to ${mmss(periodLen())}.</div>`; return;
    }
    clockSetElapsed(fromShown(shown), false);
    recompute(); closeSheet(); render(); toast('Clock set. Tap Start to let it run, or set it again at stoppages.');
  }

  /* ---------- lineup / substitutions ---------- */
  function drawLineupSheet() {
    const s = state.sheet, c = state.c;
    const ti = c.teams.findIndex((t) => t.id === s.team);
    const tracked = c.teams[ti].lineupTracked;
    if (!s.chosen) s.chosen = new Set(c.teams[ti].onCourt);
    const roster = players().filter((p) => p.team_id === s.team).sort((a, b) => Engine.jerseySort(a.jersey, b.jersey));
    const max = state.sport.onCourtMax;
    const over = max && s.chosen.size > max;
    dlg.innerHTML = `<h2 id="sheet-title">${tracked ? 'Substitutions' : 'Starting lineup'}</h2>
      <div class="who">${esc(teamOf(s.team).name)}</div>
      <p class="muted">${tracked ? 'Tap players to put them in or take them out, then save. Changes are stamped with the game clock.' : 'Pick who started. Starters are counted from the opening of the game, so minutes are right from the first whistle.'}</p>
      <div class="chips">${roster.map((p) => `<button class="chip" type="button" data-lu="${p.id}" aria-pressed="${s.chosen.has(p.id)}"><span class="j">${esc(p.jersey)}</span><span class="n">${esc(lastName(p) || ' ')}</span></button>`).join('')}</div>
      <p class="${over ? 'notice warn' : 'muted small'}" id="lu-count">${s.chosen.size} selected${max ? ` (a team has ${max} in the game at a time)` : ''}</p>
      <div id="lu-msg"></div>
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Cancel</button><button class="btn primary" type="button" data-sheet="applylineup">Save</button></div>`;
  }
  function applyLineup() {
    const s = state.sheet, c = state.c;
    const ti = c.teams.findIndex((t) => t.id === s.team);
    const tracked = c.teams[ti].lineupTracked;
    const now = new Set(c.teams[ti].onCourt);
    const outs = [...now].filter((id) => !s.chosen.has(id)), ins = [...s.chosen].filter((id) => !now.has(id));
    if (!outs.length && !ins.length) { closeSheet(); return; }
    let clock = clockElapsed();
    if (!tracked && state.period === 1 && now.size === 0) clock = 0;          // starters: from the opening whistle
    if (clock === null) { $('#lu-msg').innerHTML = '<div class="notice bad">Set the game clock first so the substitution is timed correctly.</div>'; return; }
    const evs = [];
    for (const [type, ids] of [['sub_out', outs], ['sub_in', ins]]) {
      for (const id of ids) {
        const v = Engine.validateEvent(state.sport, { type, period: state.period, player_id: id, clock_s: clock }, ctx());
        if (!v.ok) { $('#lu-msg').innerHTML = `<div class="notice bad">${esc(v.error)}</div>`; return; }
        evs.push(v.event);
      }
    }
    for (const e of evs) state.queue.push({ client_id: newId(), event: e, ts: new Date().toISOString() });
    saveQueue(); recompute(); render(); closeSheet();
    toast(`${tracked ? 'Substitution' : 'Starters'} saved.`);
    flush();
  }

  /* ---------- pitcher decisions at the end of a game ---------- */
  const DEC_NAMES = { W: 'Winning pitcher', L: 'Losing pitcher', SV: 'Save' };
  const DEC_TYPE = { W: 'dec_w', L: 'dec_l', SV: 'dec_sv' };
  function previewFinal() {
    return Engine.computeGame({ sport: state.sport, format: state.data.game.format, teams: state.data.teams, players: players(), events: localEvents(), final: true, currentPeriod: state.period });
  }
  function decisionBlock(s) {
    if (!state.sport.decisions) return '';
    const prev = previewFinal();
    const d = prev.decisions;
    if (!d || !d.decided) return '<p class="muted small">Tied games have no winning or losing pitcher.</p>';
    const [h, a] = prev.teams;
    const winTeam = h.score > a.score ? h : a, loseTeam = winTeam === h ? a : h;
    const have = (k) => d.confirmed.find((x) => x.decision === k);
    const rows = ['W', 'L', 'SV'].map((k) => {
      const done = have(k);
      if (done) return `<div class="decrow"><b>${DEC_NAMES[k]}:</b> ${esc(plabel(playerById(done.player_id)))} <span class="muted small">(confirmed)</span></div>`;
      const pr = d.proposals.find((x) => x.decision === k);
      const team = k === 'L' ? loseTeam : winTeam;
      const roster = players().filter((p) => p.team_id === team.id).sort((x, y) => Engine.jerseySort(x.jersey, y.jersey));
      const pick = s.picks && s.picks[k] ? s.picks[k] : { on: !!(pr && pr.player_id && !pr.needsJudgment), id: pr && pr.player_id ? pr.player_id : '' };
      return `<div class="decrow" data-dec="${k}">
        <label class="deccheck"><input type="checkbox" data-deccheck="${k}" ${pick.on ? 'checked' : ''}> <b>${DEC_NAMES[k]}</b> <span class="muted small">(${esc(team.name)})</span></label>
        <select data-decsel="${k}" aria-label="${DEC_NAMES[k]}"><option value="">Choose a pitcher</option>${roster.map((p) => `<option value="${p.id}" ${String(pick.id) === String(p.id) ? 'selected' : ''}>${esc(plabel(p))}</option>`).join('')}</select>
        <p class="hint">${pr ? esc(pr.reason) + (pr.needsJudgment ? ' This one is the official scorer\'s call, so it is not ticked for you.' : '') : 'No ' + DEC_NAMES[k].toLowerCase() + ' is suggested by the play log. Tick one only if you are sure.'}</p></div>`;
    }).join('');
    const diff = d.differs.map((x) => `<div class="notice warn">${DEC_NAMES[x.decision]} is confirmed for ${esc(x.confirmed)}, but the play log suggests ${esc(x.proposed)}.</div>`).join('');
    return `<h3>Pitching decisions</h3><p class="muted small">The play log suggests these. Nothing is awarded unless it is ticked, and anyone can see who was chosen.</p>${rows}${diff}`;
  }
  function readPicks() {
    const picks = {};
    for (const k of ['W', 'L', 'SV']) {
      const chk = $(`[data-deccheck="${k}"]`), sel = $(`[data-decsel="${k}"]`);
      if (chk && sel) picks[k] = { on: chk.checked, id: sel.value };
    }
    return picks;
  }
  async function postDecisions(picks) {
    for (const k of ['W', 'L', 'SV']) {
      const pk = picks[k];
      if (!pk || !pk.on) continue;
      if (!pk.id) throw new Error(`Choose a pitcher for the ${DEC_NAMES[k].toLowerCase()}, or untick it.`);
      const p = playerById(Number(pk.id));
      await api('POST', `/api/games/${code}/events`, { client_id: newId(), type: DEC_TYPE[k], player_id: p.id, period: state.period }, hdr());
    }
  }

  function drawFinishSheet() {
    const c = state.c, s = state.sheet;
    const sets = c.scoreMode === 'sets';
    const [h, a] = c.teams;
    const notes = c.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('');
    dlg.innerHTML = `<h2 id="sheet-title">End the game</h2>
      <p>Our stats say <b>${esc(h.name)} ${h.score}</b> to <b>${esc(a.name)} ${a.score}</b>${sets ? ' (sets won)' : ''}. Before you lock it, compare with the official scoreboard so everyone can trust the numbers.</p>${notes}
      <div class="cols two"><div class="field"><label for="fin-h">${esc(h.name)} on the scoreboard</label><input id="fin-h" type="number" inputmode="numeric" min="0" max="999" value="${s.h !== undefined ? s.h : ''}"></div>
      <div class="field"><label for="fin-a">${esc(a.name)} on the scoreboard</label><input id="fin-a" type="number" inputmode="numeric" min="0" max="999" value="${s.a !== undefined ? s.a : ''}"></div></div>
      ${sets ? '<p class="hint">Enter the points in the last set.</p>' : ''}
      ${decisionBlock(s)}
      <div id="fin-msg">${s.mismatch || ''}</div>
      <div class="sheet-actions"><button class="btn" type="button" data-sheet="cancel">Keep scoring</button>
      <button class="btn primary" type="button" data-sheet="finish-check">${s.mismatch ? 'Check again' : 'Compare and finish'}</button></div>
      <div class="sheet-actions">${s.mismatch ? '<button class="btn danger" type="button" data-sheet="finish-now">Finish anyway (mismatch is shown publicly)</button>' : '<button class="btn quiet" type="button" data-sheet="finish-now">Finish without checking</button>'}</div>`;
  }

  async function doFinish(withCheck) {
    if (state.queue.length) await flush();
    if (state.queue.length) { $('#fin-msg').innerHTML = '<div class="notice bad">Some plays are still sending. Try again in a moment.</div>'; return; }
    const s = state.sheet;
    s.picks = readPicks();
    try {
      if (withCheck) {
        const hv = $('#fin-h').value, av = $('#fin-a').value;
        if (hv === '' || av === '') { $('#fin-msg').innerHTML = '<div class="notice bad">Enter both scoreboard numbers, or finish without checking.</div>'; return; }
        const r = await api('POST', `/api/games/${code}/checkpoints`, { period: state.period, home: Number(hv), away: Number(av) }, hdr());
        if (!r.result.match) {
          s.h = hv; s.a = av;
          s.mismatch = `<div class="notice warn"><b>Doesn't match.</b> Scoreboard ${r.result.official[0]} to ${r.result.official[1]}, stats ${r.result.ours[0]} to ${r.result.ours[1]}. Look for a missed or doubled play, or finish anyway.</div>`;
          await refresh(); drawFinishSheet(); return;
        }
      }
      await postDecisions(s.picks);
      await api('POST', `/api/games/${code}/finalize`, {}, hdr());
      await refresh(); closeSheet(); toast('Game is final.');
    } catch (e) { const m = $('#fin-msg'); if (m) m.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  }

  dlg.addEventListener('click', (e) => {
    const s = state.sheet;
    if (!s) return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.sheet === 'cancel') return closeSheet();
    if (s.mode === 'action') {
      if (t.dataset.p2) {
        s.p2 = t.dataset.p2 === 'none' ? null : playerById(Number(t.dataset.p2));
        if (s.def.value) { if ($('#valin')) s.value = Number($('#valin').value); drawActionSheet(); } else saveActionSheet();
      } else if (t.dataset.choice !== undefined) { s.value = Number(t.dataset.choice); drawActionSheet(); }
      else if (t.dataset.step) { const inp = $('#valin'); inp.value = Math.max(s.def.value.min, Math.min(s.def.value.max, Number(inp.value || 0) + Number(t.dataset.step))); }
      else if (t.dataset.setval !== undefined) { $('#valin').value = t.dataset.setval; }
      else if (t.dataset.sheet === 'save') saveActionSheet();
    } else if (s.mode === 'clock' && t.dataset.sheet === 'saveclock') saveClockSheet();
    else if (s.mode === 'lineup') {
      if (t.dataset.lu) {
        const id = Number(t.dataset.lu);
        if (s.chosen.has(id)) s.chosen.delete(id); else s.chosen.add(id);
        drawLineupSheet();
      } else if (t.dataset.sheet === 'applylineup') applyLineup();
    } else if (s.mode === 'check' && t.dataset.sheet === 'docheck') doCheck();
    else if (s.mode === 'addplayer' && t.dataset.sheet === 'addplayer') doAddPlayer();
    else if (s.mode === 'finish') {
      if (t.dataset.sheet === 'finish-check') doFinish(true);
      if (t.dataset.sheet === 'finish-now') doFinish(false);
    }
  });

  /* ---------- sending ---------- */
  function mergeEvent(ev, version) {
    if (!state.data.events.some((e) => e.client_id === ev.client_id)) state.data.events.push(Object.assign({ voided: false }, ev));
    if (version === state.data.game.version + 1) state.data.game.version = version; else setTimeout(refresh, 0);
  }

  let retryTimer = null;
  async function flush() {
    if (state.flushing || !state.queue.length || !state.key) return;
    state.flushing = true;
    try {
      while (state.queue.length) {
        const item = state.queue[0];
        let res, data;
        try {
          res = await fetch(`/api/games/${code}/events`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, { 'x-keeper-key': state.key }), body: JSON.stringify(Object.assign({ client_id: item.client_id }, item.event)) });
          data = await res.json().catch(() => ({}));
        } catch (e) { state.online = false; break; }
        state.online = true;
        if (res.ok) { state.queue.shift(); state.authError = false; mergeEvent(data.event, data.version); saveQueue(); }
        else if (res.status === 401) { state.authError = true; break; }
        else if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
          state.queue.shift(); saveQueue();
          const def = state.sport.eventMap[item.event.type];
          const p = item.event.player_id ? playerById(item.event.player_id) : null;
          state.rejected.push({ text: `${p ? plabel(p) + ' ' : ''}${def ? def.label : item.event.type}`, error: data.error || 'The server rejected it.' });
        } else { state.online = false; break; }
      }
    } finally {
      state.flushing = false;
      saveQueue(); recompute(); render();
      clearTimeout(retryTimer);
      if (state.queue.length && !state.authError) retryTimer = setTimeout(flush, 4000);
    }
  }

  async function refresh() {
    try {
      const d = await api('GET', `/api/games/${code}`);
      if (d.game.version >= state.data.game.version) { state.data = d; recompute(); render(); }
    } catch (e) { /* offline */ }
  }

  /* ---------- removing plays ---------- */
  async function removeByClientId(cid) {
    const ev = localEvents().find((e) => e.client_id === cid);
    if (!ev) return;
    if (ev.pending) {
      state.queue = state.queue.filter((q) => q.client_id !== cid);
      saveQueue(); recompute(); render(); toast('Play removed.');
      return;
    }
    let reason = '';
    if (isFinal()) { reason = (window.prompt('Reason for removing this play (kept on the record):') || '').trim(); if (!reason) { toast('A reason is required.', 'bad'); return; } }
    try {
      await api('POST', `/api/games/${code}/events/${ev.id}/void`, { reason }, hdr());
      await refresh();
      toast('Play removed. It stays in the history.');
    } catch (e) { toast(esc(e.status === undefined ? 'No connection. Try again when you are back online.' : e.message), 'bad'); }
  }
  function undoLast() {
    if (!canEdit()) return;
    const live = state.c.log.filter((e) => !e.voided);
    if (!live.length) { toast('Nothing to undo.'); return; }
    removeByClientId(live[live.length - 1].client_id);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-act]');
    if (!t || t.closest('#sheet')) return;
    if (t.dataset.team) { state.team = Number(t.dataset.team); state.sel = null; store.setItem(`team:${code}`, state.team); render(); return; }
    if (t.dataset.player) { const id = Number(t.dataset.player); state.sel = state.sel === id ? null : id; render(); return; }
    if (t.dataset.ev) { handleAction(t.dataset.ev); return; }
    if (t.dataset.void) { removeByClientId(t.dataset.void); return; }
    if (t.dataset.copy) {
      const ok = await U.copyText($('#' + t.dataset.copy).value);
      const old = t.textContent; t.textContent = ok ? 'Copied' : 'Hold to copy'; setTimeout(() => { t.textContent = old; }, 1600); return;
    }
    switch (t.dataset.act) {
      case 'undo': undoLast(); break;
      case 'prevp': state.period = Math.max(1, state.period - 1); state.clock = null; store.setItem(`period:${code}`, state.period); recompute(); render(); break;
      case 'nextp': state.period = Math.min(state.sport.maxPeriods, state.period + 1); state.clock = null; store.setItem(`period:${code}`, state.period); recompute(); render(); break;
      case 'clockrun': {
        const e = clockElapsed();
        if (e === null) clockSetElapsed(0, true);
        else clockSetElapsed(e, !(state.clock && state.clock.running));
        recompute(); render(); break;
      }
      case 'clockset': { const e = clockElapsed(); openSheet({ mode: 'clock', shown: e === null ? (state.sport.clockDir === 'down' ? periodLen() : 0) : toShown(e) }); break; }
      case 'lineup': openSheet({ mode: 'lineup', team: state.team, chosen: null }); break;
      case 'retry': state.authError = false; flush(); break;
      case 'dismiss': state.rejected.shift(); render(); break;
      case 'addplayer': openSheet({ mode: 'addplayer' }); break;
      case 'check': { const period = Number(t.dataset.period) || state.period; openSheet({ mode: 'check', period, ours: oursFor(period) }); break; }
      case 'finish': openSheet({ mode: 'finish' }); break;
      case 'admin': {
        const pin = window.prompt('Admin PIN:');
        if (!pin) break;
        try {
          // The PIN is verified by the server on first use; reopen requires it and returns 401 if wrong.
          state.admin = pin; render(); toast('Admin mode on. Changes need a reason.');
        } catch (err) { /* noop */ }
        break;
      }
      case 'reopen': {
        const reason = (window.prompt('Reason for reopening this game:') || '').trim();
        if (!reason) break;
        try { await api('POST', `/api/games/${code}/reopen`, { reason }, hdr()); await refresh(); toast('Game reopened.'); }
        catch (err) { if (err.status === 401) state.admin = ''; toast(esc(err.message), 'bad'); render(); }
        break;
      }
      default:
    }
  });

  // The Undo button inside the toast
  $('#toast').addEventListener('click', (e) => { if (e.target.closest('[data-act="undo"]')) { undoLast(); $('#toast').classList.add('hidden'); } });
  window.addEventListener('online', () => { state.online = true; flush(); });
  window.addEventListener('offline', () => { state.online = false; render(); });

  /* ---------- boot ---------- */
  async function boot() {
    let data;
    try { data = await api('GET', `/api/games/${code}`); } catch (e) {
      $('#app').innerHTML = `<div class="notice bad" style="margin:16px;"><b>${esc(e.status === 404 ? 'No game with that code.' : 'Could not load this game.')}</b></div><p style="padding:0 16px;"><a class="btn" href="/">Back to home</a></p>`;
      return;
    }
    state.data = data;
    state.sport = Sports.resolve(data.game.sport, data.game.format);
    const savedTeam = Number(store.getItem(`team:${code}`));
    state.team = data.teams.some((t) => t.id === savedTeam) ? savedTeam : data.teams[0].id;
    const savedPeriod = Number(store.getItem(`period:${code}`));
    const maxEv = data.events.reduce((m, e) => Math.max(m, e.period), 1);
    state.period = Math.min(state.sport.maxPeriods, Math.max(maxEv, savedPeriod || 1));
    try { const k = JSON.parse(store.getItem(`clock:${code}`) || 'null'); if (k && k.period === state.period) state.clock = k; } catch (e) { /* ignore */ }
    recompute(); render();
    flush();
    U.listen(code, () => state.data.game.version, (d) => { if (d.game.version >= state.data.game.version) { state.data = d; recompute(); render(); } });
  }
  boot();
})();
