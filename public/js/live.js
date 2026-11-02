(function () {
  'use strict';
  const U = window.UI;
  const { $, esc, api } = U;
  const code = location.pathname.split('/')[2];
  const store = U.safeStorage();
  const state = { data: null, c: null, tab: store.getItem(`tab:${code}`) || 'box', audit: null };

  const BASE_TABS = [['box', 'Box score'], ['plays', 'Play by play'], ['trust', 'Corrections and checks']];
  const tabList = () => (state.data && state.data.game.paired ? BASE_TABS.concat([['books', 'Compare books']]) : BASE_TABS);

  async function load(data) {
    try { state.data = data || await api('GET', `/api/games/${code}`); } catch (e) {
      $('#app').innerHTML = `<div class="notice bad"><b>${esc(e.status === 404 ? 'No game with that code.' : 'Could not load this game.')}</b> Check the code and try again.</div><a class="btn" href="/">Back to home</a>`;
      return false;
    }
    state.c = U.compute(state.data);
    if (state.tab === 'trust') await loadAudit();
    state.recon = state.data.game.paired ? await api('GET', `/api/games/${code}/reconcile`).catch(() => null) : null;
    render();
    return true;
  }

  async function loadAudit() {
    try { state.audit = (await api('GET', `/api/games/${code}/audit`)).audit; } catch (e) { /* keep old */ }
  }

  function auditText(a) {
    const d = a.detail || {};
    const entry = (id) => state.c.log.find((e) => e.id === id);
    const play = (id) => { const e = entry(id); return e ? `${e.who || 'Team'} ${e.label} (${state.c.periodNames[e.period - 1] || ''})` : `play ${id}`; };
    switch (a.action) {
      case 'game_created': return 'Game created.';
      case 'event_voided': return `Play removed: ${play(d.event_id)}. Reason: ${d.reason || 'none given'}.${d.after_final ? ' (after final)' : ''}`;
      case 'event_restored': return `Play restored: ${play(d.event_id)}.`;
      case 'event_added_after_final': return `Play added after final: ${play(d.event_id)}. Reason: ${d.reason}.`;
      case 'player_added': return `Player added: #${d.jersey} ${d.name || ''}.`;
      case 'scoreboard_checked': return `Scoreboard checked in ${state.c.periodNames[d.period - 1] || d.period}: ${d.match ? 'matched' : `did not match (scoreboard ${d.official[0]} to ${d.official[1]}, stats ${d.ours[0]} to ${d.ours[1]})`}.`;
      case 'game_finalized': return `Game marked final at ${d.score[0]} to ${d.score[1]}.`;
      case 'game_reopened': return `Game reopened by admin. Reason: ${d.reason}.`;
      case 'dispute_opened': return 'A problem was reported.';
      case 'dispute_resolved': return `Report resolved: ${d.resolution}`;
      default: return a.action;
    }
  }

  function trustHTML() {
    const { c, data } = state;
    const checks = Engine.checkCheckpoints(c, data.checkpoints);
    const sum = U.checksSummary(c, checks);
    const flags = data.disputes;
    const open = flags.filter((d) => d.status === 'open');
    const flagHtml = flags.length ? `<ul class="audit">${flags.slice().reverse().map((d) => `<li><b>${d.status === 'open' ? 'Open' : 'Resolved'}</b>${d.name ? ` from ${esc(d.name)}` : ''}: ${esc(d.message)}${d.status === 'resolved' ? `<br><span class="muted">Answer: ${esc(d.resolution)}</span>` : ''}<div class="at">${U.fmtDateTime(d.created_at)}</div></li>`).join('')}</ul>` : '<p class="muted">No reports.</p>';
    const audit = state.audit ? `<ul class="audit">${state.audit.map((a) => `<li>${esc(auditText(a))}<div class="at">${U.fmtDateTime(a.created_at)}, by ${esc(a.actor)}</div></li>`).join('')}</ul>` : '<p class="muted">Loading…</p>';
    return `<div class="notice ${sum.tone}">${sum.html}</div>
      <h3>Reports from the stands (${open.length} open)</h3>${flagHtml}
      <h3 style="margin-top:20px;">Everything that happened to this record</h3>
      <p class="muted small">Stats are never edited or deleted. A mistake is removed with a reason, and the box score is recalculated from the remaining plays.</p>${audit}`;
  }

  function render() {
    const { c, data } = state;
    const game = data.game;
    document.title = `${c.teams[0].name} vs ${c.teams[1].name} | Sideline Stats`;
    $('#rules-link').href = `/rules/${game.sport}`;
    const checks = Engine.checkCheckpoints(c, data.checkpoints);
    const sum = U.checksSummary(c, checks);
    const openFlags = data.disputes.filter((d) => d.status === 'open').length;
    const meta = [game.level, game.date, c.sportName].filter(Boolean).map(esc).join(', ');

    const notices = [];
    if (c.warnings.length) notices.push(...c.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`));
    notices.push(`<div class="notice ${sum.tone}">${sum.html}${c.voidedCount ? ` ${c.voidedCount} ${c.voidedCount === 1 ? 'play was' : 'plays were'} corrected.` : ''}${openFlags ? ` ${openFlags} open ${openFlags === 1 ? 'report' : 'reports'}.` : ''}</div>`);

    let body;
    if (state.tab === 'plays') body = U.playsHTML(c, { showVoided: true });
    else if (state.tab === 'trust') body = trustHTML();
    else if (state.tab === 'books') body = U.reconcileHTML(state.recon, false);
    else body = U.boxHTML(c);

    $('#app').innerHTML = `
      <p class="muted small" style="margin:8px 0 0;">${meta}</p>
      ${U.boardHTML(c, game)}
      ${U.lineScoreHTML(c)}
      ${U.decisionsHTML(c)}
      ${notices.join('')}
      <div class="row" style="margin-bottom:4px;">
        <a class="btn small quiet" href="/api/games/${esc(code)}/export.csv">Download box score (CSV)</a>
        <button class="btn small quiet" id="flag-btn">Report a problem</button>
      </div>
      <div class="tabs" role="tablist">${tabList().map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`).join('')}</div>
      <div role="tabpanel">${body}</div>`;
  }

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      store.setItem(`tab:${code}`, state.tab);
      if (state.tab === 'trust') await loadAudit();
      render();
      return;
    }
    if (e.target.closest('#flag-btn')) openFlag();
  });

  /* Report a problem */
  const dlg = $('#flag-dialog');
  function openFlag() {
    const plays = state.c.log.filter((p) => !p.voided).slice(-40).reverse();
    $('#flag-play').innerHTML = '<option value="">Not about one play</option>' + plays.map((p) => `<option value="${p.id}">${esc(state.c.periodNames[p.period - 1] || '')}: ${esc(p.who || 'Team')} ${esc(p.label)}</option>`).join('');
    $('#flag-error').classList.add('hidden');
    dlg.showModal();
  }
  $('#flag-cancel').addEventListener('click', () => dlg.close());
  $('#flag-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/games/${code}/disputes`, { name: $('#flag-name').value, message: $('#flag-msg').value, event_id: $('#flag-play').value || null });
      $('#flag-msg').value = '';
      dlg.close();
      state.tab = 'trust'; store.setItem(`tab:${code}`, 'trust');
      await load();
    } catch (ex) {
      const box = $('#flag-error'); box.textContent = ex.message; box.classList.remove('hidden');
    }
  });

  const Engine = window.StatEngine;
  load().then((ok) => {
    if (!ok) return;
    U.listen(code, () => state.data.game.version, (d) => load(d));
  });
})();
