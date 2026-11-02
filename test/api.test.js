/*
 * Integration test against a real Postgres.
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/statstest npm test
 * Skipped automatically when TEST_DATABASE_URL is not set.
 * WARNING: it wipes the public schema of that database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test('api integration (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = URL_;
  process.env.ADMIN_PIN = '4321';
  process.env.STATS_API_KEY = 'test-stats-key';
  const { app, pool, init, resetRateLimits } = require('../server');

  let server, base, game, keeper;
  const j = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const K = () => ({ 'x-keeper-key': keeper });
  const ADMIN = { 'x-admin-pin': '4321' };
  let n = 0;
  const cid = () => `test-client-${Date.now()}-${n++}-abcdef`;

  test.before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await init();
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  test.after(async () => { server.closeAllConnections?.(); server.close(); await pool.end(); });

  test('create a game, validate rosters', async () => {
    const bad = await j('POST', '/api/games', { sport: 'basketball', home: { name: 'A', roster: 'Marcus' }, away: { name: 'B', roster: '3 Ray' } });
    assert.equal(bad.status, 400);
    const dupe = await j('POST', '/api/games', { sport: 'basketball', home: { name: 'A', roster: '4 Lee\n4 Dup' }, away: { name: 'B', roster: '3 Ray' } });
    assert.equal(dupe.status, 400);
    const same = await j('POST', '/api/games', { sport: 'basketball', home: { name: 'A', roster: '4 Lee' }, away: { name: ' a ', roster: '3 Ray' } });
    assert.equal(same.status, 400);

    const r = await j('POST', '/api/games', {
      sport: 'basketball', level: 'Varsity', date: '2026-10-20',
      home: { name: 'Provine Rams', roster: '4 Lee\n#23 Marcus Johnson\n10, Cruz\n00' },
      away: { name: 'Murrah Mustangs', roster: '3 Ray\n15 Moss' },
    });
    assert.equal(r.status, 201);
    assert.match(r.data.code, /^[A-Z2-9]{6}$/);
    keeper = r.data.keeperKey;
    game = r.data.code;
  });

  test('public read never leaks the keeper key', async () => {
    const r = await j('GET', `/api/games/${game}`);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.data).includes(keeper));
    assert.equal(r.data.players.length, 6);
    assert.equal(r.data.teams[0].name, 'Provine Rams');
  });

  let p; // players by jersey
  test('logging requires the keeper key; retries are idempotent; rules enforced', async () => {
    const g = (await j('GET', `/api/games/${game}`)).data;
    p = Object.fromEntries(g.players.map((x) => [x.team_id === g.teams[0].id ? `h${x.jersey}` : `a${x.jersey}`, x.id]));

    const noKey = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h23, period: 1 });
    assert.equal(noKey.status, 401);
    const wrongKey = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h23, period: 1 }, { 'x-keeper-key': 'nope' });
    assert.equal(wrongKey.status, 401);

    const id1 = cid();
    const a = await j('POST', `/api/games/${game}/events`, { client_id: id1, type: 'fg3_made', player_id: p.h23, player2_id: p.h4, period: 1 }, K());
    assert.equal(a.status, 201);
    const again = await j('POST', `/api/games/${game}/events`, { client_id: id1, type: 'fg3_made', player_id: p.h23, player2_id: p.h4, period: 1 }, K());
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.event.id, a.data.event.id);

    const selfAssist = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h23, player2_id: p.h23, period: 1 }, K());
    assert.equal(selfAssist.status, 422);
    const crossAssist = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h23, player2_id: p.a3, period: 1 }, K());
    assert.equal(crossAssist.status, 422);
    const badClient = await j('POST', `/api/games/${game}/events`, { client_id: 'x', type: 'fg2_made', player_id: p.h23, period: 1 }, K());
    assert.equal(badClient.status, 400);

    const box = (await j('GET', `/api/games/${game}/box`)).data;
    assert.equal(box.box.teams[0].score, 3);
  });

  test('team is derived from the player: a client cannot credit the wrong team', async () => {
    const r = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.a3, team_id: (await j('GET', `/api/games/${game}`)).data.teams[0].id, period: 1 }, K());
    assert.equal(r.status, 201);
    const box = (await j('GET', `/api/games/${game}/box`)).data;
    assert.equal(box.box.teams[1].score, 2);
    assert.equal(box.box.teams[0].score, 3);
  });

  test('void removes the stat, keeps the record, and is audited', async () => {
    const g = (await j('GET', `/api/games/${game}`)).data;
    const target = g.events.find((e) => e.type === 'fg2_made');
    const v = await j('POST', `/api/games/${game}/events/${target.id}/void`, { reason: 'wrong team' }, K());
    assert.equal(v.status, 200);
    const box = (await j('GET', `/api/games/${game}/box`)).data;
    assert.equal(box.box.teams[1].score, 0);
    assert.equal(box.box.voidedCount, 1);
    const aud = (await j('GET', `/api/games/${game}/audit`)).data.audit;
    const entry = aud.find((a) => a.action === 'event_voided');
    assert.equal(entry.detail.reason, 'wrong team');
    assert.equal(entry.detail.event_id, target.id);
    // restore
    const rs = await j('POST', `/api/games/${game}/events/${target.id}/restore`, {}, K());
    assert.equal(rs.status, 200);
    assert.equal((await j('GET', `/api/games/${game}/box`)).data.box.teams[1].score, 2);
    await j('POST', `/api/games/${game}/events/${target.id}/void`, {}, K());
  });

  test('scoreboard checkpoint flags mismatches', async () => {
    const ok = await j('POST', `/api/games/${game}/checkpoints`, { period: 1, home: 3, away: 0 }, K());
    assert.equal(ok.status, 201);
    assert.equal(ok.data.result.match, true);
    const bad = await j('POST', `/api/games/${game}/checkpoints`, { period: 1, home: 5, away: 0 }, K());
    assert.equal(bad.data.result.match, false);
    assert.deepEqual(bad.data.result.diff, [2, 0]);
    const bogus = await j('POST', `/api/games/${game}/checkpoints`, { period: 1, home: -1, away: 0 }, K());
    assert.equal(bogus.status, 400);
    const box = (await j('GET', `/api/games/${game}/box`)).data;
    assert.equal(box.checkpoints[0].match, false);
    // fix with the true number so later steps start clean
    await j('POST', `/api/games/${game}/checkpoints`, { period: 1, home: 3, away: 0 }, K());
  });

  test('adding a player mid-game', async () => {
    const dupe = await j('POST', `/api/games/${game}/players`, { team_id: (await j('GET', `/api/games/${game}`)).data.teams[0].id, jersey: '4', name: 'Again' }, K());
    assert.equal(dupe.status, 409);
    const tid = (await j('GET', `/api/games/${game}`)).data.teams[1].id;
    const ok = await j('POST', `/api/games/${game}/players`, { team_id: tid, jersey: '44', name: 'Late Arrival' }, K());
    assert.equal(ok.status, 201);
    const g = (await j('GET', `/api/games/${game}`)).data;
    assert.ok(g.players.some((x) => x.jersey === '44'));
  });

  test('SSE pushes a version bump when a stat is logged', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/games/${game}/stream`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    assert.match(first, /event: update/);
    await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'dreb', player_id: p.a15, period: 1 }, K());
    let got = '';
    const timeout = Date.now() + 3000;
    while (Date.now() < timeout && !/"version"/.test(got)) got += dec.decode((await reader.read()).value || new Uint8Array());
    assert.match(got, /event: update/);
    ctrl.abort();
  });

  test('concurrent taps from a flaky phone all land exactly once, in order', async () => {
    const ids = Array.from({ length: 15 }, () => cid());
    const sends = ids.map((id) => j('POST', `/api/games/${game}/events`, { client_id: id, type: 'ft_made', player_id: p.h10, period: 2 }, K()));
    // plus duplicates fired at the same time
    const dups = ids.slice(0, 5).map((id) => j('POST', `/api/games/${game}/events`, { client_id: id, type: 'ft_made', player_id: p.h10, period: 2 }, K()));
    const results = await Promise.all([...sends, ...dups]);
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    const box = (await j('GET', `/api/games/${game}/box`)).data;
    assert.equal(box.box.teams[0].periodPts[1], 15);
  });

  test('finalize locks the game; admin corrections require a reason and are audited', async () => {
    const f = await j('POST', `/api/games/${game}/finalize`, {}, K());
    assert.equal(f.status, 200);
    const locked = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h4, period: 4 }, K());
    assert.equal(locked.status, 423);
    const lockedVoid = await j('POST', `/api/games/${game}/events/1/void`, {}, K());
    assert.equal(lockedVoid.status, 423);
    const noReason = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h4, period: 4 }, ADMIN);
    assert.equal(noReason.status, 400);
    const wrongPin = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h4, period: 4, reason: 'x' }, { 'x-admin-pin': '0000' });
    assert.equal(wrongPin.status, 401);
    const fixed = await j('POST', `/api/games/${game}/events`, { client_id: cid(), type: 'fg2_made', player_id: p.h4, period: 4, reason: 'Missed basket found on film' }, ADMIN);
    assert.equal(fixed.status, 201);
    assert.equal(fixed.data.event.entered_by, 'admin');
    const aud = (await j('GET', `/api/games/${game}/audit`)).data.audit;
    assert.ok(aud.some((a) => a.action === 'event_added_after_final' && a.detail.reason === 'Missed basket found on film'));
    assert.ok(aud.some((a) => a.action === 'game_finalized'));
    assert.equal((await j('GET', `/api/games/${game}`)).data.game.status, 'final');
  });

  test('disputes: anyone can flag, only admin can resolve', async () => {
    const d = await j('POST', `/api/games/${game}/disputes`, { name: 'Coach Smith', message: 'I count 3 fouls on #23, not 2.' });
    assert.equal(d.status, 201);
    const short = await j('POST', `/api/games/${game}/disputes`, { message: 'no' });
    assert.equal(short.status, 400);
    const noPin = await j('POST', `/api/games/${game}/disputes/${d.data.id}/resolve`, { resolution: 'checked' });
    assert.equal(noPin.status, 401);
    const ok = await j('POST', `/api/games/${game}/disputes/${d.data.id}/resolve`, { resolution: 'Film reviewed: 2 fouls stands.' }, ADMIN);
    assert.equal(ok.status, 200);
    const g = (await j('GET', `/api/games/${game}`)).data;
    assert.equal(g.disputes[0].status, 'resolved');
  });

  test('reopen needs admin + reason', async () => {
    assert.equal((await j('POST', `/api/games/${game}/reopen`, { reason: 'x' }, K())).status, 401);
    assert.equal((await j('POST', `/api/games/${game}/reopen`, {}, ADMIN)).status, 400);
    assert.equal((await j('POST', `/api/games/${game}/reopen`, { reason: 'Scorer found an error' }, ADMIN)).status, 200);
    assert.equal((await j('GET', `/api/games/${game}`)).data.game.status, 'live');
    assert.equal((await j('POST', `/api/games/${game}/finalize`, {}, K())).status, 200);
  });

  test('CSV export, recent games list, 404s, bad JSON', async () => {
    const csv = await fetch(`${base}/api/games/${game}/export.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), new RegExp(game));
    const text = await csv.text();
    assert.match(text, /Provine Rams/);
    assert.match(text, /TOTAL/);
    const list = (await j('GET', '/api/games')).data.games;
    assert.equal(list[0].code, game);
    assert.equal(list[0].status, 'final');
    assert.equal(typeof list[0].home.score, 'number');
    assert.equal((await j('GET', '/api/games/ZZZZZZ')).status, 404);
    const res = await fetch(`${base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await fetch(`${base}/k/${game}`)).status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  /* ------------------------------------------------------------------ */
  /* v2: identity, formats, clock, decisions, seasons, leaders, athlete API */
  /* ------------------------------------------------------------------ */
  const mk = async (body) => {
    const r = await j('POST', '/api/games', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const g = (await j('GET', `/api/games/${r.data.code}`)).data;
    const byJersey = (teamIdx) => Object.fromEntries(g.players.filter((x) => x.team_id === g.teams[teamIdx].id).map((x) => [x.jersey, x.id]));
    return { code: r.data.code, key: r.data.keeperKey, g, home: byJersey(0), away: byJersey(1), teamIds: g.teams.map((t) => t.id) };
  };
  const post = (G, type, o) => j('POST', `/api/games/${G.code}/events`, { client_id: cid(), type, period: 1, ...o }, { 'x-keeper-key': G.key });
  const finalize = (G) => j('POST', `/api/games/${G.code}/finalize`, {}, { 'x-keeper-key': G.key });

  test('identity: same team name in two sports is two teams; same jersey + different name is a different person', async () => {
    const a = await mk({ sport: 'basketball', home: { name: 'Id Rams', roster: '23 Ann Lee\n5 Bo' }, away: { name: 'Id Foes', roster: '1 Cy' } });
    const b = await mk({ sport: 'football', home: { name: 'Id Rams', roster: '23 Ann Lee' }, away: { name: 'Id Foes', roster: '1 Cy' } });
    assert.notEqual(a.teamIds[0], b.teamIds[0]);               // basketball Rams != football Rams
    const c = await mk({ sport: 'basketball', home: { name: 'Id Rams', roster: '23 Ann Lee\n5 Bo' }, away: { name: 'Id Foes', roster: '1 Cy' } });
    assert.equal(c.teamIds[0], a.teamIds[0]);                  // same team + sport => same team
    assert.equal(c.home['23'], a.home['23']);                  // same person across games
    const d = await mk({ sport: 'basketball', home: { name: 'Id Rams', roster: '23 New Kid' }, away: { name: 'Id Foes', roster: '1 Cy' } });
    assert.notEqual(d.home['23'], a.home['23']);               // new kid in #23: never merged with Ann
  });

  test('formats: validated, stored, and applied to periods and clock', async () => {
    const bad = await j('POST', '/api/games', { sport: 'basketball', format: 'nope', home: { name: 'F1', roster: '1 A' }, away: { name: 'F2', roster: '2 B' } });
    assert.equal(bad.status, 400);
    const G = await mk({ sport: 'basketball', format: 'college_m', home: { name: 'F1', roster: '1 A\n2 B' }, away: { name: 'F2', roster: '3 C' } });
    assert.equal(G.g.game.format, 'college_m');
    assert.equal((await post(G, 'fg2_made', { team_id: G.teamIds[0], player_id: G.home['1'], period: 3 })).status, 201);   // OT after 2 halves
    assert.equal((await post(G, 'fg2_made', { team_id: G.teamIds[0], player_id: G.home['1'], period: 4 })).status, 201);
    const defaulted = await mk({ sport: 'basketball', home: { name: 'F3', roster: '1 A' }, away: { name: 'F4', roster: '3 C' } });
    assert.equal(defaulted.g.game.format, 'hs');
  });

  test('clock + minutes: clock range enforced, subs need a clock, minutes appear in the box score', async () => {
    const G = await mk({ sport: 'basketball', format: 'hs', home: { name: 'M1', roster: '1 A\n2 B' }, away: { name: 'M2', roster: '3 C' } });
    const h = G.teamIds[0];
    assert.equal((await post(G, 'fg2_made', { team_id: h, player_id: G.home['1'], clock_s: 481 })).status, 422);
    assert.equal((await post(G, 'sub_in', { team_id: h, player_id: G.home['1'] })).status, 422);
    assert.equal((await post(G, 'sub_in', { team_id: h, player_id: G.home['1'], clock_s: 0 })).status, 201);
    const shot = await post(G, 'fg2_made', { team_id: h, player_id: G.home['1'], clock_s: 200 });
    assert.equal(shot.data.event.clock_s, 200);
    assert.equal((await post(G, 'sub_out', { team_id: h, player_id: G.home['1'], clock_s: 300 })).status, 201);
    const box = (await j('GET', `/api/games/${G.code}/box`)).data.box;
    const row = box.teams[0].sections[0].rows.find((r) => r.jersey === '1');
    assert.equal(box.teams[0].sections[0].columns[0].key, 'min');
    assert.equal(row.cells[0], '5:00');
  });

  test('decisions: proposals appear at finish, each can be confirmed once, and count in the box score', async () => {
    const G = await mk({ sport: 'baseball', format: 'hs', home: { name: 'D1', roster: '1 Starter\n2 Closer\n3 Bat' }, away: { name: 'D2', roster: '7 Opp\n8 OppBat' } });
    const [h, a] = G.teamIds;
    await post(G, 'pitcher_in', { team_id: h, player_id: G.home['1'] });
    await post(G, 'pitcher_in', { team_id: a, player_id: G.away['7'] });
    await post(G, 'run', { team_id: h, player_id: G.home['3'], value: 1 });
    for (let i = 0; i < 12; i++) await post(G, 'k', { team_id: a, player_id: G.away['8'] });
    await post(G, 'pitcher_in', { team_id: h, player_id: G.home['2'] });
    for (let i = 0; i < 3; i++) await post(G, 'k', { team_id: a, player_id: G.away['8'] });
    const live = (await j('GET', `/api/games/${G.code}/box`)).data.box;
    assert.equal(live.decisions.proposals.length, 0);          // nothing is proposed until the game is over
    const w = await post(G, 'dec_w', { team_id: h, player_id: G.home['1'] });
    assert.equal(w.status, 201);
    assert.equal((await post(G, 'dec_w', { team_id: h, player_id: G.home['2'] })).status, 422);   // once per game
    assert.equal((await post(G, 'dec_sv', { team_id: h, player_id: G.home['2'] })).status, 201);
    assert.equal((await post(G, 'dec_l', { team_id: a, player_id: G.away['7'] })).status, 201);
    // void the win, then try to restore it after another was entered
    await j('POST', `/api/games/${G.code}/events/${w.data.event.id}/void`, {}, { 'x-keeper-key': G.key });
    assert.equal((await post(G, 'dec_w', { team_id: h, player_id: G.home['2'] })).status, 201);
    const rs = await j('POST', `/api/games/${G.code}/events/${w.data.event.id}/restore`, {}, { 'x-keeper-key': G.key });
    assert.equal(rs.status, 422);
    assert.equal((await finalize(G)).status, 200);
    const box = (await j('GET', `/api/games/${G.code}/box`)).data.box;
    assert.equal(box.decisions.proposals.find((p) => p.decision === 'W').player_id, G.home['1']);
    assert.equal(box.decisions.differs.length, 1);               // scorer chose the closer; the difference stays visible
  });

  test('season totals: only FINAL games count; record and sums come from the logs', async () => {
    const mkG = (n) => mk({ sport: 'basketball', format: 'hs', level: 'Varsity', date: `2026-11-0${n}`, home: { name: 'Season Hawks', roster: '1 Ace\n2 Sub' }, away: { name: `Opp ${n}`, roster: '9 Foe' } });
    const g1 = await mkG(1), g2 = await mkG(2), g3 = await mkG(3);
    for (const G of [g1, g2, g3]) {
      await post(G, 'fg3_made', { team_id: G.teamIds[0], player_id: G.home['1'] });
      await post(G, 'fg2_made', { team_id: G.teamIds[0], player_id: G.home['1'] });
    }
    await post(g2, 'fg2_made', { team_id: g2.teamIds[1], player_id: g2.away['9'] });
    await post(g2, 'fg2_made', { team_id: g2.teamIds[1], player_id: g2.away['9'] });
    await post(g2, 'fg2_made', { team_id: g2.teamIds[1], player_id: g2.away['9'] });     // 5-6: a loss
    await finalize(g1); await finalize(g2);                                              // g3 stays live
    const teamId = g1.teamIds[0];
    const s = (await j('GET', `/api/teams/${teamId}/season`)).data;
    assert.equal(s.season, '2026-27');
    assert.deepEqual([s.record.w, s.record.l, s.record.games], [1, 1, 2]);
    const box = s.sections[0];
    const ace = box.rows.find((r) => r.jersey === '1');
    assert.equal(ace.cells[box.columns.findIndex((c) => c.key === 'pts')], 10);          // 5 + 5, not 15
    assert.equal(s.players.find((p) => p.jersey === '1').gp, 2);
    assert.equal(s.players.find((p) => p.jersey === '1').averages[0].value, '5.0');
    assert.ok(!s.players.some((p) => p.jersey === '2'));                                 // never played: not a game played
    assert.equal((await j('GET', `/api/teams/${teamId}/season?season=2025-26`)).data.record.games, 0);
    assert.equal((await j('GET', '/api/teams/999999/season')).status, 404);
    // a correction to a final game flows through
    await j('POST', `/api/games/${g1.code}/reopen`, { reason: 'fix' }, ADMIN);
    const ev1 = (await j('GET', `/api/games/${g1.code}`)).data.events.find((e) => e.type === 'fg3_made');
    await j('POST', `/api/games/${g1.code}/events/${ev1.id}/void`, {}, { 'x-keeper-key': g1.key });
    await finalize(g1);
    const s2 = (await j('GET', `/api/teams/${teamId}/season`)).data;
    assert.equal(s2.sections[0].rows.find((r) => r.jersey === '1').cells[s2.sections[0].columns.findIndex((c) => c.key === 'pts')], 7);
  });

  test('leaders: boards are per sport/season/level and respect minimums', async () => {
    const r = (await j('GET', '/api/leaders/basketball?season=2026-27&level=Varsity')).data;
    assert.equal(r.sport.id, 'basketball');
    const pts = r.categories.find((c) => c.id === 'pts');
    const ace = pts.leaders.find((l) => l.name === 'Ace');           // other tests' games share this season
    assert.equal(ace.team_name, 'Season Hawks');
    assert.equal(ace.display, '7');
    assert.deepEqual(pts.leaders.map((l) => l.value), pts.leaders.map((l) => l.value).slice().sort((x, y) => y - x));
    assert.equal(r.categories.find((c) => c.id === 'fgp').qualText.length > 0, true);
    assert.equal((await j('GET', '/api/leaders/curling')).status, 404);
    const none = (await j('GET', '/api/leaders/basketball?season=2020-21')).data;
    assert.equal(none.games, 0);
    assert.equal(none.categories.every((c) => c.leaders.length === 0), true);
    assert.equal((await fetch(`${base}/leaders/basketball`)).status, 200);
    assert.equal((await fetch(`${base}/t/1`)).status, 200);
  });

  test('athlete API: key required; search needs a real name; only finished games count', async () => {
    const AUTH = { authorization: 'Bearer test-stats-key' };
    assert.equal((await j('GET', '/api/athletes/search?q=Ace')).status, 401);
    assert.equal((await j('GET', '/api/athletes/search?q=Ace', null, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await j('GET', '/api/athletes/search?q=A', null, AUTH)).data.athletes.length, 0);
    const found = (await j('GET', '/api/athletes/search?q=ace&sport=basketball', null, AUTH)).data.athletes;
    assert.equal(found.length, 1);
    assert.equal(found[0].team.name, 'Season Hawks');
    assert.equal(found[0].final_games, 2);
    assert.equal((await j('GET', '/api/athletes/search?q=%25', null, AUTH)).data.athletes.length, 0);   // wildcard is not a wildcard
    const a = (await j('GET', `/api/athletes/${found[0].player_id}`, null, AUTH)).data;
    assert.equal(a.player.name, 'Ace');
    assert.equal(a.seasons[0].season, '2026-27');
    assert.equal(a.seasons[0].games, 2);
    assert.equal(a.seasons[0].stats.pts, 7);
    assert.equal(a.seasons[0].sections[0].columns.some((c) => c.key === 'pts'), true);
    assert.equal((await j('GET', '/api/athletes/999999', null, AUTH)).status, 404);
    assert.equal((await j('GET', `/api/athletes/${found[0].player_id}`)).status, 401);
    // a player who only appeared in an unfinished game is not discoverable
    const live = await mk({ sport: 'basketball', home: { name: 'Ghost Team', roster: '1 Phantom Kid' }, away: { name: 'Ghost Foes', roster: '2 X' } });
    await post(live, 'fg2_made', { team_id: live.teamIds[0], player_id: live.home['1'] });
    assert.equal((await j('GET', '/api/athletes/search?q=phantom', null, AUTH)).data.athletes.length, 0);
  });

  /* ---- school PINs: athletic directors choose their own PIN for starting games ---- */
  test('school PINs: register, claim teams, and guard game creation', async () => {
    const G = (home, away, pin, headers) => j('POST', '/api/games', {
      sport: 'basketball', pin, home: { name: home, roster: '1 A' }, away: { name: away, roster: '2 B' },
    }, headers);

    // registering: PIN rules, duplicates, hash never exposed
    assert.equal((await j('POST', '/api/schools', { name: 'Hinds High', pin: '123' })).status, 400);
    assert.equal((await j('POST', '/api/schools', { name: 'X', pin: 'longenough' })).status, 400);
    const reg = await j('POST', '/api/schools', { name: 'Hinds High', pin: 'Rams-2026' });
    assert.equal(reg.status, 201);
    const hinds = reg.data.school.id;
    assert.equal((await j('POST', '/api/schools', { name: ' hinds   HIGH ', pin: 'another-pin' })).status, 409);
    const list = await j('GET', '/api/schools');
    assert.equal(JSON.stringify(list.data).includes('pin'), false);
    const mur = (await j('POST', '/api/schools', { name: 'Murrah High', pin: 'Mustang-77' })).data.school.id;

    // before any team is claimed the old rule applies (open here)
    assert.equal((await G('Hinds Eagles', 'Open Foes', '')).status, 201);

    // claiming teams needs the school PIN; a team belongs to one school
    const claim = (id, pin, name) => j('POST', `/api/schools/${id}/teams`, { pin, teams: [{ name, sport: 'basketball' }] });
    assert.equal((await claim(hinds, 'wrong-pin', 'Hinds Eagles')).status, 401);
    assert.equal((await claim(hinds, 'Rams-2026', 'Hinds Eagles')).status, 200);
    assert.equal((await claim(mur, 'Mustang-77', 'hinds eagles')).status, 409);
    assert.equal((await j('POST', `/api/schools/${hinds}/teams`, { pin: 'Rams-2026', teams: [{ name: 'Hinds Eagles', sport: 'nope' }] })).status, 400);
    assert.equal((await claim(mur, 'Mustang-77', 'Murrah Mustangs')).status, 200);
    const shown = (await j('GET', '/api/schools')).data.schools.find((x) => x.id === hinds);
    assert.deepEqual(shown.teams.map((t) => t.name), ['Hinds Eagles']);

    // now starting a game with a claimed team needs that school's PIN, on either side
    const no = await G('Hinds Eagles', 'Brand New Opponent', '');
    assert.equal(no.status, 401);
    assert.equal(no.data.needPin, true);
    assert.deepEqual(no.data.schools, ['Hinds High']);
    assert.equal((await G('Hinds Eagles', 'Brand New Opponent', 'Mustang-77')).status, 401);       // another school's PIN is not enough
    assert.equal((await G('Hinds Eagles', 'Brand New Opponent', 'Rams-2026')).status, 201);
    assert.equal((await G('Visitors United', 'Hinds Eagles', 'Rams-2026')).status, 201);           // away side counts too
    assert.equal((await G('Hinds Eagles', 'Murrah Mustangs', 'Mustang-77')).status, 201);          // either involved school's PIN works
    assert.equal((await G('Hinds Eagles', 'Admin Overrides', '', ADMIN)).status, 201);              // operator override

    // a refused attempt leaves nothing behind (teams created inside the transaction roll back)
    await G('Hinds Eagles', 'Should Not Exist Team', 'wrong-pin');
    const ghost = await pool.query("SELECT 1 FROM teams WHERE name_key = 'should not exist team'");
    assert.equal(ghost.rows.length, 0);

    // unrelated teams are still open
    assert.equal((await G('Plain Team One', 'Plain Team Two', '')).status, 201);
  });

  test('school PINs: change and reset', async () => {
    resetRateLimits();
    const id = (await j('POST', '/api/schools', { name: 'Pearl High', pin: 'first-pin-1' })).data.school.id;
    const change = (body, headers) => j('POST', `/api/schools/${id}/pin`, body, headers);
    assert.equal((await change({ pin: 'nope-nope', newPin: 'second-pin-2' })).status, 401);
    assert.equal((await change({ pin: 'first-pin-1', newPin: 'abc' })).status, 400);
    assert.equal((await change({ pin: 'first-pin-1', newPin: 'second-pin-2' })).status, 200);
    assert.equal((await j('POST', `/api/schools/${id}/teams`, { pin: 'first-pin-1', teams: [{ name: 'Pearl Pirates', sport: 'basketball' }] })).status, 401);
    assert.equal((await j('POST', `/api/schools/${id}/teams`, { pin: 'second-pin-2', teams: [{ name: 'Pearl Pirates', sport: 'basketball' }] })).status, 200);
    // forgotten PIN: only the operator can reset it
    assert.equal((await change({ newPin: 'reset-by-admin' })).status, 401);
    assert.equal((await change({ newPin: 'reset-by-admin' }, ADMIN)).status, 200);
    const g = await j('POST', '/api/games', { sport: 'basketball', pin: 'reset-by-admin', home: { name: 'Pearl Pirates', roster: '1 A' }, away: { name: 'Anyone Else', roster: '2 B' } });
    assert.equal(g.status, 201);
    const row = await pool.query('SELECT pin_salt, pin_hash FROM schools WHERE id = $1', [id]);
    assert.equal(JSON.stringify(row.rows[0]).includes('reset-by-admin'), false);     // only a salted hash is stored
  });

  test('school PINs: remove teams and delete a school without touching game history', async () => {
    resetRateLimits();   // this test makes many deliberate wrong-PIN attempts; the real limit is 20 per hour per IP
    const id = (await j('POST', '/api/schools', { name: 'Brandon High', pin: 'Bulldogs-9' })).data.school.id;
    const add = (names) => j('POST', `/api/schools/${id}/teams`, { pin: 'Bulldogs-9', teams: names.map((name) => ({ name, sport: 'basketball' })) });
    assert.equal((await add(['Brandon Bulldogs', 'Brandon JV'])).status, 200);
    const G = (home, pin) => j('POST', '/api/games', { sport: 'basketball', pin, home: { name: home, roster: '1 A' }, away: { name: 'Remote Opponent', roster: '2 B' } });
    const played = await G('Brandon Bulldogs', 'Bulldogs-9');
    assert.equal(played.status, 201);

    // removing teams: needs the PIN, only the school's own teams, all-or-nothing
    const rm = (teams, body = {}, headers) => j('DELETE', `/api/schools/${id}/teams`, { teams, ...body }, headers);
    const jv = [{ name: 'Brandon JV', sport: 'basketball' }];
    assert.equal((await rm(jv, { pin: 'wrong-pin' })).status, 401);
    assert.equal((await rm([])).status, 401);
    assert.equal((await rm([], { pin: 'Bulldogs-9' })).status, 400);
    assert.equal((await rm([{ name: 'Murrah Mustangs', sport: 'basketball' }], { pin: 'Bulldogs-9' })).status, 400);                // someone else's team
    assert.equal((await rm([...jv, { name: 'Murrah Mustangs', sport: 'basketball' }], { pin: 'Bulldogs-9' })).status, 400);        // one bad name cancels the lot
    assert.equal((await G('Brandon JV', '')).status, 401);                                                                         // so JV is still guarded
    const done = await rm(jv, { pin: 'Bulldogs-9' });
    assert.equal(done.status, 200);
    assert.equal(done.data.removed[0].name, 'Brandon JV');
    assert.equal((await G('Brandon JV', '')).status, 201);                                                                         // released: open again
    assert.equal((await G('Brandon Bulldogs', '')).status, 401);                                                                   // the other team is still guarded
    const shown = (await j('GET', '/api/schools')).data.schools.find((x) => x.id === id);
    assert.deepEqual(shown.teams.map((x) => x.name), ['Brandon Bulldogs']);

    // deleting the school: PIN and typed name both required; teams are released, history is kept
    const del = (body, headers) => j('DELETE', `/api/schools/${id}`, body, headers);
    assert.equal((await del({ pin: 'wrong-pin', confirmName: 'Brandon High' })).status, 401);
    assert.equal((await del({ pin: 'Bulldogs-9' })).status, 400);
    assert.equal((await del({ pin: 'Bulldogs-9', confirmName: 'Brandon' })).status, 400);
    assert.equal((await j('GET', '/api/schools')).data.schools.some((x) => x.id === id), true);
    const gone = await del({ pin: 'Bulldogs-9', confirmName: ' brandon  HIGH ' });
    assert.equal(gone.status, 200);
    assert.equal(gone.data.releasedTeams, 1);
    assert.equal((await j('GET', '/api/schools')).data.schools.some((x) => x.id === id), false);
    assert.equal((await del({ pin: 'Bulldogs-9', confirmName: 'Brandon High' })).status, 404);
    assert.equal((await G('Brandon Bulldogs', '')).status, 201);                                                                   // open now
    assert.equal((await j('GET', `/api/games/${played.data.code}`)).status, 200);                                                 // the game it played is untouched
    assert.equal((await j('POST', '/api/schools', { name: 'Brandon High', pin: 'brand-new-pin' })).status, 201);                   // the name can be registered again

    // the operator can clean up a school whose PIN was lost (still must confirm the name)
    const lost = (await j('POST', '/api/schools', { name: 'Lost Pin Academy', pin: 'forgotten-1' })).data.school.id;
    assert.equal((await j('DELETE', `/api/schools/${lost}`, { confirmName: 'Lost Pin Academy' })).status, 401);
    assert.equal((await j('DELETE', `/api/schools/${lost}`, { confirmName: 'nope' }, ADMIN)).status, 400);
    assert.equal((await j('DELETE', `/api/schools/${lost}`, { confirmName: 'Lost Pin Academy' }, ADMIN)).status, 200);
  });
}
