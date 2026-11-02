'use strict';
/*
 * Two-books reconciliation.
 *
 * Each team may keep its own book of a game. When both books are final they are compared line by line: each team's
 * score and every counted stat for every player of both teams. Nothing is stored except the pair, the moment of
 * first comparison, and any "ours stands" notes, so the comparison is always derived from the two event logs.
 *
 * Line status:
 *   agreed    both books show the same number
 *   review    the numbers differ and the review window is still open (either team can fix its own book)
 *   disputed  the numbers differ and either the window has closed or both teams said "ours stands"
 * Pair state: one_book | waiting | agreed | in_review | settled
 * Each team keeps its own number on a disputed line. Leaderboards and season pages read each team's own book.
 */
const REVIEW_HOURS = Number(process.env.REVIEW_HOURS) > 0 ? Number(process.env.REVIEW_HOURS) : 48;
const SKIP = new Set(['gs']);

const LABELS = {
  pts: 'Points', reb: 'Rebounds', oreb: 'Off. rebounds', dreb: 'Def. rebounds', ast: 'Assists', stl: 'Steals', blk: 'Blocks', to: 'Turnovers',
  pf: 'Fouls', fgm: 'FG made', fga: 'FG attempts', fg3m: '3PT made', fg3a: '3PT attempts', ftm: 'FT made', fta: 'FT attempts', gp: 'Played',
};
const labelOf = (k) => LABELS[k] || k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const jerseyKey = (p) => String(p.jersey).toLowerCase();

/** Compare two final summaries (from stats.finalSummary). `a` and `b` are the two books. Pure. */
function compare(a, b) {
  const lines = [];
  let agreed = 0;
  const push = (line) => { if (line.a === line.b) agreed += 1; else lines.push(line); };
  for (const t of a.teams) {
    const tb = b.teams.find((x) => x.id === t.id);
    push({ key: `${t.id}:score`, team_id: t.id, team_name: t.name, jersey: null, name: 'Team score', stat: 'score', label: 'Final score', a: t.score, b: tb ? tb.score : 0 });
    const pa = new Map(a.players.filter((p) => p.team_id === t.id).map((p) => [jerseyKey(p), p]));
    const pb = new Map(b.players.filter((p) => p.team_id === t.id).map((p) => [jerseyKey(p), p]));
    for (const j of new Set([...pa.keys(), ...pb.keys()])) {
      const p = pa.get(j) || pb.get(j);
      const sa = (pa.get(j) && a.playerStats[pa.get(j).id]) || {};
      const sb = (pb.get(j) && b.playerStats[pb.get(j).id]) || {};
      const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
      for (const k of keys) {
        if (SKIP.has(k) || typeof (sa[k] ?? sb[k]) !== 'number') continue;
        push({ key: `${t.id}:${j}:${k}`, team_id: t.id, team_name: t.name, jersey: p.jersey, name: p.name, stat: k, label: labelOf(k), a: sa[k] || 0, b: sb[k] || 0 });
      }
    }
  }
  return { lines, agreed };
}

function windowOf(comparedAt, now) {
  if (!comparedAt) return { opensAt: null, closesAt: null, open: true, hoursLeft: REVIEW_HOURS };
  const closes = new Date(new Date(comparedAt).getTime() + REVIEW_HOURS * 3600 * 1000);
  const ms = closes.getTime() - (now || new Date()).getTime();
  return { opensAt: new Date(comparedAt).toISOString(), closesAt: closes.toISOString(), open: ms > 0, hoursLeft: Math.max(0, Math.ceil(ms / 3600000)) };
}

/** Pure status logic so it can be tested without a database. */
function classify(diff, win, stands, bookTeamIds) {
  const lines = diff.lines.map((l) => {
    const bothStand = bookTeamIds.length === 2 && bookTeamIds.every((id) => stands.has(`${id}|${l.key}`));
    return { ...l, status: !win.open || bothStand ? 'disputed' : 'review' };
  });
  const state = !lines.length ? 'agreed' : lines.some((l) => l.status === 'review') ? 'in_review' : 'settled';
  return { lines, state };
}

function makeReconcile({ pool, stats }) {
  async function partnerOf(db, g) {
    if (!g.pair_id) return null;
    const { rows } = await db.query('SELECT * FROM games WHERE pair_id = $1 AND id <> $2', [g.pair_id, g.id]);
    return rows[0] || null;
  }

  /** Called whenever a paired book is finalized: starts the review clock the first time both books are final. */
  async function markCompared(db, g) {
    if (!g.pair_id) return null;
    const other = await partnerOf(db, g);
    if (!other || other.status !== 'final') return null;
    const up = await db.query('UPDATE game_pairs SET compared_at = now() WHERE id = $1 AND compared_at IS NULL RETURNING compared_at', [g.pair_id]);
    return up.rows[0] ? up.rows[0].compared_at : null;
  }

  /** Is this paired book still correctable? Closed once the review window has passed. */
  async function windowClosed(db, g) {
    if (!g.pair_id) return false;
    const { rows } = await db.query('SELECT compared_at FROM game_pairs WHERE id = $1', [g.pair_id]);
    return !!(rows[0] && rows[0].compared_at && !windowOf(rows[0].compared_at).open);
  }

  async function view(db, g, now) {
    if (!g.pair_id || !g.book_team_id) return { paired: false };
    const other = await partnerOf(db, g);
    const teamRows = (await db.query('SELECT id, name FROM teams WHERE id = ANY($1)', [[g.home_team_id, g.away_team_id]])).rows;
    const bookOf = (x) => ({ team_id: x.book_team_id, team_name: (teamRows.find((t) => t.id === x.book_team_id) || {}).name || '', code: x.code, status: x.status });
    const base = { paired: true, windowHours: REVIEW_HOURS, books: [bookOf(g), ...(other ? [bookOf(other)] : [])], you: g.book_team_id };
    if (!other) return { ...base, state: 'one_book', lines: [], agreed: 0, window: windowOf(null) };
    if (g.status !== 'final' || other.status !== 'final') return { ...base, state: 'waiting', lines: [], agreed: 0, window: windowOf(null) };
    const pair = (await db.query('SELECT compared_at FROM game_pairs WHERE id = $1', [g.pair_id])).rows[0];
    const win = windowOf(pair.compared_at, now);
    const [sa, sb] = await Promise.all([stats.finalSummary(db, g), stats.finalSummary(db, other)]);
    const diff = compare(sa, sb);
    const st = (await db.query('SELECT team_id, line_key FROM reconcile_stands WHERE pair_id = $1', [g.pair_id])).rows;
    const stands = new Set(st.map((r) => `${r.team_id}|${r.line_key}`));
    const cls = classify(diff, win, stands, [g.book_team_id, other.book_team_id]);
    return {
      ...base, state: cls.state, window: win, agreed: diff.agreed,
      lines: cls.lines.map((l) => ({ ...l, mine: l.a, theirs: l.b, you_stand: stands.has(`${g.book_team_id}|${l.key}`), they_stand: stands.has(`${other.book_team_id}|${l.key}`) })),
    };
  }

  /** For leaderboards: which (team, jersey) have a disputed line in a settled pair, from the owning team's own book. */
  async function flagsFor(sums) {
    const flagged = new Set();
    for (const s of sums) {
      if (!s.pairId || !s.bookTeamId) continue;
      const { rows } = await pool.query('SELECT * FROM games WHERE pair_id = $1 AND id <> $2 AND status = $3', [s.pairId, s.id, 'final']);
      if (!rows[0]) continue;
      const pair = (await pool.query('SELECT compared_at FROM game_pairs WHERE id = $1', [s.pairId])).rows[0];
      if (!pair || !pair.compared_at || windowOf(pair.compared_at).open) continue;
      const diff = compare(s, await stats.finalSummary(pool, rows[0]));
      for (const l of diff.lines) if (l.team_id === s.bookTeamId && l.jersey !== null) flagged.add(`${l.team_id}:${jerseyKey(l)}`);
    }
    return flagged;
  }

  return { view, markCompared, windowClosed, flagsFor, partnerOf };
}

module.exports = { makeReconcile, compare, classify, windowOf, REVIEW_HOURS };
