const test = require('node:test');
const assert = require('node:assert/strict');
const Sports = require('../shared/sports');
const E = require('../shared/engine');

const H = { id: 1, name: 'Home HS' };
const A = { id: 2, name: 'Away HS' };
const mkPlayers = () => [
  { id: 11, team_id: 1, jersey: '4', name: 'Lee' },
  { id: 12, team_id: 1, jersey: '23', name: 'Johnson' },
  { id: 13, team_id: 1, jersey: '10', name: 'Cruz' },
  { id: 21, team_id: 2, jersey: '3', name: 'Ray' },
  { id: 22, team_id: 2, jersey: '15', name: 'Moss' },
];
let nextId = 1;
const ev = (type, o = {}) => ({ id: nextId++, type, period: 1, ...o });
const run = (sport, events, extra = {}) =>
  E.computeGame({ sport, teams: [H, A], players: mkPlayers(), events, ...extra });
const row = (c, teamIdx, sectionId, jersey) =>
  c.teams[teamIdx].sections.find((s) => s.id === sectionId).rows.find((r) => r.jersey === jersey);
const cell = (c, teamIdx, sectionId, jersey, key) => {
  const sec = c.teams[teamIdx].sections.find((s) => s.id === sectionId);
  return row(c, teamIdx, sectionId, jersey).cells[sec.columns.findIndex((x) => x.key === key)];
};
const totalCell = (c, teamIdx, sectionId, key) => {
  const sec = c.teams[teamIdx].sections.find((s) => s.id === sectionId);
  return sec.totals[sec.columns.findIndex((x) => x.key === key)];
};

test('basketball: made shots auto-count attempts, assists and score', () => {
  const c = run('basketball', [
    ev('fg3_made', { team_id: 1, player_id: 12, player2_id: 11 }),
    ev('fg2_made', { team_id: 1, player_id: 12 }),
    ev('ft_made', { team_id: 1, player_id: 13 }),
    ev('fg2_miss', { team_id: 1, player_id: 12 }),
  ]);
  assert.equal(c.teams[0].score, 6);
  assert.equal(c.teams[1].score, 0);
  assert.equal(cell(c, 0, 'box', '23', 'pts'), 5);
  assert.equal(cell(c, 0, 'box', '23', 'fg'), '2-3');
  assert.equal(cell(c, 0, 'box', '23', 'tp'), '1-1');
  assert.equal(cell(c, 0, 'box', '4', 'ast'), 1);
  assert.equal(cell(c, 0, 'box', '10', 'ft'), '1-1');
  assert.equal(totalCell(c, 0, 'box', 'pts'), 6);
});

test('basketball: steals and blocks credit the OTHER team; team rebounds hit totals only', () => {
  const c = run('basketball', [
    ev('tov', { team_id: 1, player_id: 12, player2_id: 21 }),
    ev('fg2_miss', { team_id: 1, player_id: 11, player2_id: 22 }),
    ev('team_dreb', { team_id: 1 }),
    ev('dreb', { team_id: 1, player_id: 11 }),
  ]);
  assert.equal(cell(c, 1, 'box', '3', 'stl'), 1);
  assert.equal(cell(c, 1, 'box', '15', 'blk'), 1);
  assert.equal(cell(c, 0, 'box', '23', 'tov'), 1);
  assert.equal(totalCell(c, 0, 'box', 'reb'), 2); // 1 player + 1 team
  assert.equal(cell(c, 0, 'box', '4', 'reb'), 1);
});

test('basketball: fouling out is flagged at 5', () => {
  const evs = Array.from({ length: 5 }, () => ev('foul', { team_id: 1, player_id: 12 }));
  const c = run('basketball', evs);
  assert.deepEqual(row(c, 0, 'box', '23').flags.map((f) => f.label), ['Fouled out']);
});

test('voided events carry no stats and no score, but stay in the log', () => {
  const e1 = ev('fg3_made', { team_id: 1, player_id: 12 });
  const e2 = ev('fg3_made', { team_id: 1, player_id: 12, voided: true, void_reason: 'wrong player' });
  const c = run('basketball', [e1, e2]);
  assert.equal(c.teams[0].score, 3);
  assert.equal(cell(c, 0, 'box', '23', 'pts'), 3);
  assert.equal(c.log.length, 2);
  assert.equal(c.voidedCount, 1);
});

test('period scores add up and OT is named', () => {
  const c = run('basketball', [
    ev('fg2_made', { team_id: 1, player_id: 11, period: 1 }),
    ev('fg3_made', { team_id: 2, player_id: 21, period: 2 }),
    ev('fg2_made', { team_id: 1, player_id: 11, period: 5 }),
  ]);
  assert.deepEqual(c.teams[0].periodPts.slice(0, 5), [2, 0, 0, 0, 2]);
  assert.deepEqual(c.teams[1].periodPts.slice(0, 5), [0, 3, 0, 0, 0]);
  assert.equal(c.periodNames[4], 'OT');
  assert.equal(c.teams[0].score, 4);
});

test('validation: self-assist, wrong-team assist, bad period, unknown stat', () => {
  const sport = Sports.get('basketball');
  const players = new Map(mkPlayers().map((p) => [p.id, p]));
  const ctx = { playersById: players, homeId: 1, awayId: 2 };
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, player2_id: 12, period: 1 }, ctx).ok, false);
  assert.match(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, player2_id: 21, period: 1 }, ctx).error, /same team/);
  assert.match(E.validateEvent(sport, { type: 'tov', player_id: 12, player2_id: 11, period: 1 }, ctx).error, /other team/);
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 99 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'nope', player_id: 12, period: 1 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 999, period: 1 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'team_dreb', team_id: 1, player_id: 12, period: 1 }, ctx).ok, false);
  const ok = E.validateEvent(sport, { type: 'fg2_made', player_id: 12, player2_id: 11, period: 1 }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.event.team_id, 1);
});

test('team is derived from the player, never trusted from the client', () => {
  const sport = Sports.get('basketball');
  const players = new Map(mkPlayers().map((p) => [p.id, p]));
  const r = E.validateEvent(sport, { type: 'fg2_made', player_id: 21, team_id: 1, period: 1 }, { playersById: players, homeId: 1, awayId: 2 });
  assert.equal(r.event.team_id, 2);
});

test('football: one completion credits QB and receiver yards, TD moves score, INT credits defender', () => {
  const c = run('football', [
    ev('pass_cmp', { team_id: 1, player_id: 11, player2_id: 12, value: 15 }),
    ev('pass_td', { team_id: 1, player_id: 11, player2_id: 13, value: 40 }),
    ev('int_thrown', { team_id: 1, player_id: 11, player2_id: 21 }),
    ev('rush', { team_id: 1, player_id: 12, value: 6 }),
    ev('rush', { team_id: 1, player_id: 12, value: -2 }),
    ev('xp_made', { team_id: 1, player_id: 13 }),
  ]);
  assert.equal(c.teams[0].score, 7);
  assert.equal(cell(c, 0, 'passing', '4', 'ca'), '2/3');
  assert.equal(cell(c, 0, 'passing', '4', 'pass_yds'), 55);
  assert.equal(cell(c, 0, 'passing', '4', 'pass_int'), 1);
  assert.equal(cell(c, 0, 'receiving', '23', 'rec_yds'), 15);
  assert.equal(cell(c, 0, 'receiving', '10', 'rec_td'), 1);
  assert.equal(cell(c, 0, 'rushing', '23', 'rush_yds'), 4);
  assert.equal(cell(c, 0, 'rushing', '23', 'avg'), '2.0');
  assert.equal(cell(c, 1, 'defense', '3', 'def_int'), 1);
  assert.equal(cell(c, 0, 'scoring', '10', 'pts'), 7); // 6 receiving TD + 1 XP
  assert.equal(c.teams[1].sections.some((s) => s.id === 'passing'), false);
});

test('football: required receiver and yard limits enforced', () => {
  const sport = Sports.get('football');
  const ctx = { playersById: new Map(mkPlayers().map((p) => [p.id, p])), homeId: 1, awayId: 2 };
  assert.match(E.validateEvent(sport, { type: 'pass_cmp', player_id: 11, value: 10, period: 1 }, ctx).error, /required/);
  assert.equal(E.validateEvent(sport, { type: 'pass_cmp', player_id: 11, player2_id: 12, value: 500, period: 1 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'rush', player_id: 12, value: 2.5, period: 1 }, ctx).ok, false);
});

test('baseball: pitcher gets auto credit; earned vs unearned; RBI via run; warnings without pitcher', () => {
  const c = run('baseball', [
    ev('pitcher_in', { team_id: 2, player_id: 21 }),
    ev('single', { team_id: 1, player_id: 11 }),
    ev('k', { team_id: 1, player_id: 12 }),
    ev('bb', { team_id: 1, player_id: 13 }),
    ev('run', { team_id: 1, player_id: 11, player2_id: 13, value: 1 }),
    ev('run', { team_id: 1, player_id: 13, value: 0 }),
    ev('out', { team_id: 1, player_id: 12 }),
  ]);
  assert.equal(c.teams[0].score, 2);
  assert.equal(cell(c, 0, 'batting', '4', 'h'), 1);
  assert.equal(cell(c, 0, 'batting', '4', 'r'), 1);
  assert.equal(cell(c, 0, 'batting', '10', 'rbi'), 1);
  assert.equal(cell(c, 0, 'batting', '23', 'ab'), 2);
  assert.equal(cell(c, 0, 'batting', '10', 'ab'), 0); // walk is not an AB
  assert.equal(cell(c, 1, 'pitching', '3', 'ip'), '0.2');
  assert.equal(cell(c, 1, 'pitching', '3', 'h_allowed'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'r_allowed'), 2);
  assert.equal(cell(c, 1, 'pitching', '3', 'er'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'k'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'bb_allowed'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'bf'), 4);
  assert.equal(c.warnings.length, 0);

  const noPitcher = run('baseball', [ev('single', { team_id: 1, player_id: 11 })]);
  assert.equal(noPitcher.warnings.length, 1);
  assert.match(noPitcher.warnings[0], /No pitcher is set/);
  assert.equal(cell(noPitcher, 0, 'batting', '4', 'h'), 1);
});

test('baseball: pitching change moves credit; HR is automatic run + RBI + earned; double play = 2 outs', () => {
  const c = run('baseball', [
    ev('pitcher_in', { team_id: 2, player_id: 21 }),
    ev('hr', { team_id: 1, player_id: 12 }),
    ev('pitcher_in', { team_id: 2, player_id: 22 }),
    ev('gidp', { team_id: 1, player_id: 11 }),
  ]);
  assert.equal(c.teams[0].score, 1);
  assert.equal(cell(c, 0, 'batting', '23', 'r'), 1);
  assert.equal(cell(c, 0, 'batting', '23', 'rbi'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'hr_allowed'), 1);
  assert.equal(cell(c, 1, 'pitching', '3', 'er'), 1);
  assert.equal(cell(c, 1, 'pitching', '15', 'ip'), '0.2');
  assert.equal(c.teams[1].currentRole, '#15 Moss');
});

test('removing (voiding) a pitching change re-attributes everything correctly', () => {
  const evs = [
    ev('pitcher_in', { team_id: 2, player_id: 21 }),
    ev('single', { team_id: 1, player_id: 11 }),
    ev('pitcher_in', { team_id: 2, player_id: 22, voided: true }),
    ev('single', { team_id: 1, player_id: 12 }),
  ];
  const c = run('baseball', evs);
  assert.equal(cell(c, 1, 'pitching', '3', 'h_allowed'), 2);
});

test('soccer: goal credits scorer, assister, keeper GA; shot on target credits save; own goal helps opponent', () => {
  const c = run('soccer', [
    ev('gk_in', { team_id: 2, player_id: 21 }),
    ev('gk_in', { team_id: 1, player_id: 13 }),
    ev('goal', { team_id: 1, player_id: 12, player2_id: 11 }),
    ev('shot_on', { team_id: 1, player_id: 12 }),
    ev('own_goal', { team_id: 2, player_id: 22 }),
    ev('goal', { team_id: 2, player_id: 22 }),
  ]);
  assert.equal(c.teams[0].score, 2);
  assert.equal(c.teams[1].score, 1);
  assert.equal(cell(c, 0, 'field', '23', 'g'), 1);
  assert.equal(cell(c, 0, 'field', '23', 'sh'), 2);
  assert.equal(cell(c, 0, 'field', '4', 'a'), 1);
  assert.equal(cell(c, 1, 'gk', '3', 'sv'), 1);
  assert.equal(cell(c, 1, 'gk', '3', 'ga'), 1);
  assert.equal(cell(c, 0, 'gk', '10', 'ga'), 1);
});

test('volleyball: rally scoring, errors give opponent the point, sets won, hitting pct, block assist', () => {
  const evs = [];
  for (let i = 0; i < 25; i++) evs.push(ev('kill', { team_id: 1, player_id: 12, player2_id: 11, period: 1 }));
  for (let i = 0; i < 10; i++) evs.push(ev('serve_err', { team_id: 1, player_id: 13, period: 1 })); // 10 for away
  evs.push(ev('attack_err', { team_id: 1, player_id: 12, period: 2 }));
  evs.push(ev('ace', { team_id: 2, player_id: 21, player2_id: 13, period: 2 }));
  evs.push(ev('block', { team_id: 1, player_id: 12, player2_id: 13, period: 2 }));
  evs.push(ev('block', { team_id: 1, player_id: 12, period: 2 }));
  evs.push(ev('opp_err', { team_id: 2, period: 2 }));
  evs.push(ev('team_err', { team_id: 1, period: 2 }));
  const c = run('volleyball', evs);
  assert.deepEqual(c.teams[0].periodPts.slice(0, 2), [25, 2]);
  assert.deepEqual(c.teams[1].periodPts.slice(0, 2), [10, 4]);
  assert.equal(c.currentPeriod, 2);
  assert.equal(c.teams[0].score, 1); // set 1 complete and won; set 2 still in progress
  assert.equal(c.teams[1].score, 0);
  assert.equal(cell(c, 0, 'box', '23', 'k'), 25);
  assert.equal(cell(c, 0, 'box', '23', 'pct'), '.923'); // (25-1)/26
  assert.equal(cell(c, 0, 'box', '4', 'ast'), 25);
  assert.equal(cell(c, 1, 'box', '3', 'sa'), 1);
  assert.equal(cell(c, 0, 'box', '10', 're'), 1);
  assert.equal(cell(c, 0, 'box', '23', 'blk'), 1.5); // 0.5 block assist + 1 solo
  const done = run('volleyball', evs, { final: true });
  assert.deepEqual([done.teams[0].score, done.teams[1].score], [1, 1]); // 2-4 loses set 2
});

test('checkpoints compare the log to the official scoreboard', () => {
  const c = run('basketball', [
    ev('fg2_made', { team_id: 1, player_id: 11, period: 1 }),
    ev('fg3_made', { team_id: 2, player_id: 21, period: 2 }),
  ]);
  const res = E.checkCheckpoints(c, [
    { id: 1, period: 1, home_score: 2, away_score: 0 },
    { id: 2, period: 2, home_score: 2, away_score: 5 },
    { id: 3, period: 2, home_score: 2, away_score: 3 },
  ]);
  assert.equal(res.length, 2);
  assert.equal(res[0].match, true);
  assert.equal(res[1].match, true); // latest entry for the period wins
  const bad = E.checkCheckpoints(c, [{ id: 1, period: 2, home_score: 4, away_score: 3 }]);
  assert.equal(bad[0].match, false);
  assert.deepEqual(bad[0].diff, [2, 0]);
});

test('every sport definition is internally consistent', () => {
  for (const sport of Object.values(Sports.SPORTS)) {
    const ids = new Set();
    for (const e of sport.events) {
      assert.ok(!ids.has(e.id), `${sport.id}: duplicate event ${e.id}`);
      ids.add(e.id);
      assert.ok(e.label && e.group && e.tone, `${sport.id}.${e.id} missing label/group/tone`);
      const keys = [
        ...Object.keys(e.stats || {}), ...Object.keys(e.statsWith || {}), ...Object.keys(e.valueStats || {}),
        ...Object.keys((e.secondary && e.secondary.stats) || {}), ...Object.keys((e.secondary && e.secondary.valueStats) || {}),
        ...Object.keys(e.teamStats || {}),
        ...Object.keys((e.defense && e.defense.stats) || {}), ...Object.keys((e.defense && e.defense.valueStats) || {}),
      ];
      for (const k of keys) assert.ok(sport.statLabels[k], `${sport.id}.${e.id} credits "${k}" which has no label`);
      if (e.defense) assert.ok(sport.roleLabel && sport.events.some((x) => x.setsRole), `${sport.id}.${e.id} uses defense credit but sport has no role event`);
      if (e.valueStats || (e.secondary && e.secondary.valueStats)) assert.ok(e.value, `${sport.id}.${e.id} has valueStats but no value`);
      assert.ok(E.explain(sport, e).length > 0 || e.setsRole, `${sport.id}.${e.id} explains to nothing`);
    }
    // an empty game computes cleanly and has the right sections
    const c = E.computeGame({ sport, teams: [H, A], players: mkPlayers(), events: [] });
    assert.equal(c.teams.length, 2);
    assert.equal(c.teams[0].score, 0);
  }
});

test('CSV export contains scores and rows', () => {
  const c = run('basketball', [ev('fg2_made', { team_id: 1, player_id: 12 })]);
  const csv = E.toCSV(c, { date: '2026-10-20' });
  assert.match(csv, /Home HS 2 - 0 Away HS/);
  assert.match(csv, /23,Johnson,2,1-1/);
  assert.match(csv, /TOTAL/);
});
