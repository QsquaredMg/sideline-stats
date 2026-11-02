(function () {
  'use strict';
  const { $, esc } = window.UI;
  const Sports = window.StatSports, Engine = window.StatEngine;
  const id = location.pathname.split('/')[2];

  const PRINCIPLES = [
    ['Same rules for both teams.', 'Home and away are logged with the same buttons and counted by the same formulas. Nothing is weighted or rounded in anyone\'s favor.'],
    ['Every number comes from a logged play.', 'Totals are never typed in. The box score is recalculated from the list of plays each time, so a stat cannot exist without a play behind it.'],
    ['Nothing is deleted.', 'If a play is entered by mistake it is removed with a reason, and the removal shows in the play list and the history. The box score updates from what remains.'],
    ['The score is checked against the scoreboard.', 'The scorer compares the stats to the official scoreboard during the game. Any gap is shown on the page for everyone, not hidden.'],
    ['Finished games are locked.', 'After a game is marked final, only the athletic department can change it, and every change needs a written reason that stays on the record.'],
    ['Anyone can raise a flag.', 'A parent, coach or fan can report a problem from the game page. Reports stay visible until the athletic department answers them.'],
      ['Season totals only add up finished games', 'Season pages and leaderboards are the sum of each finished game\'s box score. Live games never count. If a play is corrected in a game, the season numbers follow it, and the correction is on the record.'],
    ['Leaderboards cannot be gamed by a few attempts', 'Percentages, averages and ERA only rank players who meet a stated minimum, shown on every board. Counting stats like points or kills have no minimum. Ties share a rank. JV and varsity, or high school and college rules, never share a board.'],
    ['Minutes are counted from substitutions, with the clock', 'Minutes come from the substitutions the scorer enters with the game clock, replayed in game-time order, so a late entry cannot move minutes around. If a team\'s lineup was not tracked, the box score says so instead of guessing.'],
    ['Pitching decisions are confirmed by a person', 'Wins, losses and saves are suggested from the play log with the reason shown, and only count after the scorer confirms them. If the scorer chooses differently from the suggestion, both are visible.'],
];

  function list() {
    $('#app').innerHTML = `<h1>How stats are counted</h1>
      <p class="muted">Pick a sport to see exactly what each button credits. These pages are generated from the same definitions the app uses, so they always match what actually happens.</p>
      <ul class="gamelist">${Sports.list().map((s) => `<li><a href="/rules/${esc(s.id)}"><span><b>${esc(s.name)}</b></span><span class="muted">See the rules</span></a></li>`).join('')}</ul>
      <h2 style="margin-top:32px;">Our fairness rules</h2>
      ${PRINCIPLES.map(([h, t]) => `<h3>${esc(h)}</h3><p>${esc(t)}</p>`).join('')}`;
  }

  function sport(s) {
    document.title = `${s.name} rules | Sideline Stats`;
    const groups = [];
    for (const e of s.events) if (!groups.includes(e.group)) groups.push(e.group);
    const tables = groups.map((g) => {
      const rows = s.events.filter((e) => e.group === g).map((e) => {
        const lines = Engine.explain(s, e);
        const prompts = [];
        if (e.value) prompts.push(`Asks for: ${e.value.label.toLowerCase()}.`);
        const ul = lines.map((l) => `<li><b>${esc(l.who)}:</b> ${l.what.map(esc).join(', ')}${l.note ? ` <span class="muted">(${esc(l.note)})</span>` : ''}</li>`).join('');
        return `<tr><td>${esc(e.label)}</td><td><ul>${ul}</ul>${prompts.length ? `<p class="muted small" style="margin:6px 0 0;">${esc(prompts.join(' '))}</p>` : ''}</td></tr>`;
      }).join('');
      return `<h3 style="margin-top:22px;">${esc(g)}</h3><div class="scroll"><table class="rules"><thead><tr><th scope="col">Button</th><th scope="col">What it credits</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join('');
    const mm = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const periods = (s.formats || []).map((f) => {
      const r = Sports.resolve(s.id, f.id);
      return `${f.label}: ${r.scoreMode === 'sets' ? `best of ${r.periods} sets` : `${r.periods} ${r.periodWord.toLowerCase()}s${r.clock ? ` of ${mm(r.periodLen)}` : ''}`}${r.allowOT ? ', plus overtime as needed' : ''}.`;
    }).join(' ');
    $('#app').innerHTML = `<p><a href="/rules">All sports</a></p><h1>${esc(s.name)}: how stats are counted</h1>
      <p class="muted">${esc(periods)} Pick the rules when you start a game.</p>
      <h2>Good to know</h2>
      <ul>${s.notes.map((n) => `<li style="margin-bottom:6px; max-width:66ch;">${esc(n)}</li>`).join('')}</ul>
      <h2 style="margin-top:28px;">Every button</h2>${tables}
      <h2 style="margin-top:32px;">Our fairness rules</h2>
      ${PRINCIPLES.map(([h, t]) => `<h3>${esc(h)}</h3><p>${esc(t)}</p>`).join('')}`;
  }

  const s = id ? Sports.get(id) : null;
  if (id && !s) $('#app').innerHTML = '<div class="notice bad">That sport is not available.</div><a class="btn" href="/rules">All sports</a>';
  else if (s) sport(s); else list();
})();
