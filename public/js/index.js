(function () {
  'use strict';
  const { $, esc, api, copyText } = window.UI;

  const today = new Date();
  $('#date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let sportList = [];
  const fillFormats = () => {
    const s = sportList.find((x) => x.id === $('#sport').value);
    $('#format').innerHTML = ((s && s.formats) || []).map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('');
  };
  api('GET', '/api/config').then((cfg) => {
    sportList = cfg.sports;
    $('#sport').innerHTML = cfg.sports.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    fillFormats();
    if (cfg.createPinRequired) $('#pin-field').classList.remove('hidden');
  }).catch(() => {});
  $('#sport').addEventListener('change', fillFormats);

  /* ---- team directory picker: choose a program and its roster loads ---- */
  let assocLoaded = false;
  async function loadAssocs() {
    if (assocLoaded) return; assocLoaded = true;
    try {
      const r = await api('GET', '/api/directory/associations');
      const opts = r.associations.map((a) => `<option value="${esc(a.key)}">${esc(a.name)}${a.teams ? ` (${a.teams})` : ''}</option>`).join('');
      for (const x of ['h', 'a']) $(`#${x}assoc`).insertAdjacentHTML('beforeend', opts);
    } catch (e) { assocLoaded = false; }
  }
  function bindDir(x, nameId, rosterId) {
    const res = $(`#${x}res`), note = $(`#${x}note`);
    let timer = null;
    const search = async () => {
      const q = new URLSearchParams({ assoc: $(`#${x}assoc`).value, sport: $('#sport').value, q: $(`#${x}q`).value.trim(), limit: 12 });
      try {
        const r = await api('GET', `/api/directory/teams?${q}`);
        res.innerHTML = r.teams.length ? r.teams.map((t) => {
          const ro = t.roster ? (t.roster.verified ? `Roster ${esc(t.roster.season)} verified by the school` : `Roster ${esc(t.roster.season)} not yet confirmed by the school`) : 'No roster yet';
          return `<li><button type="button" class="btn quiet" data-pick="${t.id}" data-x="${x}"><b>${esc(t.name)}</b><span class="muted small">${esc(t.association.name)}${t.conference ? ', ' + esc(t.conference) : ''}${t.location ? ', ' + esc(t.location) : ''}<br>${ro}</span></button></li>`;
        }).join('') : '<li class="muted small">No teams match. A school can list its teams in the directory, or type the team in below.</li>';
      } catch (e) { res.innerHTML = '<li class="muted small">Could not load the directory.</li>'; }
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(search, 250); };
    $(`#${x}dir`).addEventListener('toggle', (e) => { if (e.target.open) { loadAssocs(); search(); } });
    $(`#${x}assoc`).addEventListener('change', search);
    $(`#${x}q`).addEventListener('input', later);
    $('#sport').addEventListener('change', () => { if ($(`#${x}dir`).open) search(); });
    res.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      try {
        const r = await api('GET', `/api/directory/teams/${b.dataset.pick}/roster`);
        $(nameId).value = r.team.name;
        if (r.players.length) $(rosterId).value = r.players.map((p) => `${p.jersey} ${p.name}`.trim()).join('\n');
        note.textContent = r.players.length
          ? `Loaded the ${r.season} roster for ${r.team.name} (${r.players.length} players). ${r.verified ? 'The school has verified it.' : 'The school has not confirmed it yet, so check it before tip-off.'} You can still edit it.`
          : `${r.team.name} has no roster in the directory yet. Type the roster below.`;
        note.classList.remove('hidden');
        $(`#${x}dir`).open = false;
      } catch (ex) { note.textContent = ex.message; note.classList.remove('hidden'); }
    });
  }
  bindDir('h', '#hname', '#hroster');
  bindDir('a', '#aname', '#aroster');

  $('#find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#code').value.trim().toUpperCase();
    if (code) location.href = `/g/${encodeURIComponent(code)}`;
  });

  function renderGames(games) {
    const ul = $('#games');
    if (!games.length) { ul.innerHTML = '<li class="muted" style="padding:12px 4px;">No games yet. Start one below.</li>'; return; }
    ul.innerHTML = games.map((g) => `<li><a href="/g/${esc(g.code)}">
      <span><b>${esc(g.home.name)}</b> vs <b>${esc(g.away.name)}</b><br><span class="muted small">${esc(g.sport)}${g.level ? ', ' + esc(g.level) : ''}${g.date ? ', ' + esc(g.date) : ''}</span></span>
      <span class="score">${g.home.score} to ${g.away.score}<br><span class="badge ${g.status}">${g.status === 'final' ? 'Final' : 'Live'}</span></span></a></li>`).join('');
  }
  api('GET', '/api/games?limit=12').then((r) => renderGames(r.games)).catch(() => { $('#games').innerHTML = '<li class="muted" style="padding:12px 4px;">Could not load games. Check your connection.</li>'; });

  $('#sample').addEventListener('click', () => {
    $('#hname').value = $('#hname').value || 'Provine Rams';
    $('#aname').value = $('#aname').value || 'Murrah Mustangs';
    $('#hroster').value = '0 Terrell Banks\n4 Devin Lee\n10 Amir Cruz\n12 Jaylen Brooks\n23 Marcus Johnson\n32 Isaiah Wells\n34 Chris Bell';
    $('#aroster').value = '1 Andre Miles\n3 Cam Ray\n11 Tre Hayes\n15 Jordan Moss\n21 Eli Grant\n24 Sam Ortiz\n33 Dre Foster';
  });

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#create-error');
    err.classList.add('hidden');
    const btn = $('#create-btn');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/games', {
        sport: $('#sport').value, format: $('#format').value, date: $('#date').value, level: $('#level').value, pin: $('#pin').value,
        book: (document.querySelector('input[name="book"]:checked') || {}).value || undefined,
        pair_with: $('#pairwith').value.trim().toUpperCase() || undefined,
        home: { name: $('#hname').value, roster: $('#hroster').value },
        away: { name: $('#aname').value, roster: $('#aroster').value },
      });
      const origin = location.origin;
      $('#k-link').value = origin + r.keeperUrl;
      $('#p-link').value = origin + r.publicUrl;
      $('#open-keeper').href = r.keeperUrl;
      if (r.pairCode) { $('#pair-code').textContent = r.pairCode; $('#pair-note').classList.remove('hidden'); }
      $('#create-section').classList.add('hidden');
      const done = $('#done');
      done.classList.remove('hidden');
      done.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      if (ex.data && ex.data.needPin) { $('#pin-field').classList.remove('hidden'); $('#pin').focus(); }
      err.textContent = ex.message;
      err.classList.remove('hidden');
      err.scrollIntoView({ block: 'center' });
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const ok = await copyText($('#' + b.dataset.copy).value);
    const old = b.textContent;
    b.textContent = ok ? 'Copied' : 'Press and hold to copy';
    setTimeout(() => { b.textContent = old; }, 1800);
  });
})();
