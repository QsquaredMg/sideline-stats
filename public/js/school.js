(function () {
  'use strict';
  const { $, esc, api } = window.UI;

  const say = (id, text, tone) => {
    const el = $(id);
    el.textContent = text;
    el.className = `notice ${tone || ''}`;
  };

  let sports = [];
  async function loadSchools(selectId) {
    const { schools } = await api('GET', '/api/schools');
    const opts = schools.length
      ? schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
      : '<option value="">No schools yet. Register yours first.</option>';
    for (const id of ['#tschool', '#cschool']) {
      const prev = $(id).value;
      $(id).innerHTML = opts;
      if (prev) $(id).value = prev;
    }
    if (selectId) { $('#tschool').value = selectId; $('#cschool').value = selectId; }
    $('#school-list').innerHTML = schools.length
      ? schools.map((s) => `<li style="display:block;padding:10px 4px;"><b>${esc(s.name)}</b><br><span class="muted small">${
        s.teams.length ? s.teams.map((t) => `${esc(t.name)} (${esc(t.sport)})`).join(', ') : 'No teams added yet'}</span></li>`).join('')
      : '<li class="muted" style="padding:12px 4px;">No schools registered yet.</li>';
  }

  api('GET', '/api/config').then((cfg) => {
    sports = cfg.sports;
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
})();
