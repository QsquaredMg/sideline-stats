/* Shared browser helpers. Rendering is driven by the same engine the server uses. */
(function () {
  'use strict';
  const Engine = window.StatEngine, Sports = window.StatSports;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, path, body, headers) {
    const res = await fetch(path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function compute(data) {
    return Engine.computeGame({
      sport: data.game.sport, format: data.game.format, teams: data.teams, players: data.players, events: data.events,
      final: data.game.status === 'final',
    });
  }

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  };
  const fmtDateTime = (iso) => {
    try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  };

  /* ---------- Scoreboard ---------- */
  function boardHTML(c, game) {
    const [h, a] = c.teams;
    const isSets = c.scoreMode === 'sets';
    const cp = c.currentPeriod;
    const per = c.periodNames[cp - 1] || '';
    const status = game.status === 'final' ? '<span class="status">Final</span>' : '<span class="status live">Live</span>';
    const setLine = isSets ? `<div class="sub"><span>${esc(per)}: ${h.periodPts[cp - 1] || 0} to ${a.periodPts[cp - 1] || 0}</span><span>Sets won</span></div>` : '';
    return `<section class="board" aria-label="Scoreboard">
      <div class="board-main">
        <div class="side home"><div class="tname">${esc(h.name)}</div><div class="digits" aria-label="${esc(h.name)} ${h.score}">${h.score}</div></div>
        <div class="mid"><div class="period">${esc(per)}</div>${status}</div>
        <div class="side away"><div class="tname">${esc(a.name)}</div><div class="digits" aria-label="${esc(a.name)} ${a.score}">${a.score}</div></div>
      </div>${setLine}</section>`;
  }

  function lineScoreHTML(c) {
    const [h, a] = c.teams;
    const heads = c.periodNames.map((n) => `<th scope="col">${esc(n)}</th>`).join('');
    const rowFor = (t) => `<tr><td>${esc(t.name)}</td>${t.periodPts.map((p, i) => `<td>${i + 1 <= c.currentPeriod ? p : ''}</td>`).join('')}<td class="t">${t.score}</td></tr>`;
    return `<div class="scroll"><table class="linescore"><thead><tr><th scope="col">${c.scoreMode === 'sets' ? 'Points per set' : 'By period'}</th>${heads}<th scope="col">${c.scoreMode === 'sets' ? 'Sets' : 'T'}</th></tr></thead><tbody>${rowFor(h)}${rowFor(a)}</tbody></table></div>`;
  }

  /* ---------- Box score ---------- */
  function boxHTML(c) {
    return c.teams.map((t) => {
      const tables = t.sections.map((sec) => {
        const head = `<tr><th scope="col">#</th><th scope="col">Player</th>${sec.columns.map((col) => `<th scope="col">${esc(col.label)}</th>`).join('')}</tr>`;
        const body = sec.rows.map((r) => `<tr><td>${esc(r.jersey)}</td><td>${esc(r.name)}${r.flags.map((f) => `<span class="flag ${f.tone === 'bad' ? 'bad' : ''}">${esc(f.label)}</span>`).join('')}</td>${r.cells.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('');
        const foot = `<tfoot><tr><td></td><td>Total</td>${sec.totals.map((x) => `<td>${esc(x)}</td>`).join('')}</tr></tfoot>`;
        return `<div class="scroll"><table class="box"><caption>${esc(sec.title)}</caption><thead>${head}</thead><tbody>${body}</tbody>${foot}</table></div>`;
      }).join('');
      const role = t.currentRole ? `<span class="muted small">${esc(Sports.get(c.sport).roleLabel || '')}: ${esc(t.currentRole)}</span>` : '';
      const unTracked = c.minutes && !t.lineupTracked ? '<p class="muted small">Minutes were not tracked for this team in this game.</p>' : '';
      return `<div class="teamhead ${t.side === 'away' ? 'away' : ''}"><h2><a class="teamlink" href="/t/${t.id}" title="Season stats">${esc(t.name)}</a></h2><span class="num">${t.score}</span>${role}</div>${tables}${unTracked}`;
    }).join('');
  }

  /* ---------- Pitcher decisions (scorer-confirmed) ---------- */
  function decisionsHTML(c) {
    const d = c.decisions;
    if (!d || !d.confirmed.length) return '';
    const names = { W: 'Winning pitcher', L: 'Losing pitcher', SV: 'Save' };
    const byId = {};
    c.teams.forEach((t) => t.sections.forEach((s) => s.rows.forEach((r) => { byId[r.player_id] = `#${r.jersey}${r.name ? ' ' + r.name : ''}`; })));
    const items = ['W', 'L', 'SV'].flatMap((k) => d.confirmed.filter((x) => x.decision === k).map((x) => `<li><b>${names[k]}:</b> ${esc(byId[x.player_id] || '')}</li>`));
    return `<div class="panel decisions"><h3>Pitching decisions</h3><ul>${items.join('')}</ul></div>`;
  }

  /* ---------- Plays ---------- */
  function playText(e) {
    let s = `<b>${esc(e.who) || 'Team'}</b> ${esc(e.label)}`;
    if (e.who2) s += `, ${esc(e.prompt.toLowerCase())} ${esc(e.who2)}`;
    if (e.valueText) s += `, ${esc(e.valueText.toLowerCase())}`;
    else if (e.value !== null && e.value !== undefined && e.valueLabel) s += `, ${e.value} ${/yard/i.test(e.valueLabel) ? 'yds' : ''}`.trimEnd();
    return s;
  }

  function playsHTML(c, opts) {
    opts = opts || {};
    const sideOf = (tid) => (tid === c.teams[1].id ? 'away' : '');
    const items = c.log.slice().reverse().filter((e) => opts.showVoided || !e.voided).slice(0, opts.limit || 200);
    if (!items.length) return '<p class="muted">No plays yet.</p>';
    const clk = (e) => (e.clock_s === null || e.clock_s === undefined ? '' : ` ${Math.floor(e.clock_s / 60)}:${String(e.clock_s % 60).padStart(2, '0')}`);
    return `<ol class="plays">${items.map((e) => {
      const pts = e.pts ? `+${e.pts}` : (e.oppPts ? `+${e.oppPts} opp` : '');
      return `<li class="${e.voided ? 'void' : ''}"><span class="when">${esc(c.periodNames[e.period - 1] || e.period)}${clk(e)}</span>
        <span class="what"><span class="tm ${sideOf(e.team_id)}" aria-hidden="true"></span>${playText(e)}</span>
        <span class="pts">${e.voided ? '' : pts}</span>
        ${e.voided ? `<span class="why">Removed${e.void_reason ? ': ' + esc(e.void_reason) : ''}</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }

  /* ---------- Scoreboard checks ---------- */
  function checksSummary(c, checks) {
    if (!checks.length) return { tone: '', html: 'The score has not been checked against the scoreboard yet.' };
    const bad = checks.filter((x) => !x.match);
    const lastGood = checks.filter((x) => x.match).pop();
    // Only the latest entry per period counts, so a fixed mismatch clears itself.
    if (bad.length) {
      const b = bad.map((x) => `${esc(x.periodName)}: scoreboard shows ${x.official[0]} to ${x.official[1]}, stats add up to ${x.ours[0]} to ${x.ours[1]}`).join('. ');
      return { tone: 'warn', html: `<b>Scoreboard does not match yet.</b> ${b}. Some plays may be missing or entered twice.` };
    }
    return { tone: 'good', html: `<b>Scoreboard matches the stats</b> through ${esc(lastGood.periodName)}.` };
  }

  /* ---------- Live updates ---------- */
  function listen(code, getVersion, onChange) {
    let es = null, poll = null;
    const check = async () => {
      try {
        const data = await api('GET', `/api/games/${code}`);
        if (data.game.version !== getVersion()) onChange(data);
      } catch (e) { /* offline; try again later */ }
    };
    const start = () => {
      if (!('EventSource' in window)) return;
      es = new EventSource(`/api/games/${code}/stream`);
      es.addEventListener('update', check);
    };
    start();
    poll = setInterval(check, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);
    return () => { if (es) es.close(); clearInterval(poll); };
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
  }

  function safeStorage() {
    try { const k = '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch (e) {
      const mem = {};
      return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
    }
  }

  /** Two-books comparison panel. `v` is GET /api/games/:code/reconcile. `canStand` adds the "ours stands" buttons (keeper only). */
  function reconcileHTML(v, canStand) {
    if (!v || !v.paired) return '';
    const names = (id) => (v.books.find((b) => b.team_id === id) || {}).team_name || 'Their book';
    const mine = names(v.you), other = v.books.find((b) => b.team_id !== v.you);
    const theirName = other ? other.team_name : 'the other team';
    if (v.state === 'one_book') return `<div class="notice"><b>This is ${esc(mine)}'s book.</b> The other team can keep its own book of this game with the code <b>${esc(v.books[0].code)}</b>. When both books are final they are compared automatically.</div>`;
    if (v.state === 'waiting') return `<div class="notice"><b>Waiting for both books to be final.</b> ${esc(mine)} and ${esc(theirName)} each keep their own book. They are compared as soon as both are marked final.</div>`;
    if (v.state === 'agreed') return `<div class="notice good"><b>Agreed.</b> Both books match on all ${v.agreed} lines.</div>`;
    const win = v.window;
    const head = v.state === 'in_review'
      ? `<div class="notice warn"><b>Review window: ${win.hoursLeft} ${win.hoursLeft === 1 ? 'hour' : 'hours'} left.</b> ${v.lines.length} ${v.lines.length === 1 ? 'line differs' : 'lines differ'}. Each team can fix its own book until then. After that each team keeps its own number and the difference is noted.</div>`
      : `<div class="notice"><b>Settled with ${v.lines.length} noted ${v.lines.length === 1 ? 'difference' : 'differences'}.</b> Each team keeps its own book. Leaderboards use each team's own numbers.</div>`;
    const rows = v.lines.map((l) => {
      const who = l.jersey === null ? esc(l.team_name) : `#${esc(l.jersey)} ${esc(l.name)} <span class="muted">${esc(l.team_name)}</span>`;
      const st = l.status === 'disputed' ? '<span class="badge final">Noted</span>' : '<span class="badge live">Review</span>';
      const btn = canStand && l.status === 'review' && !l.you_stand ? `<button class="btn small" data-stand="${esc(l.key)}">Ours stands</button>` : (l.you_stand ? '<span class="muted small">You said ours stands</span>' : '');
      return `<tr><td>${who}</td><td>${esc(l.label)}</td><td class="num"><b>${l.mine}</b></td><td class="num">${l.theirs}</td><td>${st} ${btn}</td></tr>`;
    }).join('');
    return `${head}<div class="scroll"><table class="box"><caption>Differences between the two books</caption><thead><tr><th scope="col">Who</th><th scope="col">Stat</th><th scope="col">${esc(mine)}</th><th scope="col">${esc(theirName)}</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted small">${v.agreed} other lines agree.</p>`;
  }

  window.UI = { reconcileHTML, $, $$, esc, api, compute, fmtTime, fmtDateTime, boardHTML, lineScoreHTML, boxHTML, decisionsHTML, playsHTML, playText, checksSummary, listen, copyText, safeStorage };
})();
