const test = require('node:test');
const assert = require('node:assert/strict');
const Sports = require('../shared/sports');
const E = require('../shared/engine');

const H = { id: 1, name: 'Home HS' };
const A = { id: 2, name: 'Away HS' };
const players = () => [
  { id: 11, team_id: 1, jersey: '4', name: 'Lee' },
  { id: 12, team_id: 1, jersey: '23', name: 'Johnson' },
  { id: 13, team_id: 1, jersey: '10', name: 'Cruz' },
  { id: 21, team_id: 2, jersey: '3', name: 'Ray' },
  { id: 22, team_id: 2, jersey: '15', name: 'Moss' },
];
let nid = 1;
const ev = (type, o = {}) => ({ id: nid++, type, period: 1, ...o });
const game = (sport, events, extra = {}) => E.computeGame({ sport, teams: [H, A], players: players(), events, ...extra });
const sec = (c, ti, id) => c.teams[ti].sections.find((s) => s.id === id);
const cellOf = (c, ti, id, jersey, key) => {
  const s = sec(c, ti, id);
  return s.rows.find((r) => r.jersey === jersey).cells[s.columns.findIndex((x) => x.key === key)];
};

/* ---------------- formats and clock ---------------- */

test('formats: the same sport has different periods at different levels', () => {
  const hs = Sports.resolve('basketball', 'hs');
  const m = Sports.resolve('basketball', 'college_m');
  assert.equal(hs.periods, 4); assert.equal(hs.periodLen, 480);
  assert.equal(m.periods, 2); assert.equal(m.periodWord, 'Half'); assert.equal(m.periodLen, 1200);
  assert.equal(Sports.resolve('baseball', 'college').periods, 9);
  assert.equal(Sports.resolve('softball', 'college').periods, 7);
  assert.equal(Sports.resolve('volleyball', 'bo3').periods, 3);
  assert.equal(Sports.resolve('basketball', 'nonsense').periods, 4); // unknown => default
  const c = game('basketball', [ev('fg2_made', { team_id: 1, player_id: 12, period: 3 })], { format: 'college_m' });
  assert.deepEqual(c.periodNames.slice(0, 3), ['1st', '2nd', 'OT']);
  assert.equal(c.format, 'college_m');
  // the default Sports.get still behaves like v1
  assert.equal(Sports.get('basketball').periods, 4);
});

test('clock: validated against the period length; subs require a clock', () => {
  const sport = Sports.resolve('basketball', 'hs');
  const ctx = { playersById: new Map(players().map((p) => [p.id, p])), homeId: 1, awayId: 2 };
  const ok = E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 1, clock_s: 300 }, ctx);
  assert.equal(ok.ok, true); assert.equal(ok.event.clock_s, 300);
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 1, clock_s: 481 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 1, clock_s: -1 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 1 }, ctx).event.clock_s, null);
  assert.equal(E.validateEvent(sport, { type: 'sub_in', player_id: 12, period: 1 }, ctx).ok, false);
  assert.equal(E.validateEvent(sport, { type: 'sub_in', player_id: 12, period: 1, clock_s: 0 }, ctx).ok, true);
  // OT is shorter than a regulation quarter
  assert.equal(E.validateEvent(sport, { type: 'fg2_made', player_id: 12, period: 5, clock_s: 300 }, ctx).ok, false);
  // sports with no clock ignore it rather than storing nonsense
  const base = Sports.resolve('baseball', 'hs');
  const r = E.validateEvent(base, { type: 'single', player_id: 11, period: 1, clock_s: 40 }, ctx);
  assert.equal(r.ok, true); assert.equal(r.event.clock_s, null);
});

/* ---------------- minutes ---------------- */

test('minutes: computed from lineup events, across periods, starters flagged', () => {
  const c = game('basketball', [
    ev('sub_in', { team_id: 1, player_id: 11, clock_s: 0 }),
    ev('sub_in', { team_id: 1, player_id: 12, clock_s: 0 }),
    ev('sub_out', { team_id: 1, player_id: 11, clock_s: 300 }),
    ev('sub_in', { team_id: 1, player_id: 13, clock_s: 300 }),
    ev('sub_out', { team_id: 1, player_id: 12, period: 2, clock_s: 120 }),
    ev('fg2_made', { team_id: 1, player_id: 13, period: 2, clock_s: 200 }),
  ], { format: 'hs' });
  const s = c.playerStats;
  assert.equal(s[11].min_s, 300);
  assert.equal(s[12].min_s, 480 + 120);
  assert.equal(s[13].min_s, 180 + 200); // still in: counted to the latest clock reading
  assert.equal(s[11].gs, 1); assert.equal(s[12].gs, 1); assert.equal(s[13].gs, undefined);
  assert.equal(s[13].gp, 1);
  assert.equal(cellOf(c, 0, 'box', '23', 'min'), '10:00');
  assert.deepEqual(c.teams[0].onCourt, [13]);
  const fin = game('basketball', [
    ev('sub_in', { team_id: 1, player_id: 13, period: 4, clock_s: 100 }),
    ev('fg2_made', { team_id: 1, player_id: 13, period: 4, clock_s: 200 }),
  ], { format: 'hs', final: true });
  assert.equal(fin.playerStats[13].min_s, 480 - 100); // final: played to the end of the period
});

test('minutes: game-time order wins over entry order (late or offline entries)', () => {
  const c = game('basketball', [
    ev('sub_out', { team_id: 1, player_id: 11, clock_s: 300 }), // entered first
    ev('sub_in', { team_id: 1, player_id: 11, clock_s: 0 }),    // happened first
  ]);
  assert.equal(c.playerStats[11].min_s, 300);
  assert.equal(c.warnings.length, 0);
});

test('minutes: honest warnings for bad lineups, nothing hidden', () => {
  const c = game('basketball', [
    ev('sub_in', { team_id: 1, player_id: 11, clock_s: 0 }),
    ev('sub_in', { team_id: 1, player_id: 11, clock_s: 10 }),
    ev('sub_out', { team_id: 1, player_id: 12, clock_s: 50 }),
    ev('fg2_made', { team_id: 1, player_id: 13, clock_s: 60 }),
  ]);
  const w = c.warnings.join(' | ');
  assert.match(w, /entered twice/);
  assert.match(w, /never entered/);
  assert.match(w, /never entered in the lineup/);
  const crowd = game('basketball', [1, 2, 3, 4, 5, 6].map((i) => ev('sub_in', { team_id: 1, player_id: 100 + i, clock_s: 0 })),
    { players: [...players(), ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: 100 + i, team_id: 1, jersey: String(50 + i), name: `P${i}` }))] });
  assert.match(crowd.warnings.join(' '), /6 players are entered at once/);
});

test('minutes: column only appears when the lineup was tracked; untracked team is never penalised', () => {
  const plain = game('basketball', [ev('fg2_made', { team_id: 1, player_id: 12 })]);
  assert.ok(!sec(plain, 0, 'box').columns.some((x) => x.key === 'min'));
  assert.equal(plain.warnings.length, 0);
  const one = game('basketball', [ev('sub_in', { team_id: 1, player_id: 11, clock_s: 0 }), ev('fg2_made', { team_id: 2, player_id: 21 })]);
  assert.equal(one.warnings.length, 0);                  // away team's lineup was not tracked, so nothing is claimed about it
  assert.equal(one.playerStats[21].min_s, undefined);
  assert.equal(one.teams[1].lineupTracked, false);
});

test('minutes: soccer halves', () => {
  const c = game('soccer', [
    ev('sub_in', { team_id: 1, player_id: 12, clock_s: 0 }),
    ev('sub_out', { team_id: 1, player_id: 12, period: 2, clock_s: 600 }),
  ], { format: 'hs' });
  assert.equal(c.playerStats[12].min_s, 2400 + 600);
  assert.equal(cellOf(c, 0, 'field', '23', 'min'), '50:00');
});

/* ---------------- pitcher decisions ---------------- */

const ks = (team, player, n) => Array.from({ length: n }, () => ev('k', { team_id: team, player_id: player }));
const runEv = (team, player) => ev('run', { team_id: team, player_id: player, value: 1 });

test('decisions: starter who kept the lead gets the win, reliever the save, losing pitcher the loss', () => {
  const c = game('baseball', [
    ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }),
    runEv(1, 13),
    ...ks(2, 22, 12),                                   // starter 11 gets 12 outs
    ev('pitcher_in', { team_id: 1, player_id: 12 }),
    ...ks(2, 22, 3),
  ], { format: 'hs', final: true });
  const d = c.decisions;
  assert.equal(d.decided, true);
  const by = (k) => d.proposals.find((p) => p.decision === k);
  assert.equal(by('W').player_id, 11);
  assert.equal(by('L').player_id, 21);
  assert.equal(by('SV').player_id, 12);
  assert.equal(by('W').needsJudgment, false);
  // proposals do not change stats until confirmed
  assert.equal(c.playerStats[11].w, undefined);
});

test('decisions: a starter who did not go the minimum innings => scorer judgement, suggested reliever, no save for the winner', () => {
  const c = game('baseball', [
    ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }),
    runEv(1, 13),
    ...ks(2, 22, 6),
    ev('pitcher_in', { team_id: 1, player_id: 12 }),
    ...ks(2, 22, 9),
  ], { format: 'hs', final: true });
  const w = c.decisions.proposals.find((p) => p.decision === 'W');
  assert.equal(w.player_id, 12); assert.equal(w.needsJudgment, true);
  assert.match(w.reason, /scorer chooses/);
  assert.equal(c.decisions.proposals.some((p) => p.decision === 'SV'), false);
});

test('decisions: the lead must be the one never given up; ties and unfinished games propose nothing', () => {
  const evs = () => [
    ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }),
    runEv(1, 13), runEv(2, 21), runEv(2, 22),
    ...ks(1, 13, 12),
  ];
  const c = game('baseball', evs(), { format: 'hs', final: true });
  const by = (k) => c.decisions.proposals.find((p) => p.decision === k);
  assert.equal(by('W').player_id, 21);   // team 2 took the final lead on its second run
  assert.equal(by('L').player_id, 11);
  const tie = game('baseball', [ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }), runEv(1, 13), runEv(2, 21)], { final: true });
  assert.equal(tie.decisions.proposals.length, 0);
  const live = game('baseball', evs(), { format: 'hs', final: false });
  assert.equal(live.decisions.proposals.length, 0);
});

test('decisions: scorer-confirmed events count, are compared with the proposal, and may be recorded once', () => {
  const base = [
    ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }),
    runEv(1, 13), ...ks(2, 22, 12),
  ];
  const ok = game('baseball', [...base, ev('dec_w', { team_id: 1, player_id: 11 }), ev('dec_l', { team_id: 2, player_id: 21 })], { final: true, format: 'hs' });
  assert.equal(ok.playerStats[11].w, 1); assert.equal(ok.playerStats[21].l, 1);
  assert.equal(ok.decisions.differs.length, 0);
  assert.equal(ok.warnings.length, 0);
  const other = game('baseball', [...base, ev('dec_w', { team_id: 1, player_id: 12 })], { final: true, format: 'hs' });
  assert.equal(other.playerStats[12].w, 1);                     // the scorer is the authority
  assert.equal(other.decisions.differs[0].decision, 'W');       // but the difference is visible
  const wrong = game('baseball', [...base, ev('dec_w', { team_id: 2, player_id: 21 })], { final: true, format: 'hs' });
  assert.match(wrong.warnings.join(' '), /losing team/);
  const sport = Sports.resolve('baseball', 'hs');
  const ctx = { playersById: new Map(players().map((p) => [p.id, p])), homeId: 1, awayId: 2, liveEvents: [{ type: 'dec_w', voided: false }] };
  assert.equal(E.validateEvent(sport, { type: 'dec_w', player_id: 11, period: 1 }, ctx).ok, false);
  ctx.liveEvents = [{ type: 'dec_w', voided: true }];
  assert.equal(E.validateEvent(sport, { type: 'dec_w', player_id: 11, period: 1 }, ctx).ok, true);
});

test('pitching line shows W-L-SV and ERA with the right innings for the level', () => {
  const c = game('baseball', [
    ev('pitcher_in', { team_id: 1, player_id: 11 }), ev('pitcher_in', { team_id: 2, player_id: 21 }),
    runEv(1, 13), ...ks(2, 22, 12), ev('dec_w', { team_id: 1, player_id: 11 }),
  ], { final: true, format: 'hs' });
  assert.equal(cellOf(c, 0, 'pitching', '4', 'w'), 1);
  assert.equal(cellOf(c, 0, 'pitching', '4', 'era'), '0.00');
  const era = (fmt, stats) => {
    const sp = Sports.resolve('baseball', fmt);
    return sp.sections.find((s) => s.id === 'pitching').columns.find((x) => x.key === 'era').calc(stats, sp);
  };
  assert.equal(era('college', { er: 3, outs: 27 }), '3.00');  // 9-inning game
  assert.equal(era('hs', { er: 3, outs: 27 }), '2.33');        // 7-inning game
  assert.equal(era('hs', { er: 1, outs: 0 }), 'INF');
});

/* ---------------- seasons and leaders ---------------- */

test('season label runs August to July', () => {
  assert.equal(E.seasonLabel('2026-10-31'), '2026-27');
  assert.equal(E.seasonLabel('2027-03-04'), '2026-27');
  assert.equal(E.seasonLabel('2027-08-01'), '2027-28');
  assert.equal(E.seasonLabel('2000-01-01'), '1999-00');
  assert.equal(E.seasonLabel(null), 'Unknown');
});

test('sumStats adds everything, including games played and minutes', () => {
  assert.deepEqual(E.sumStats([{ pts: 10, gp: 1, min_s: 600 }, { pts: 4, gp: 1, ast: 2 }, {}]), { pts: 14, gp: 2, min_s: 600, ast: 2 });
});

test('averages use games played, minutes use games with minutes tracked', () => {
  const sp = Sports.resolve('basketball', 'hs');
  const line = E.averagesLine(sp, { gp: 10, pts: 200, oreb: 10, dreb: 40, min_s: 6000, min_g: 5 });
  const get = (k) => line.find((x) => x.key === k).value;
  assert.equal(get('ppg'), '20.0'); assert.equal(get('rpg'), '5.0'); assert.equal(get('mpg'), '20:00');
  assert.equal(E.averagesLine(sp, { gp: 0 })[0].value, '-');
});

test('leaders: totals, per-game needing half the games, rate stats needing a minimum, ties share a rank', () => {
  const sp = Sports.resolve('basketball', 'hs');
  const row = (id, name, stats, teamGames = 10) => ({ player_id: id, team_id: 1, team_name: 'T', jersey: String(id), name, stats, teamGames });
  const rows = [
    row(1, 'Ann', { gp: 10, pts: 200, fgm: 80, fga: 160 }),
    row(2, 'Bea', { gp: 10, pts: 200, fgm: 3, fga: 3 }),        // ties Ann on points, but 3 attempts must not top FG%
    row(3, 'Cy', { gp: 2, pts: 90, fgm: 40, fga: 50 }),         // great in 2 games: not enough games for per-game
    row(4, 'Di', { gp: 10, pts: 10, fgm: 16, fga: 40 }),
  ];
  const cats = Object.fromEntries(E.computeLeaders(sp, rows).map((c) => [c.id, c]));
  assert.deepEqual(cats.pts.leaders.map((l) => [l.name, l.rank]), [['Ann', 1], ['Bea', 1], ['Cy', 3], ['Di', 4]]);   // ties share a rank, next rank skips
  assert.equal(cats.pts.leaders[0].tied, true);
  assert.equal(cats.pts.leaders[2].tied, false);
  assert.deepEqual(cats.ppg.leaders.map((l) => l.name), ['Ann', 'Bea', 'Di']);    // Cy: 2 games is under half of 10
  assert.equal(cats.ppg.leaders[0].display, '20.0');
  assert.deepEqual(cats.fgp.leaders.map((l) => l.name), ['Cy', 'Ann', 'Di']);     // Bea: 3 made is under 1.5 per team game
  assert.equal(cats.fgp.leaders[0].display, '.800');
  assert.ok(cats.fgp.qualText.includes('1.5 made'));
  const limited = E.computeLeaders(sp, rows, { limit: 1 }).find((c) => c.id === 'pts').leaders;
  assert.equal(limited.length, 2);                                                 // a tie at the cut-off keeps both players
});
