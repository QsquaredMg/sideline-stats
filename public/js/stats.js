/* Season totals (/t/:id) and leaderboards (/leaders/:sport). Everything shown is summed from FINAL games only. */
(function () {
  'use strict';
  const { $, esc, api } = window.UI;
  const Sports = window.StatSports;
  const parts = location.pathname.split('/').filter(Boolean);
  const qs = new URLSearchParams(location.search);

  const select = (id, label, options, value) => options.length > 1 || (options.length === 1 && value === undefined)
    ? `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`
    : '';

  function go(patch) {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null || v === undefined) next.delete(k); else next.set(k, v); }
    location.search = next.toString();
  }
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-filter]');
    if (el) go({ [el.dataset.filter]: el.value });
  });

  const table = (sec) => {
    const head = `<tr><th scope="col">#</th><th scope="col">Player</th>${sec.columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}</tr>`;
    const body = sec.rows.map((r) => `<tr><td>${esc(r.jersey)}</td><td>${esc(r.name)}</td>${r.cells.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('');
    const foot = `<tfoot><tr><td></td><td>Player totals</td>${sec.totals.map((x) => `<td>${esc(x)}</td>`).join('')}</tr></tfoot>`;
    return `<div class="scroll"><table class="box"><caption>${esc(sec.title)}</caption><thead>${head}</thead><tbody>${body}</tbody>${foot}</table></div>`;
  };

  async function team() {
    const q = new URLSearchParams();
    if (qs.get('season')) q.set('season', qs.get('season'));
    if (qs.get('level')) q.set('level', qs.get('level'));
    let d;
    try { d = await api('GET', `/api/teams/${encodeURIComponent(parts[1])}/season?${q}`); } catch (e) {
      $('#app').innerHTML = `<div class="notice bad"><b>${e.status === 404 ? 'No team with that link.' : 'Could not load this team.'}</b></div><a class="btn" href="/">Back to home</a>`;
      return;
    }
    document.title = `${d.team.name} ${d.season || ''} | Sideline Stats`;
    const r = d.record;
    const rec = `${r.w}-${r.l}${r.t ? '-' + r.t : ''}`;
    const filters = select('f-season', 'Season', d.seasons.map((s) => ({ value: s, label: s })), d.season).replace('<select', '<select data-filter="season"')
      + select('f-level', 'Level', [{ value: '', label: 'All levels' }].concat(d.levels.map((l) => ({ value: l, label: l }))), d.level).replace('<select', '<select data-filter="level"');
    const games = d.games.length ? `<div class="scroll"><table class="box"><caption>Results</caption><thead><tr><th scope="col">Date</th><th scope="col">Opponent</th><th scope="col">Level</th><th scope="col">Score</th><th scope="col"></th></tr></thead><tbody>${
      d.games.map((g) => `<tr><td>${esc(g.date)}</td><td><a href="/g/${esc(g.code)}">${g.home ? 'vs' : 'at'} ${esc(g.opponent)}</a></td><td>${esc(g.level)}</td><td>${g.us}-${g.them}</td><td><b>${g.result}</b></td></tr>`).join('')}</tbody></table></div>` : '';
    const avgHead = d.averageLabels.length ? d.averageLabels.map((l) => `<th scope="col">${esc(l)}</th>`).join('') : '';
    const avgs = d.players.length && d.averageLabels.length ? `<div class="scroll"><table class="box"><caption>Per game</caption><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">GP</th><th scope="col">GS</th>${avgHead}</tr></thead><tbody>${
      d.players.map((p) => `<tr><td>${esc(p.jersey)}</td><td>${esc(p.name)}</td><td>${p.gp}</td><td>${p.gs}</td>${p.averages.map((a) => `<td>${esc(a.value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    $('#app').innerHTML = `
      <p class="muted small" style="margin:8px 0 0;"><a href="/leaders/${esc(d.team.sport)}">${esc(d.team.sportName)} leaders</a></p>
      <h1 style="margin:4px 0;">${esc(d.team.name)}</h1>
      <p class="muted">${d.season ? `${esc(d.season)} season${d.formatLabel ? ', ' + esc(d.formatLabel) : ''}` : 'No finished games yet'}${d.record.games ? ` &middot; <b>${rec}</b> in ${d.record.games} ${d.record.games === 1 ? 'game' : 'games'}` : ''}</p>
      ${filters ? `<div class="row">${filters}</div>` : ''}
      <div class="notice">Season totals add up the <b>finished</b> games only. Each number is the sum of that game's box score, which is built from its play log. Fix a play in a game and this page follows.</div>
      ${d.sections.map(table).join('')}${avgs}${games}`;
  }

  async function leaders() {
    const sportId = parts[1] || 'basketball';
    const q = new URLSearchParams();
    for (const k of ['season', 'level', 'format']) if (qs.get(k) !== null) q.set(k, qs.get(k));
    let d;
    try { d = await api('GET', `/api/leaders/${encodeURIComponent(sportId)}?${q}`); } catch (e) {
      $('#app').innerHTML = `<div class="notice bad"><b>${e.status === 404 ? 'Unknown sport.' : 'Could not load leaders.'}</b></div><a class="btn" href="/">Back to home</a>`;
      return;
    }
    document.title = `${d.sport.name} leaders | Sideline Stats`;
    const sportNav = `<div class="tabs" role="tablist">${Sports.list().map((s) => `<button role="tab" data-sport="${esc(s.id)}" aria-selected="${s.id === d.sport.id}">${esc(s.name)}</button>`).join('')}</div>`;
    const filters = select('f-season', 'Season', d.seasons.map((s) => ({ value: s, label: s })), d.season).replace('<select', '<select data-filter="season"')
      + select('f-level', 'Level', [{ value: '', label: 'All levels' }].concat(d.levels.map((l) => ({ value: l, label: l }))), d.level).replace('<select', '<select data-filter="level"')
      + select('f-format', 'Rules', d.formats.map((f) => ({ value: f.id, label: f.label })), d.format).replace('<select', '<select data-filter="format"');
    const cats = d.categories.filter((c) => c.leaders.length).map((c) => `
      <section class="panel leadcard"><h2>${esc(c.label)}</h2>${c.qualText ? `<p class="muted small">${esc(c.qualText)}</p>` : ''}
        <ol class="leadlist">${c.leaders.map((l) => `<li><span class="rank">${l.rank}${l.tied ? 'T' : ''}</span><span class="who"><b>${esc(l.name || '#' + l.jersey)}</b> <span class="muted small">#${esc(l.jersey)} <a href="/t/${l.team_id}">${esc(l.team_name)}</a></span></span><span class="val num">${esc(l.display)}</span></li>`).join('')}</ol></section>`).join('');
    $('#app').innerHTML = `
      <h1 style="margin:8px 0;">Leaders</h1>
      ${sportNav}
      ${filters ? `<div class="row">${filters}</div>` : ''}
      <p class="muted">${d.season ? `${esc(d.season)} season, ${d.games} finished ${d.games === 1 ? 'game' : 'games'}.` : 'No finished games yet.'}
        Percentages and averages only rank players who meet the minimum shown, so a lucky few attempts cannot top a board. Ties share a rank.</p>
      ${cats || '<div class="notice">No leaders yet. Boards fill in as games are marked final.</div>'}`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sport]');
    if (b) location.href = `/leaders/${b.dataset.sport}`;
  });

  if (parts[0] === 't') team(); else leaders();
})();
