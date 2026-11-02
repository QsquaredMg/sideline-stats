(function () {
  'use strict';
  const { $, esc, api } = window.UI;

  const say = (id, text, tone) => {
    const el = $(id);
    el.textContent = text;
    el.className = `notice ${tone || ''}`;
  };

  let sports = [];
  let schoolData = [];
  function renderRemoveTeams() {
    const s = schoolData.find((x) => String(x.id) === $('#rschool').value);
    $('#rteams').innerHTML = !s ? 'Pick your school.' : s.teams.length
      ? s.teams.map((t, i) => `<label style="display:flex;gap:10px;align-items:center;min-height:36px;"><input type="checkbox" name="rt" value="${i}"> ${esc(t.name)} <span class="muted small">(${esc(t.sport)})</span></label>`).join('')
      : 'This school has no teams.';
  }
  async function loadSchools(selectId) {
    const { schools } = await api('GET', '/api/schools');
    schoolData = schools;
    const opts = schools.length
      ? schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
      : '<option value="">No schools yet. Register yours first.</option>';
    for (const id of ['#tschool', '#cschool', '#rschool', '#dschool']) {
      const prev = $(id).value;
      $(id).innerHTML = opts;
      if (prev) $(id).value = prev;
    }
    if (selectId) { $('#tschool').value = selectId; $('#cschool').value = selectId; $('#rschool').value = selectId; }
    renderRemoveTeams();
    $('#school-list').innerHTML = schools.length
      ? schools.map((s) => `<li style="display:block;padding:10px 4px;"><b>${esc(s.name)}</b><br><span class="muted small">${
        s.teams.length ? s.teams.map((t) => `${esc(t.name)} (${esc(t.sport)})`).join(', ') : 'No teams added yet'}</span></li>`).join('')
      : '<li class="muted" style="padding:12px 4px;">No schools registered yet.</li>';
  }

  api('GET', '/api/config').then((cfg) => {
    sports = cfg.sports;
    $('#dsport').innerHTML = cfg.sports.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    $('#tsport').innerHTML = sports.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if (cfg.schoolSetupCodeRequired) $('#setup-field').classList.remove('hidden');
  }).catch(() => {});
  loadSchools().catch(() => { $('#school-list').innerHTML = '<li class="muted" style="padding:12px 4px;">Could not load schools.</li>'; });

  $('#reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#spin').value !== $('#spin2').value) return say('#reg-msg', 'The two PINs do not match.', 'bad');
    $('#reg-btn').disabled = true;
    try {
      const r = await api('POST', '/api/schools', { name: $('#sname').value, pin: $('#spin').value, setupCode: $('#setup').value });
      say('#reg-msg', `${r.school.name} is registered. Now add your teams below. Keep your PIN somewhere safe.`, 'good');
      $('#tpin').value = $('#spin').value;
      $('#spin').value = ''; $('#spin2').value = '';
      await loadSchools(String(r.school.id));
      $('#teams').scrollIntoView({ behavior: 'smooth' });
    } catch (ex) { say('#reg-msg', ex.message, 'bad'); }
    $('#reg-btn').disabled = false;
  });

  $('#teams-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const names = $('#tnames').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!$('#tschool').value) return say('#teams-msg', 'Register your school first.', 'bad');
    if (!names.length) return say('#teams-msg', 'Type at least one team name.', 'bad');
    $('#teams-btn').disabled = true;
    try {
      const r = await api('POST', `/api/schools/${$('#tschool').value}/teams`, {
        pin: $('#tpin').value, teams: names.map((name) => ({ name, sport: $('#tsport').value })),
      });
      say('#teams-msg', `Added ${r.teams.length} team${r.teams.length === 1 ? '' : 's'}. Starting a game for them now needs your PIN.`, 'good');
      $('#tnames').value = '';
      await loadSchools();
    } catch (ex) { say('#teams-msg', ex.message, 'bad'); }
    $('#teams-btn').disabled = false;
  });

  $('#pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#cschool').value) return say('#pin-msg', 'Pick your school.', 'bad');
    $('#pin-btn').disabled = true;
    try {
      await api('POST', `/api/schools/${$('#cschool').value}/pin`, { pin: $('#cold').value, newPin: $('#cnew').value });
      say('#pin-msg', 'PIN changed. Use the new one from now on.', 'good');
      $('#cold').value = ''; $('#cnew').value = '';
    } catch (ex) { say('#pin-msg', ex.message, 'bad'); }
    $('#pin-btn').disabled = false;
  });

  /* ---- team directory ---- */
  {
    const t = new Date(), y = t.getMonth() >= 7 ? t.getFullYear() : t.getFullYear() - 1;
    $('#dseason').value = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    api('GET', '/api/directory/associations').then((r) => { $('#dassoc').innerHTML = r.associations.map((a) => `<option value="${esc(a.key)}">${esc(a.name)}</option>`).join(''); }).catch(() => {});
  }
  $('#dir-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#dschool').value) return say('#dir-msg', 'Register your school first.', 'bad');
    const players = [];
    for (const line of $('#droster').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      const m = line.match(/^#?\s*([A-Za-z0-9]{1,4})(?:[\s,.:\-]+(.*))?$/);
      if (!m || !/\d/.test(m[1])) return say('#dir-msg', `Could not read "${line}". Use one player per line, like "23 Marcus Johnson".`, 'bad');
      players.push({ jersey: m[1], name: (m[2] || '').trim() });
    }
    if (!players.length) return say('#dir-msg', 'Add at least one player.', 'bad');
    $('#dir-btn').disabled = true;
    try {
      const t = await api('POST', '/api/directory/teams', { association: $('#dassoc').value, name: $('#dteam').value, sport: $('#dsport').value, conference: $('#dconf').value, location: $('#dloc').value, school_id: $('#dschool').value, pin: $('#dpin').value });
      const r = await api('PUT', `/api/directory/teams/${t.team.id}/roster`, { season: $('#dseason').value, pin: $('#dpin').value, players });
      say('#dir-msg', `Listed ${t.team.name}. ${r.players} players published for ${r.season}, verified by the school.`, 'good');
      await loadSchools();
    } catch (ex) { say('#dir-msg', ex.message, 'bad'); }
    $('#dir-btn').disabled = false;
  });

  $('#rschool').addEventListener('change', renderRemoveTeams);

  $('#rm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = schoolData.find((x) => String(x.id) === $('#rschool').value);
    if (!s) return say('#rm-msg', 'Pick your school.', 'bad');
    const picked = Array.from(document.querySelectorAll('input[name=rt]:checked')).map((c) => s.teams[Number(c.value)]);
    if (!picked.length) return say('#rm-msg', 'Tick the teams you want to remove.', 'bad');
    if (!window.confirm(`Remove ${picked.map((t) => t.name).join(', ')}? Anyone will be able to start games for ${picked.length === 1 ? 'it' : 'them'} again.`)) return;
    $('#rm-btn').disabled = true;
    try {
      const r = await api('DELETE', `/api/schools/${s.id}/teams`, { pin: $('#rpin').value, teams: picked.map((t) => ({ name: t.name, sport: t.sport })) });
      say('#rm-msg', `Removed ${r.removed.length} team${r.removed.length === 1 ? '' : 's'}. Their games and stats are untouched.`, 'good');
      await loadSchools(String(s.id));
    } catch (ex) { say('#rm-msg', ex.message, 'bad'); }
    $('#rm-btn').disabled = false;
  });

  $('#del-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = schoolData.find((x) => String(x.id) === $('#rschool').value);
    if (!s) return say('#del-msg', 'Pick your school above.', 'bad');
    if (!$('#rpin').value) return say('#del-msg', 'Enter the school PIN in the box above.', 'bad');
    if ($('#dname').value.trim().replace(/\s+/g, ' ').toLowerCase() !== s.name.toLowerCase()) return say('#del-msg', `Type the school name exactly: ${s.name}`, 'bad');
    $('#del-btn').disabled = true;
    try {
      const r = await api('DELETE', `/api/schools/${s.id}`, { pin: $('#rpin').value, confirmName: $('#dname').value });
      say('#del-msg', `${s.name} was deleted${r.releasedTeams ? ` and ${r.releasedTeams} team${r.releasedTeams === 1 ? ' was' : 's were'} released` : ''}.`, 'good');
      $('#dname').value = ''; $('#rpin').value = '';
      await loadSchools();
    } catch (ex) { say('#del-msg', ex.message, 'bad'); }
    $('#del-btn').disabled = false;
  });
})();
