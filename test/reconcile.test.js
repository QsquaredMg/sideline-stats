const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, classify, windowOf, REVIEW_HOURS } = require('../lib/reconcile');

const book = (score1, pts) => ({
  teams: [{ id: 1, name: 'Home', score: score1 }, { id: 2, name: 'Away', score: 50 }],
  players: [{ id: 11, team_id: 1, jersey: '4', name: 'Lee' }, { id: 21, team_id: 2, jersey: '3', name: 'Ray' }],
  playerStats: { 11: { gp: 1, gs: 1, pts, reb: 5 }, 21: { gp: 1, gs: 1, pts: 50, reb: 2 } },
});

test('identical books agree on every line', () => {
  const d = compare(book(60, 14), book(60, 14));
  assert.equal(d.lines.length, 0);
  assert.ok(d.agreed > 0);
});

test('a differing score and stat are reported with both numbers', () => {
  const d = compare(book(60, 14), book(58, 12));
  assert.deepEqual(d.lines.map((l) => [l.stat, l.a, l.b]).sort(), [['pts', 14, 12], ['score', 60, 58]].sort());
  assert.equal(d.lines.find((l) => l.stat === 'pts').name, 'Lee');
});

test('a player missing from one book counts as zero there', () => {
  const b = book(60, 14); b.players = b.players.filter((p) => p.id !== 11); delete b.playerStats[11];
  const d = compare(book(60, 14), b);
  assert.ok(d.lines.some((l) => l.stat === 'gp' && l.a === 1 && l.b === 0));
});

test('48 hour window: open, then closed; lines become disputed only when it closes or both teams stand', () => {
  const d = compare(book(60, 14), book(60, 12));
  const t0 = new Date('2026-11-02T12:00:00Z');
  assert.equal(REVIEW_HOURS, 48);
  const open = windowOf(t0, new Date('2026-11-04T11:00:00Z'));
  assert.equal(open.open, true); assert.equal(open.hoursLeft, 1);
  const closed = windowOf(t0, new Date('2026-11-04T12:00:01Z'));
  assert.equal(closed.open, false);
  assert.equal(classify(d, open, new Set(), [1, 2]).state, 'in_review');
  assert.equal(classify(d, open, new Set(['1|1:4:pts']), [1, 2]).lines[0].status, 'review');           // one team standing is not enough
  assert.equal(classify(d, open, new Set(['1|1:4:pts', '2|1:4:pts']), [1, 2]).state, 'settled');       // both stand
  assert.equal(classify(d, closed, new Set(), [1, 2]).state, 'settled');
  assert.equal(classify(compare(book(60, 14), book(60, 14)), open, new Set(), [1, 2]).state, 'agreed');
});
