/*
 * Sport definitions.
 *
 * Everything a sport needs lives here as data: which buttons the keeper sees,
 * exactly which stats each button credits, how the score moves, and how the
 * box score is laid out. The same file runs in Node (validation, CSV, API) and
 * in the browser (live UI, offline keeper), so what the keeper sees, what the
 * public sees, and what the server stores can never disagree.
 *
 * Adding a sport = adding one object here. No other code changes.
 *
 * Event definition fields
 *   id, label, group, tone ('good'|'bad'|'neutral'), badge (small text on button)
 *   scope       'player' (default) | 'team'  (team events credit the team, not a player)
 *   stats       stats credited to the selected player
 *   statsWith   stats credited to the selected player INSTEAD when a 2nd player is named
 *   valueStats  { stat: multiplier } credited to selected player, multiplied by the entered value
 *   secondary   { team:'same'|'opp', prompt, required, stats, valueStats }  second player involved
 *   teamStats   stats credited to the team totals row only (e.g. team rebounds)
 *   teamScore   points added to the selected player's team
 *   oppScore    points added to the OTHER team (errors, own goals)
 *   defense     { stats, valueStats } credited to the opposing team's current pitcher/goalkeeper
 *   setsRole    true => this event sets the team's current pitcher/goalkeeper
 *   value       { label, kind:'number'|'choice', min, max, default, choices:[{label,value}] }
 *   lineup      'in' | 'out'  enters/leaves the court or field (drives minutes, starters, games played)
 *   decision    'W'|'L'|'SV'  a pitcher decision the scorer has confirmed (see engine proposals)
 *   oncePerGame true => only one live (non-voided) entry of this type per game
 *   hidden      true => not shown in the keeper's button grid (posted by a dedicated flow)
 *
 * Sport-level fields added in v2
 *   formats     [{ id, label, periods, periodNames, periodWord, periodLen, otLen, ... }] HS vs college rules.
 *               The first format is the default and is mirrored onto the sport itself.
 *   clock       true => events may carry clock_s (seconds ELAPSED in the period)
 *   minutes     true => lineup events produce minutes, starts and games played
 *   decisions   true => engine proposes pitcher W/L/SV for the scorer to confirm
 *   averages    [{ key, label, get }] per-game figures shown on season pages
 *   leaders     [{ id, label, get, mode, qual, qualText, ... }] leaderboard categories
 *   column.showIf(totals, sport) hides a column unless the game has data for it (e.g. minutes)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StatSports = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const col = (key, label, calc) => ({ key, label, calc: calc || ((s) => s[key] || 0) });
  const v = (s, k) => s[k] || 0;
  const made = (m, a) => `${m || 0}-${a || 0}`;
  const fixed = (num, den, d, lead0) => {
    if (!den) return lead0 === false ? '.000' : (0).toFixed(d);
    const out = (num / den).toFixed(d);
    return lead0 === false ? out.replace(/^0/, '') : out;
  };
  const pa = (s) => (s.ab || 0) + (s.bb || 0) + (s.hbp || 0) + (s.sf || 0) + (s.sh || 0);
  const era = (s, sp) => {
    if (!s.outs) return (s.er || 0) > 0 ? 'INF' : '0.00';
    return (((s.er || 0) * ((sp && sp.eraInnings) || 9) * 3) / s.outs).toFixed(2);
  };
  const ip = (outs) => `${Math.floor((outs || 0) / 3)}.${(outs || 0) % 3}`;
  const mmss = (sec) => `${Math.floor((sec || 0) / 60)}:${String(Math.round(sec || 0) % 60).padStart(2, '0')}`;
  const pctText = (num, den) => (den ? (num / den).toFixed(3).replace(/^(-?)0\./, '$1.') : '.000');

  /** Leader-board category helpers. mode: total (sum), avg (per game played), rate (qualified ratio). */
  const lead = (id, label, get, o) => Object.assign({ id, label, get, mode: 'total' }, o || {});
  const avgLead = (id, label, get, o) => lead(id, label, get, Object.assign({ mode: 'avg' }, o || {}));
  const rateLead = (id, label, get, qual, qualText, o) => lead(id, label, get, Object.assign({ mode: 'rate', qual, qualText, fmt: (x) => pctText(x, 1) }, o || {}));
  const avgStat = (key, label, get) => ({ key, label, get });

  /* ------------------------------------------------------------------ */
  /* BASKETBALL                                                          */
  /* ------------------------------------------------------------------ */
  const basketball = {
    id: 'basketball',
    name: 'Basketball',
    periodWord: 'Quarter',
    periods: 4,
    periodNames: ['Q1', 'Q2', 'Q3', 'Q4'],
    otName: (n) => (n === 1 ? 'OT' : `${n}OT`),
    allowOT: true,
    scoreMode: 'sum',
    clock: true, clockDir: 'down', minutes: true, onCourtMax: 5, periodLen: 480, otLen: 240,
    formats: [
      { id: 'hs', label: 'High school (4 x 8:00)', periods: 4, periodWord: 'Quarter', periodNames: ['Q1', 'Q2', 'Q3', 'Q4'], periodLen: 480, otLen: 240 },
      { id: 'college_w', label: 'College women (4 x 10:00)', periods: 4, periodWord: 'Quarter', periodNames: ['Q1', 'Q2', 'Q3', 'Q4'], periodLen: 600, otLen: 300 },
      { id: 'college_m', label: 'College men (2 x 20:00)', periods: 2, periodWord: 'Half', periodNames: ['1st', '2nd'], periodLen: 1200, otLen: 300 },
    ],
    statLabels: {
      pts: 'PTS', fgm: 'FG made', fga: 'FG attempted', tpm: '3PT made', tpa: '3PT attempted',
      ftm: 'FT made', fta: 'FT attempted', oreb: 'Off. rebound', dreb: 'Def. rebound',
      ast: 'Assist', stl: 'Steal', blk: 'Block', tov: 'Turnover', pf: 'Personal foul',
    },
    notes: [
      'Every made shot automatically counts as an attempt, and a made 3 counts as a made and attempted field goal too. The keeper never taps twice for one shot.',
      'Assists are optional on a made shot. The scorer cannot assist himself or herself, and the assist must come from the same team.',
      'Blocks and steals are credited to a player on the OTHER team, picked from that team\'s roster when you log the miss or the turnover.',
      'Team rebounds (out of bounds, dead ball) go to the team total only, never to a player.',
      'A player with 5 personal fouls is flagged as fouled out on the box score.',
      'Set the game clock to the time on the scoreboard and every play is stamped with it. Pick the starters at the start, then use Subs: minutes are counted from those entries. If the last period ended early, minutes in the final period are counted to the end of the period once the game is marked final.',
    ],
    flags: [{ stat: 'pf', gte: 5, label: 'Fouled out', tone: 'bad' }, { stat: 'pf', gte: 4, lt: 5, label: '4 fouls', tone: 'warn' }],
    chip: (s) => `${v(s, 'pts')} pts · ${v(s, 'pf')} pf`,
    chipWarn: (s) => v(s, 'pf') >= 4,
    events: [
      { id: 'fg2_made', label: '2PT Made', badge: '+2', group: 'Scoring', tone: 'good',
        stats: { pts: 2, fgm: 1, fga: 1 }, teamScore: 2,
        secondary: { team: 'same', prompt: 'Assist by', required: false, stats: { ast: 1 } } },
      { id: 'fg3_made', label: '3PT Made', badge: '+3', group: 'Scoring', tone: 'good',
        stats: { pts: 3, fgm: 1, fga: 1, tpm: 1, tpa: 1 }, teamScore: 3,
        secondary: { team: 'same', prompt: 'Assist by', required: false, stats: { ast: 1 } } },
      { id: 'ft_made', label: 'FT Made', badge: '+1', group: 'Scoring', tone: 'good',
        stats: { pts: 1, ftm: 1, fta: 1 }, teamScore: 1 },
      { id: 'fg2_miss', label: '2PT Miss', group: 'Misses', tone: 'bad',
        stats: { fga: 1 },
        secondary: { team: 'opp', prompt: 'Blocked by', required: false, stats: { blk: 1 } } },
      { id: 'fg3_miss', label: '3PT Miss', group: 'Misses', tone: 'bad',
        stats: { fga: 1, tpa: 1 },
        secondary: { team: 'opp', prompt: 'Blocked by', required: false, stats: { blk: 1 } } },
      { id: 'ft_miss', label: 'FT Miss', group: 'Misses', tone: 'bad', stats: { fta: 1 } },
      { id: 'oreb', label: 'Off Reb', group: 'Rebounds', tone: 'neutral', stats: { oreb: 1 } },
      { id: 'dreb', label: 'Def Reb', group: 'Rebounds', tone: 'neutral', stats: { dreb: 1 } },
      { id: 'tov', label: 'Turnover', group: 'Other', tone: 'bad', stats: { tov: 1 },
        secondary: { team: 'opp', prompt: 'Steal by', required: false, stats: { stl: 1 } } },
      { id: 'foul', label: 'Foul', group: 'Other', tone: 'bad', stats: { pf: 1 } },
      { id: 'sub_in', label: 'Enters game', group: 'Lineup', tone: 'neutral', lineup: 'in', hidden: true },
      { id: 'sub_out', label: 'Leaves game', group: 'Lineup', tone: 'neutral', lineup: 'out', hidden: true },
      { id: 'team_oreb', label: 'Team Off Reb', group: 'Team', scope: 'team', tone: 'neutral', teamStats: { oreb: 1 } },
      { id: 'team_dreb', label: 'Team Def Reb', group: 'Team', scope: 'team', tone: 'neutral', teamStats: { dreb: 1 } },
      { id: 'team_tov', label: 'Team Turnover', group: 'Team', scope: 'team', tone: 'bad', teamStats: { tov: 1 } },
    ],
    sections: [
      {
        id: 'box', title: 'Box score', showAll: true,
        columns: [
          Object.assign(col('min', 'MIN', (s) => (s.min_s ? mmss(s.min_s) : '')), { showIf: (t) => v(t, 'min_s') > 0 }),
          col('pts', 'PTS'),
          col('fg', 'FG', (s) => made(s.fgm, s.fga)),
          col('tp', '3PT', (s) => made(s.tpm, s.tpa)),
          col('ft', 'FT', (s) => made(s.ftm, s.fta)),
          col('oreb', 'OR'), col('dreb', 'DR'),
          col('reb', 'REB', (s) => v(s, 'oreb') + v(s, 'dreb')),
          col('ast', 'AST'), col('stl', 'STL'), col('blk', 'BLK'), col('tov', 'TO'), col('pf', 'PF'),
        ],
      },
    ],
    averages: [
      avgStat('ppg', 'PPG', (s) => v(s, 'pts')), avgStat('rpg', 'RPG', (s) => v(s, 'oreb') + v(s, 'dreb')), avgStat('apg', 'APG', (s) => v(s, 'ast')),
      avgStat('spg', 'SPG', (s) => v(s, 'stl')), avgStat('bpg', 'BPG', (s) => v(s, 'blk')),
      Object.assign(avgStat('mpg', 'MPG', (s) => v(s, 'min_s')), { time: true }),
    ],
    leaders: [
      avgLead('ppg', 'Points per game', (s) => v(s, 'pts')),
      avgLead('rpg', 'Rebounds per game', (s) => v(s, 'oreb') + v(s, 'dreb')),
      avgLead('apg', 'Assists per game', (s) => v(s, 'ast')),
      avgLead('spg', 'Steals per game', (s) => v(s, 'stl')),
      avgLead('bpg', 'Blocks per game', (s) => v(s, 'blk')),
      lead('pts', 'Total points', (s) => v(s, 'pts')),
      rateLead('fgp', 'Field goal %', (s) => (s.fga ? s.fgm / s.fga : null), (s, g) => v(s, 'fgm') >= 1.5 * g, 'min. 1.5 made per team game'),
      rateLead('tpp', '3-point %', (s) => (s.tpa ? s.tpm / s.tpa : null), (s, g) => v(s, 'tpm') >= 0.5 * g, 'min. 0.5 made per team game'),
      rateLead('ftp', 'Free throw %', (s) => (s.fta ? s.ftm / s.fta : null), (s, g) => v(s, 'ftm') >= 1 * g, 'min. 1 made per team game'),
    ],
  };

  /* ------------------------------------------------------------------ */
  /* FOOTBALL (11-man; yardage-based)                                     */
  /* ------------------------------------------------------------------ */
  const yards = (label, def, min, max) => ({ label, kind: 'number', min: min === undefined ? -20 : min, max: max === undefined ? 99 : max, default: def });
  const football = {
    id: 'football',
    name: 'Football',
    periodWord: 'Quarter',
    periods: 4,
    periodNames: ['Q1', 'Q2', 'Q3', 'Q4'],
    otName: (n) => (n === 1 ? 'OT' : `${n}OT`),
    allowOT: true,
    scoreMode: 'sum',
    clock: true, clockDir: 'down', periodLen: 720, otLen: 0,
    formats: [
      { id: 'hs', label: 'High school (4 x 12:00)', periods: 4, periodWord: 'Quarter', periodNames: ['Q1', 'Q2', 'Q3', 'Q4'], periodLen: 720, otLen: 0 },
      { id: 'college', label: 'College (4 x 15:00)', periods: 4, periodWord: 'Quarter', periodNames: ['Q1', 'Q2', 'Q3', 'Q4'], periodLen: 900, otLen: 0 },
    ],
    statLabels: {
      pass_cmp: 'Completion', pass_att: 'Pass attempt', pass_yds: 'Passing yds', pass_td: 'Passing TD', pass_int: 'Interception thrown',
      rush_att: 'Rush attempt', rush_yds: 'Rushing yds', rush_td: 'Rushing TD',
      rec: 'Reception', rec_yds: 'Receiving yds', rec_td: 'Receiving TD',
      tkl_solo: 'Solo tackle', tkl_ast: 'Assisted tackle', tfl: 'Tackle for loss', sack: 'Sack', def_int: 'Interception', pbu: 'Pass breakup',
      ff: 'Forced fumble', fr: 'Fumble recovery', fum: 'Fumble', fum_lost: 'Fumble lost', def_td: 'Return TD',
      fgm: 'FG made', fga: 'FG attempted', xpm: 'XP made', xpa: 'XP attempted', punts: 'Punt', punt_yds: 'Punt yds', pts: 'PTS',
    },
    notes: [
      'Yardage is entered once, on the play, and credited to everyone involved: a completion credits the passer\'s yards and the receiver\'s yards from a single entry.',
      'Touchdown buttons already include the attempt, completion/carry, yardage and 6 points. Never add a separate "completion" for a touchdown pass.',
      'Interceptions: log it on the quarterback and name the defender. The defender gets the interception, the QB gets the pass attempt and the INT.',
      'Tackles are credited by hand (solo or assisted). Tackles for loss and sacks are logged on top of the tackle so every number stays visible and auditable.',
      'Extra points, field goals, two-point conversions and safeties move the score automatically.',
    ],
    flags: [],
    chip: () => '',
    events: [
      { id: 'pass_cmp', label: 'Completion', group: 'Passing', tone: 'good',
        stats: { pass_cmp: 1, pass_att: 1 }, valueStats: { pass_yds: 1 },
        secondary: { team: 'same', prompt: 'Caught by', required: true, stats: { rec: 1 }, valueStats: { rec_yds: 1 } },
        value: yards('Yards on the play', 8, -15, 99) },
      { id: 'pass_td', label: 'Pass TD', badge: '+6', group: 'Passing', tone: 'good',
        stats: { pass_cmp: 1, pass_att: 1, pass_td: 1 }, valueStats: { pass_yds: 1 }, teamScore: 6,
        secondary: { team: 'same', prompt: 'Caught by', required: true, stats: { rec: 1, rec_td: 1, pts: 6 }, valueStats: { rec_yds: 1 } },
        value: yards('Yards of the pass', 20, 0, 99) },
      { id: 'pass_inc', label: 'Incomplete', group: 'Passing', tone: 'bad', stats: { pass_att: 1 },
        secondary: { team: 'opp', prompt: 'Broken up by', required: false, stats: { pbu: 1 } } },
      { id: 'int_thrown', label: 'Interception', group: 'Passing', tone: 'bad', stats: { pass_att: 1, pass_int: 1 },
        secondary: { team: 'opp', prompt: 'Intercepted by', required: false, stats: { def_int: 1 } } },
      { id: 'rush', label: 'Rush', group: 'Rushing', tone: 'good', stats: { rush_att: 1 }, valueStats: { rush_yds: 1 },
        value: yards('Yards gained (negative if lost)', 4, -25, 99) },
      { id: 'rush_td', label: 'Rush TD', badge: '+6', group: 'Rushing', tone: 'good',
        stats: { rush_att: 1, rush_td: 1, pts: 6 }, valueStats: { rush_yds: 1 }, teamScore: 6,
        value: yards('Yards of the run', 5, 0, 99) },
      { id: 'fumble_lost', label: 'Fumble Lost', group: 'Rushing', tone: 'bad', stats: { fum: 1, fum_lost: 1 } },
      { id: 'tackle_solo', label: 'Solo Tackle', group: 'Defense', tone: 'neutral', stats: { tkl_solo: 1 } },
      { id: 'tackle_ast', label: 'Assist Tackle', group: 'Defense', tone: 'neutral', stats: { tkl_ast: 1 } },
      { id: 'tfl', label: 'Tackle for Loss', group: 'Defense', tone: 'good', stats: { tfl: 1 } },
      { id: 'sack', label: 'Sack', group: 'Defense', tone: 'good', stats: { sack: 1 } },
      { id: 'forced_fumble', label: 'Forced Fumble', group: 'Defense', tone: 'good', stats: { ff: 1 } },
      { id: 'fumble_rec', label: 'Fumble Rec', group: 'Defense', tone: 'good', stats: { fr: 1 } },
      { id: 'td_other', label: 'Return TD', badge: '+6', group: 'Defense', tone: 'good', stats: { def_td: 1, pts: 6 }, teamScore: 6 },
      { id: 'xp_made', label: 'XP Good', badge: '+1', group: 'Kicking', tone: 'good', stats: { xpm: 1, xpa: 1, pts: 1 }, teamScore: 1 },
      { id: 'xp_miss', label: 'XP Miss', group: 'Kicking', tone: 'bad', stats: { xpa: 1 } },
      { id: 'fg_made', label: 'FG Good', badge: '+3', group: 'Kicking', tone: 'good', stats: { fgm: 1, fga: 1, pts: 3 }, teamScore: 3 },
      { id: 'fg_miss', label: 'FG Miss', group: 'Kicking', tone: 'bad', stats: { fga: 1 } },
      { id: 'two_pt', label: '2-Pt Good', badge: '+2', group: 'Kicking', tone: 'good', stats: { pts: 2 }, teamScore: 2 },
      { id: 'punt', label: 'Punt', group: 'Kicking', tone: 'neutral', stats: { punts: 1 }, valueStats: { punt_yds: 1 },
        value: yards('Punt yards', 38, 0, 90) },
      { id: 'safety', label: 'Safety', badge: '+2', group: 'Team', scope: 'team', tone: 'good', teamScore: 2 },
    ],
    sections: [
      { id: 'passing', title: 'Passing', visible: (s) => v(s, 'pass_att') > 0, columns: [
        col('ca', 'C/A', (s) => `${v(s, 'pass_cmp')}/${v(s, 'pass_att')}`), col('pass_yds', 'YDS'), col('pass_td', 'TD'), col('pass_int', 'INT') ] },
      { id: 'rushing', title: 'Rushing', visible: (s) => v(s, 'rush_att') > 0, columns: [
        col('rush_att', 'ATT'), col('rush_yds', 'YDS'), col('avg', 'AVG', (s) => fixed(s.rush_yds, s.rush_att, 1)), col('rush_td', 'TD'), col('fum_lost', 'LOST') ] },
      { id: 'receiving', title: 'Receiving', visible: (s) => v(s, 'rec') > 0, columns: [
        col('rec', 'REC'), col('rec_yds', 'YDS'), col('avg', 'AVG', (s) => fixed(s.rec_yds, s.rec, 1)), col('rec_td', 'TD') ] },
      { id: 'defense', title: 'Defense', visible: (s) => ['tkl_solo', 'tkl_ast', 'tfl', 'sack', 'def_int', 'pbu', 'ff', 'fr', 'def_td'].some((k) => v(s, k) > 0), columns: [
        col('tkl', 'TKL', (s) => v(s, 'tkl_solo') + v(s, 'tkl_ast')), col('tkl_solo', 'SOLO'), col('tkl_ast', 'AST'), col('tfl', 'TFL'),
        col('sack', 'SACK'), col('def_int', 'INT'), col('pbu', 'PBU'), col('ff', 'FF'), col('fr', 'FR'), col('def_td', 'TD') ] },
      { id: 'kicking', title: 'Kicking', visible: (s) => v(s, 'fga') + v(s, 'xpa') + v(s, 'punts') > 0, columns: [
        col('fg', 'FG', (s) => `${v(s, 'fgm')}/${v(s, 'fga')}`), col('xp', 'XP', (s) => `${v(s, 'xpm')}/${v(s, 'xpa')}`),
        col('punts', 'PUNTS'), col('pavg', 'AVG', (s) => fixed(s.punt_yds, s.punts, 1)) ] },
      { id: 'scoring', title: 'Points scored', visible: (s) => v(s, 'pts') > 0, columns: [col('pts', 'PTS')] },
    ],
    averages: [
      avgStat('ypg', 'Pass YPG', (s) => v(s, 'pass_yds')), avgStat('rypg', 'Rush YPG', (s) => v(s, 'rush_yds')), avgStat('cypg', 'Rec YPG', (s) => v(s, 'rec_yds')),
    ],
    leaders: [
      lead('pass_yds', 'Passing yards', (s) => v(s, 'pass_yds')), lead('pass_td', 'Passing TDs', (s) => v(s, 'pass_td')),
      lead('rush_yds', 'Rushing yards', (s) => v(s, 'rush_yds')), lead('rush_td', 'Rushing TDs', (s) => v(s, 'rush_td')),
      lead('rec', 'Receptions', (s) => v(s, 'rec')), lead('rec_yds', 'Receiving yards', (s) => v(s, 'rec_yds')), lead('rec_td', 'Receiving TDs', (s) => v(s, 'rec_td')),
      lead('tkl', 'Tackles', (s) => v(s, 'tkl_solo') + v(s, 'tkl_ast')), lead('sack', 'Sacks', (s) => v(s, 'sack')),
      lead('def_int', 'Interceptions', (s) => v(s, 'def_int')), lead('pts', 'Points', (s) => v(s, 'pts')),
    ],
  };

  /* ------------------------------------------------------------------ */
  /* BASEBALL / SOFTBALL                                                  */
  /* ------------------------------------------------------------------ */
  const baseballEvents = () => [
    { id: 'single', label: 'Single', group: 'Batting', tone: 'good',
      stats: { ab: 1, h: 1, tb: 1 }, defense: { stats: { bf: 1, h_allowed: 1 } } },
    { id: 'double', label: 'Double', group: 'Batting', tone: 'good',
      stats: { ab: 1, h: 1, tb: 2, d2: 1 }, defense: { stats: { bf: 1, h_allowed: 1 } } },
    { id: 'triple', label: 'Triple', group: 'Batting', tone: 'good',
      stats: { ab: 1, h: 1, tb: 3, d3: 1 }, defense: { stats: { bf: 1, h_allowed: 1 } } },
    { id: 'hr', label: 'Home Run', badge: '+1', group: 'Batting', tone: 'good',
      stats: { ab: 1, h: 1, tb: 4, hr: 1, r: 1, rbi: 1 }, teamScore: 1,
      defense: { stats: { bf: 1, h_allowed: 1, hr_allowed: 1, r_allowed: 1, er: 1 } } },
    { id: 'bb', label: 'Walk', group: 'Batting', tone: 'good', stats: { bb: 1 }, defense: { stats: { bf: 1, bb_allowed: 1 } } },
    { id: 'hbp', label: 'Hit by Pitch', group: 'Batting', tone: 'good', stats: { hbp: 1 }, defense: { stats: { bf: 1, hbp_allowed: 1 } } },
    { id: 'k', label: 'Strikeout', group: 'Batting', tone: 'bad', stats: { ab: 1, so: 1 }, defense: { stats: { bf: 1, outs: 1, k: 1 } } },
    { id: 'out', label: 'Out in Play', group: 'Batting', tone: 'bad', stats: { ab: 1 }, defense: { stats: { bf: 1, outs: 1 } } },
    { id: 'gidp', label: 'Double Play', group: 'Batting', tone: 'bad', stats: { ab: 1, gidp: 1 }, defense: { stats: { bf: 1, outs: 2 } } },
    { id: 'fc', label: "Fielder's Choice", group: 'Batting', tone: 'neutral', stats: { ab: 1 }, defense: { stats: { bf: 1, outs: 1 } } },
    { id: 'sf', label: 'Sac Fly', group: 'Batting', tone: 'neutral', stats: { sf: 1 }, defense: { stats: { bf: 1, outs: 1 } } },
    { id: 'sac', label: 'Sac Bunt', group: 'Batting', tone: 'neutral', stats: { sh: 1 }, defense: { stats: { bf: 1, outs: 1 } } },
    { id: 'roe', label: 'Reached on Error', group: 'Batting', tone: 'neutral', stats: { ab: 1 }, defense: { stats: { bf: 1 } } },
    { id: 'run', label: 'Run Scored', badge: '+1', group: 'Baserunning', tone: 'good',
      stats: { r: 1 }, teamScore: 1,
      secondary: { team: 'same', prompt: 'Driven in by (RBI)', required: false, stats: { rbi: 1 } },
      defense: { stats: { r_allowed: 1 }, valueStats: { er: 1 } },
      value: { label: 'Run type', kind: 'choice', default: 1, choices: [{ label: 'Earned', value: 1 }, { label: 'Unearned', value: 0 }] } },
    { id: 'sb', label: 'Stolen Base', group: 'Baserunning', tone: 'good', stats: { sb: 1 } },
    { id: 'cs', label: 'Caught Stealing', group: 'Baserunning', tone: 'bad', stats: { cs: 1 }, defense: { stats: { outs: 1 } } },
    { id: 'runner_out', label: 'Out on Bases', group: 'Baserunning', tone: 'bad', stats: { obr: 1 }, defense: { stats: { outs: 1 } } },
    { id: 'error', label: 'Error', group: 'Fielding', tone: 'bad', stats: { e: 1 } },
    { id: 'pitcher_in', label: 'Pitcher Enters', group: 'Pitching', tone: 'neutral', setsRole: true },
    // Decisions are never keyed by hand cold: the finish flow shows what the log suggests and the scorer confirms.
    { id: 'dec_w', label: 'Winning Pitcher', group: 'Decisions', tone: 'good', stats: { w: 1 }, decision: 'W', oncePerGame: true, hidden: true },
    { id: 'dec_l', label: 'Losing Pitcher', group: 'Decisions', tone: 'bad', stats: { l: 1 }, decision: 'L', oncePerGame: true, hidden: true },
    { id: 'dec_sv', label: 'Save', group: 'Decisions', tone: 'good', stats: { sv: 1 }, decision: 'SV', oncePerGame: true, hidden: true },
  ];

  const innings = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
  const baseballLike = (id, name, collegeInnings) => ({
    id, name,
    periodWord: 'Inning',
    periods: 7,
    periodNames: innings(7),
    otName: (n) => String(7 + n),
    allowOT: true,
    scoreMode: 'sum',
    decisions: true, eraInnings: 7, winMinOuts: 12,
    formats: [
      { id: 'hs', label: 'High school (7 innings)', periods: 7, periodNames: innings(7), otName: (n) => String(7 + n), eraInnings: 7, winMinOuts: 12 },
      { id: 'college', label: `College (${collegeInnings} innings)`, periods: collegeInnings, periodNames: innings(collegeInnings), otName: (n) => String(collegeInnings + n),
        eraInnings: collegeInnings, winMinOuts: collegeInnings === 9 ? 15 : 12 },
    ],
    roleLabel: 'pitcher',
    statLabels: {
      ab: 'AB', h: 'Hit', tb: 'Total bases', d2: 'Double', d3: 'Triple', hr: 'Home run', r: 'Run', rbi: 'RBI', bb: 'Walk', hbp: 'Hit by pitch',
      so: 'Strikeout', sb: 'Stolen base', cs: 'Caught stealing', sf: 'Sac fly', sh: 'Sac bunt', gidp: 'GIDP', obr: 'Out on bases', e: 'Error',
      bf: 'Batter faced', outs: 'Out recorded', h_allowed: 'Hit allowed', hr_allowed: 'HR allowed', r_allowed: 'Run allowed', er: 'Earned run',
      bb_allowed: 'Walk allowed', hbp_allowed: 'HBP allowed', k: 'Strikeout (pitching)',
      w: 'Win (pitcher)', l: 'Loss (pitcher)', sv: 'Save (pitcher)',
    },
    notes: [
      'Tap "Pitcher Enters" on the pitching team whenever a new pitcher takes the mound. Every batter result is then credited to that pitcher automatically, so nobody has to enter pitching stats by hand.',
      'If no pitcher has been set, batting stats still count but pitching credit is skipped and the box score shows a warning, so a missing pitcher is never silently guessed.',
      'A home run credits the batter\'s own run and RBI. For every other runner who scores, tap "Run Scored" on the runner and pick the batter under "Driven in by". That adds the RBI for each runner.',
      'Pick Earned or Unearned for each run. Earned runs are charged to the pitcher on the mound. Inherited-runner rules are not applied automatically; the scorer can adjust with a correction.',
      'Walks and hit-by-pitches are not at-bats. Sacrifices are not at-bats. Reaching on an error is an at-bat with no hit.',
      'Pitcher wins, losses and saves are PROPOSED from the play log when the game ends, with the reason shown, and the scorer confirms each one. Nothing is awarded without a confirmation.',
      'The proposal follows the standard official-scoring rule: the win goes to the pitcher of record when his team took the lead it never gave up (a starter must complete the minimum innings, otherwise the scorer picks the most effective reliever). The loss goes to the opposing pitcher on the mound at that moment.',
      'A save is proposed for the finishing pitcher of the winning team who is not the winner, entered with a lead of 3 or fewer and pitched at least one full inning, or pitched three innings. The "tying run on base or at bat" test is not computed; the scorer can add a save by hand.',
    ],
    flags: [],
    chip: (s) => `${v(s, 'h')}-${v(s, 'ab')}${v(s, 'r') ? ` · ${v(s, 'r')}R` : ''}`,
    events: baseballEvents(),
    sections: [
      { id: 'batting', title: 'Batting', showAll: true, columns: [
        col('ab', 'AB'), col('r', 'R'), col('h', 'H'), col('d2', '2B'), col('d3', '3B'), col('hr', 'HR'), col('rbi', 'RBI'),
        col('bb', 'BB'), col('so', 'K'), col('sb', 'SB'), col('avg', 'AVG', (s) => fixed(s.h, s.ab, 3, false)) ] },
      { id: 'pitching', title: 'Pitching', visible: (s) => v(s, 'bf') > 0 || v(s, 'outs') > 0 || v(s, 'w') + v(s, 'l') + v(s, 'sv') > 0, columns: [
        col('ip', 'IP', (s) => ip(s.outs)), col('h_allowed', 'H'), col('r_allowed', 'R'), col('er', 'ER'),
        col('bb_allowed', 'BB'), col('k', 'K'), col('hr_allowed', 'HR'), col('bf', 'BF'),
        Object.assign(col('w', 'W'), { showIf: (t) => v(t, 'w') + v(t, 'l') + v(t, 'sv') > 0 }),
        Object.assign(col('l', 'L'), { showIf: (t) => v(t, 'w') + v(t, 'l') + v(t, 'sv') > 0 }),
        Object.assign(col('sv', 'SV'), { showIf: (t) => v(t, 'w') + v(t, 'l') + v(t, 'sv') > 0 }),
        Object.assign(col('era', 'ERA', (s, sp) => era(s, sp)), { showIf: (t) => v(t, 'outs') > 0 }) ] },
      { id: 'fielding', title: 'Fielding', visible: (s) => v(s, 'e') > 0, columns: [col('e', 'E')] },
    ],
    averages: [],
    leaders: [
      rateLead('avg', 'Batting average', (s) => (s.ab ? s.h / s.ab : null), (s, g) => pa(s) >= 2 * g, 'min. 2 plate appearances per team game', { fmt: (x) => pctText(x, 1) }),
      lead('h', 'Hits', (s) => v(s, 'h')), lead('hr', 'Home runs', (s) => v(s, 'hr')), lead('rbi', 'RBI', (s) => v(s, 'rbi')),
      lead('r', 'Runs scored', (s) => v(s, 'r')), lead('sb', 'Stolen bases', (s) => v(s, 'sb')),
      rateLead('era', 'ERA', (s, sp) => (s.outs ? (v(s, 'er') * (sp.eraInnings || 9) * 3) / s.outs : null), (s, g) => v(s, 'outs') >= 3 * g,
        'min. 1 inning pitched per team game', { lowerBetter: true, fmt: (x) => x.toFixed(2) }),
      lead('k', 'Strikeouts (pitching)', (s) => v(s, 'k')), lead('w', 'Wins', (s) => v(s, 'w')), lead('sv', 'Saves', (s) => v(s, 'sv')),
    ],
  });

  const baseball = baseballLike('baseball', 'Baseball', 9);
  const softball = baseballLike('softball', 'Softball', 7);

  /* ------------------------------------------------------------------ */
  /* SOCCER                                                               */
  /* ------------------------------------------------------------------ */
  const soccer = {
    id: 'soccer',
    name: 'Soccer',
    periodWord: 'Half',
    periods: 2,
    periodNames: ['1st', '2nd'],
    otName: (n) => `ET${n}`,
    allowOT: true,
    scoreMode: 'sum',
    clock: true, clockDir: 'up', minutes: true, onCourtMax: 11, periodLen: 2400, otLen: 600,
    formats: [
      { id: 'hs', label: 'High school (2 x 40:00)', periods: 2, periodWord: 'Half', periodNames: ['1st', '2nd'], periodLen: 2400, otLen: 600 },
      { id: 'college', label: 'College (2 x 45:00)', periods: 2, periodWord: 'Half', periodNames: ['1st', '2nd'], periodLen: 2700, otLen: 600 },
    ],
    roleLabel: 'goalkeeper',
    statLabels: {
      g: 'Goal', a: 'Assist', sh: 'Shot', sog: 'Shot on target', sv: 'Save', ga: 'Goal against', fouls: 'Foul', yc: 'Yellow card',
      rc: 'Red card', off: 'Offside', og: 'Own goal', ck: 'Corner',
    },
    notes: [
      'Tap "Goalkeeper In" on the keeping team whenever the keeper changes. Saves and goals-against are then credited to that keeper automatically.',
      'A goal also counts as a shot and a shot on target. "On Target (saved)" credits the shooter with the shot and the current opposing keeper with the save.',
      'Own goals count for the opponent and do not count against the keeper.',
      'Assists are optional on a goal and must come from the scorer\'s own team.',
      'The clock counts up in soccer. Pick the starters at the start and use Subs when players come on or go off: minutes are counted from those entries, per half, and the box score says so if a team\'s lineup was not tracked.',
    ],
    flags: [{ stat: 'rc', gte: 1, label: 'Sent off', tone: 'bad' }, { stat: 'yc', gte: 2, label: 'Two yellows', tone: 'bad' }],
    chip: (s) => `${v(s, 'g')}g ${v(s, 'a')}a`,
    events: [
      { id: 'goal', label: 'Goal', badge: '+1', group: 'Scoring', tone: 'good', stats: { g: 1, sh: 1, sog: 1 }, teamScore: 1,
        secondary: { team: 'same', prompt: 'Assisted by', required: false, stats: { a: 1 } },
        defense: { stats: { ga: 1 } } },
      { id: 'pk_goal', label: 'Penalty Goal', badge: '+1', group: 'Scoring', tone: 'good', stats: { g: 1, sh: 1, sog: 1 }, teamScore: 1,
        defense: { stats: { ga: 1 } } },
      { id: 'own_goal', label: 'Own Goal', group: 'Scoring', tone: 'bad', stats: { og: 1 }, oppScore: 1 },
      { id: 'shot_on', label: 'On Target (saved)', group: 'Shots', tone: 'neutral', stats: { sh: 1, sog: 1 }, defense: { stats: { sv: 1 } } },
      { id: 'shot_off', label: 'Off Target', group: 'Shots', tone: 'neutral', stats: { sh: 1 } },
      { id: 'foul', label: 'Foul', group: 'Discipline', tone: 'bad', stats: { fouls: 1 } },
      { id: 'yellow', label: 'Yellow Card', group: 'Discipline', tone: 'bad', stats: { yc: 1 } },
      { id: 'red', label: 'Red Card', group: 'Discipline', tone: 'bad', stats: { rc: 1 } },
      { id: 'offside', label: 'Offside', group: 'Other', tone: 'neutral', stats: { off: 1 } },
      { id: 'gk_in', label: 'Goalkeeper In', group: 'Goalkeeper', tone: 'neutral', setsRole: true },
      { id: 'sub_in', label: 'Enters game', group: 'Lineup', tone: 'neutral', lineup: 'in', hidden: true },
      { id: 'sub_out', label: 'Leaves game', group: 'Lineup', tone: 'neutral', lineup: 'out', hidden: true },
      { id: 'corner', label: 'Corner Kick', group: 'Team', scope: 'team', tone: 'neutral', teamStats: { ck: 1 } },
    ],
    sections: [
      { id: 'field', title: 'Field players', showAll: true, columns: [
        Object.assign(col('min', 'MIN', (s) => (s.min_s ? mmss(s.min_s) : '')), { showIf: (t) => v(t, 'min_s') > 0 }),
        col('g', 'G'), col('a', 'A'), col('sh', 'SH'), col('sog', 'SOG'), col('fouls', 'FLS'), col('yc', 'YC'), col('rc', 'RC'), col('off', 'OFF') ] },
      { id: 'gk', title: 'Goalkeeping', visible: (s) => v(s, 'sv') + v(s, 'ga') > 0, columns: [
        col('sv', 'SV'), col('ga', 'GA'), col('svp', 'SV%', (s) => fixed(s.sv, (s.sv || 0) + (s.ga || 0), 3, false)) ] },
    ],
    averages: [avgStat('gpg', 'Goals/G', (s) => v(s, 'g')), avgStat('apg', 'Assists/G', (s) => v(s, 'a')), Object.assign(avgStat('mpg', 'Min/G', (s) => v(s, 'min_s')), { time: true })],
    leaders: [
      lead('g', 'Goals', (s) => v(s, 'g')), lead('a', 'Assists', (s) => v(s, 'a')),
      lead('pts', 'Points (2 per goal, 1 per assist)', (s) => 2 * v(s, 'g') + v(s, 'a')),
      lead('sh', 'Shots', (s) => v(s, 'sh')), lead('sv', 'Saves', (s) => v(s, 'sv')),
      rateLead('svp', 'Save %', (s) => (v(s, 'sv') + v(s, 'ga') ? s.sv / (v(s, 'sv') + v(s, 'ga')) : null), (s, g) => v(s, 'sv') + v(s, 'ga') >= 2 * g, 'min. 2 shots faced per team game'),
    ],
  };

  /* ------------------------------------------------------------------ */
  /* VOLLEYBALL (rally scoring, best of 5)                                */
  /* ------------------------------------------------------------------ */
  const volleyball = {
    id: 'volleyball',
    name: 'Volleyball',
    periodWord: 'Set',
    periods: 5,
    periodNames: ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'],
    otName: (n) => `Set ${5 + n}`,
    allowOT: false,
    scoreMode: 'sets',
    setTargets: [25, 25, 25, 25, 15],
    formats: [
      { id: 'bo5', label: 'Best of 5 (college, many HS)', periods: 5, periodNames: ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'], setTargets: [25, 25, 25, 25, 15], otName: (n) => `Set ${5 + n}` },
      { id: 'bo3', label: 'Best of 3', periods: 3, periodNames: ['Set 1', 'Set 2', 'Set 3'], setTargets: [25, 25, 15], otName: (n) => `Set ${3 + n}` },
    ],
    statLabels: {
      k: 'Kill', ae: 'Attack error', ta: 'Attack attempt', ast: 'Assist', sa: 'Ace', se: 'Service error', dig: 'Dig',
      bs: 'Solo block', ba: 'Block assist', re: 'Reception error', bhe: 'Ball-handling error',
    },
    notes: [
      'Every point is logged on the player or team that earned or lost it. The set score is computed from those entries, so the scorebook and the scoreboard can be checked against each other.',
      'A kill, ace or block moves the score for that team. An attack error, service error, reception error or ball-handling error gives the point to the opponent.',
      'On an ace, name the receiver who made the error right on the ace entry. Do not enter a separate reception error for the same serve.',
      'Blocks: tap the blocker. If a second player was also on the block, pick them as the block assist, and each gets a block assist. With no second player it is a solo block.',
      'Hitting percentage = (kills - errors) / total attempts. Every kill and error already counts as an attempt.',
      'A set is won by the higher score once the set is complete. Use the scoreboard check to confirm the set score before moving on.',
    ],
    flags: [],
    chip: (s) => `${v(s, 'k')}k ${v(s, 'dig')}d`,
    events: [
      { id: 'kill', label: 'Kill', badge: '+1', group: 'Attack', tone: 'good', stats: { k: 1, ta: 1 }, teamScore: 1,
        secondary: { team: 'same', prompt: 'Set by (assist)', required: false, stats: { ast: 1 } } },
      { id: 'attack_err', label: 'Attack Error', group: 'Attack', tone: 'bad', stats: { ae: 1, ta: 1 }, oppScore: 1 },
      { id: 'attack_play', label: 'Attack (in play)', group: 'Attack', tone: 'neutral', stats: { ta: 1 } },
      { id: 'ace', label: 'Ace', badge: '+1', group: 'Serve', tone: 'good', stats: { sa: 1 }, teamScore: 1,
        secondary: { team: 'opp', prompt: 'Reception error by', required: false, stats: { re: 1 } } },
      { id: 'serve_err', label: 'Service Error', group: 'Serve', tone: 'bad', stats: { se: 1 }, oppScore: 1 },
      { id: 'block', label: 'Block', badge: '+1', group: 'Defense', tone: 'good', stats: { bs: 1 }, statsWith: { ba: 1 }, teamScore: 1,
        secondary: { team: 'same', prompt: 'Block assist (2nd blocker)', required: false, stats: { ba: 1 } } },
      { id: 'dig', label: 'Dig', group: 'Defense', tone: 'neutral', stats: { dig: 1 } },
      { id: 'recv_err', label: 'Reception Error', group: 'Errors', tone: 'bad', stats: { re: 1 }, oppScore: 1 },
      { id: 'bhe', label: 'Ball-Handling Error', group: 'Errors', tone: 'bad', stats: { bhe: 1 }, oppScore: 1 },
      { id: 'team_err', label: 'Team Error (pt to opp)', group: 'Team', scope: 'team', tone: 'bad', oppScore: 1 },
      { id: 'opp_err', label: 'Opponent Error (pt)', badge: '+1', group: 'Team', scope: 'team', tone: 'good', teamScore: 1 },
    ],
    sections: [
      { id: 'box', title: 'Box score', showAll: true, columns: [
        col('k', 'K'), col('ae', 'E'), col('ta', 'TA'),
        col('pct', 'PCT', (s) => (s.ta ? ((v(s, 'k') - v(s, 'ae')) / s.ta).toFixed(3).replace(/^(-?)0\./, '$1.') : '.000')),
        col('ast', 'AST'), col('sa', 'SA'), col('se', 'SE'), col('dig', 'DIG'),
        col('blk', 'BLK', (s) => v(s, 'bs') + v(s, 'ba') / 2), col('re', 'RE'), col('bhe', 'BHE') ] },
    ],
    averages: [avgStat('kpg', 'Kills/G', (s) => v(s, 'k')), avgStat('dpg', 'Digs/G', (s) => v(s, 'dig')), avgStat('apg', 'Aces/G', (s) => v(s, 'sa'))],
    leaders: [
      lead('k', 'Kills', (s) => v(s, 'k')), lead('sa', 'Aces', (s) => v(s, 'sa')), lead('dig', 'Digs', (s) => v(s, 'dig')),
      lead('ast', 'Assists', (s) => v(s, 'ast')), lead('blk', 'Blocks', (s) => v(s, 'bs') + v(s, 'ba') / 2),
      rateLead('pct', 'Hitting percentage', (s) => (s.ta ? (v(s, 'k') - v(s, 'ae')) / s.ta : null), (s, g) => v(s, 'ta') >= 10 * g, 'min. 10 attack attempts per team match'),
    ],
  };

  /* ------------------------------------------------------------------ */
  const SPORTS = { basketball, football, baseball, softball, soccer, volleyball };
  for (const sport of Object.values(SPORTS)) {
    sport.eventMap = {};
    for (const e of sport.events) sport.eventMap[e.id] = e;
    sport.maxPeriods = sport.allowOT ? sport.periods + 6 : sport.periods;
  }

  // Mirror the first (default) format onto the sport so Sports.get(id) behaves like v1.
  for (const sport of Object.values(SPORTS)) {
    const f0 = sport.formats && sport.formats[0];
    if (f0) Object.assign(sport, f0, { id: sport.id });
    sport.formatId = f0 ? f0.id : null;
    sport.maxPeriods = sport.allowOT ? sport.periods + 6 : sport.periods;
  }

  /** The sport as played at a given level, e.g. resolve('basketball','college_m'). Unknown format => default. */
  function resolve(sportOrId, formatId) {
    const base = typeof sportOrId === 'string' ? SPORTS[sportOrId] : sportOrId;
    if (!base) return null;
    const f = (base.formats || []).find((x) => x.id === formatId) || (base.formats || [])[0];
    if (!f) return base;
    const out = Object.assign({}, base, f, { id: base.id, formatId: f.id, formatLabel: f.label });
    out.maxPeriods = out.allowOT ? out.periods + 6 : out.periods;
    return out;
  }

  function periodLength(sport, period) {
    if (!sport.clock) return 0;
    return period <= sport.periods ? sport.periodLen : sport.otLen;
  }

  return {
    SPORTS,
    get: (id) => SPORTS[id] || null,
    resolve,
    periodLength,
    formats: (id) => (SPORTS[id] && SPORTS[id].formats ? SPORTS[id].formats.map((f) => ({ id: f.id, label: f.label })) : []),
    list: () => Object.values(SPORTS).map((s) => ({ id: s.id, name: s.name, clock: !!s.clock, minutes: !!s.minutes, formats: (s.formats || []).map((f) => ({ id: f.id, label: f.label })) })),
  };
});
