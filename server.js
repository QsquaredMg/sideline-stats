'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Sports = require('./shared/sports');
const Engine = require('./shared/engine');
const { makeStats } = require('./lib/stats');
const Pins = require('./lib/pins');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';   // athletic director / league admin: corrections after final, dispute resolution
const CREATE_PIN = process.env.CREATE_PIN || ''; // optional: only people who know this can start a game
const SCHOOL_SETUP_CODE = process.env.SCHOOL_SETUP_CODE || ''; // optional: if set, only people who know it can register a school (stops name squatting)
const STATS_API_KEY = process.env.STATS_API_KEY || ''; // optional: lets GoatReelz (server-to-server) look up athletes and read season lines

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function safeEq(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function newCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const newKey = () => crypto.randomBytes(18).toString('base64url');

function roleOf(req, game) {
  if (ADMIN_PIN && safeEq(req.get('x-admin-pin'), ADMIN_PIN)) return 'admin';
  if (safeEq(req.get('x-keeper-key'), game.keeper_key)) return 'keeper';
  return null;
}

// Tiny in-memory rate limiter (per IP, per bucket). Good enough for one Railway service.
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) return next(httpErr(429, 'Too many requests. Please wait a bit and try again.'));
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ */
/* Live updates (Server-Sent Events)                                    */
/* ------------------------------------------------------------------ */
const listeners = new Map(); // code -> Set<res>
function broadcast(code, version) {
  const set = listeners.get(code);
  if (!set) return;
  for (const res of set) res.write(`event: update\ndata: ${JSON.stringify({ version })}\n\n`);
}
setInterval(() => { for (const set of listeners.values()) for (const res of set) res.write(': keepalive\n\n'); }, 25000).unref();

/* ------------------------------------------------------------------ */
/* Data access                                                          */
/* ------------------------------------------------------------------ */
async function loadGameRow(db, code) {
  const { rows } = await db.query('SELECT * FROM games WHERE code = $1', [String(code).toUpperCase()]);
  return rows[0] || null;
}

async function loadParts(db, g) {
  const [teams, players, events, checkpoints, disputes] = await Promise.all([
    db.query('SELECT id, name FROM teams WHERE id = ANY($1)', [[g.home_team_id, g.away_team_id]]),
    db.query(
      `SELECT p.id, p.team_id, p.jersey, p.name FROM game_players gp
         JOIN players p ON p.id = gp.player_id WHERE gp.game_id = $1 ORDER BY p.team_id, p.id`, [g.id]),
    db.query(
      `SELECT id, client_id, type, team_id, player_id, player2_id, value, period, clock_s, voided, void_reason, voided_by,
              entered_by, created_at, voided_at
         FROM events WHERE game_id = $1 ORDER BY id`, [g.id]),
    db.query('SELECT id, period, home_score, away_score, created_at FROM checkpoints WHERE game_id = $1 ORDER BY id', [g.id]),
    db.query('SELECT id, event_id, name, message, status, resolution, created_at, resolved_at FROM disputes WHERE game_id = $1 ORDER BY id', [g.id]),
  ]);
  const byId = new Map(teams.rows.map((t) => [t.id, t]));
  return {
    teams: [byId.get(g.home_team_id), byId.get(g.away_team_id)],
    players: players.rows,
    events: events.rows.map((e) => ({ ...e, id: Number(e.id) })),
    checkpoints: checkpoints.rows,
    disputes: disputes.rows.map((d) => ({ ...d, event_id: d.event_id === null ? null : Number(d.event_id) })),
  };
}

function publicGame(g) {
  return {
    code: g.code, sport: g.sport, format: g.format || '', status: g.status, level: g.level,
    date: g.game_date ? g.game_date.toISOString().slice(0, 10) : null,
    version: g.version, created_at: g.created_at, finalized_at: g.finalized_at,
    home_team_id: g.home_team_id, away_team_id: g.away_team_id,
  };
}

async function validationCtx(db, g) {
  const { rows } = await db.query(
    `SELECT p.id, p.team_id, p.jersey, p.name FROM game_players gp JOIN players p ON p.id = gp.player_id WHERE gp.game_id = $1`, [g.id]);
  const live = await db.query(`SELECT type, voided FROM events WHERE game_id = $1 AND type LIKE 'dec\_%'`, [g.id]);
  return { playersById: new Map(rows.map((p) => [p.id, p])), homeId: g.home_team_id, awayId: g.away_team_id, liveEvents: live.rows };
}

/** The one place a game's numbers are computed from its parts, so every endpoint agrees. */
function computeFor(g, parts, extra) {
  return Engine.computeGame({ sport: g.sport, format: g.format, teams: parts.teams, players: parts.players, events: parts.events, final: g.status === 'final', ...(extra || {}) });
}

async function audit(db, gameId, action, actor, detail) {
  await db.query('INSERT INTO audit_log (game_id, action, actor, detail) VALUES ($1,$2,$3,$4)', [gameId, action, actor, JSON.stringify(detail || {})]);
}

/**
 * Run `fn(db, game)` inside a transaction with the game row locked, so two
 * phones (or a phone and an admin) can never interleave writes.
 * If fn returns { mutated: false } nothing is committed to the version counter.
 */
async function withGame(code, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM games WHERE code = $1 FOR UPDATE', [String(code).toUpperCase()]);
    const g = rows[0];
    if (!g) throw httpErr(404, 'Game not found.');
    const result = await fn(client, g);
    let version = g.version;
    if (!result || result.mutated !== false) {
      const up = await client.query('UPDATE games SET version = version + 1 WHERE id = $1 RETURNING version', [g.id]);
      version = up.rows[0].version;
    }
    await client.query('COMMIT');
    if (!result || result.mutated !== false) broadcast(g.code, version);
    return { ...(result || {}), version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Roster parsing                                                       */
/* ------------------------------------------------------------------ */
function parseRoster(text, teamLabel) {
  const players = [];
  const seen = new Set();
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(/^#?\s*((?=[A-Za-z0-9]*\d)[A-Za-z0-9]{1,4})(?:[\s,.:\-]+(.*))?$/);
    if (!m) throw httpErr(400, `${teamLabel} roster: could not read "${line}". Use one player per line, like "23 Marcus Johnson".`);
    const jersey = m[1];
    const name = (m[2] || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (seen.has(jersey.toLowerCase())) throw httpErr(400, `${teamLabel} roster: jersey #${jersey} appears twice.`);
    seen.add(jersey.toLowerCase());
    players.push({ jersey, name });
  }
  if (players.length < 1) throw httpErr(400, `${teamLabel} roster is empty. Add at least one player.`);
  if (players.length > 80) throw httpErr(400, `${teamLabel} roster has more than 80 players.`);
  return players;
}

async function upsertTeam(db, name, sport) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) throw httpErr(400, 'Both teams need a name.');
  const { rows } = await db.query(
    `INSERT INTO teams (name, name_key, sport) VALUES ($1, $2, $3)
       ON CONFLICT (name_key, sport) DO UPDATE SET name = EXCLUDED.name RETURNING id, name`, [clean, clean.toLowerCase(), sport]);
  return rows[0];
}

async function upsertPlayer(db, teamId, p) {
  const { rows } = await db.query(
    `INSERT INTO players (team_id, jersey, name, name_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (team_id, jersey, name_key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, team_id, jersey, name`, [teamId, p.jersey, p.name, p.name.toLowerCase()]);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* App                                                                  */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});
app.use(express.json({ limit: '50kb' }));

/* ---- static + pages ---- */
const pub = path.join(__dirname, 'public');
app.use('/shared', express.static(path.join(__dirname, 'shared'), { maxAge: '5m' }));
app.use(express.static(pub, { maxAge: '5m', index: 'index.html' }));
const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
app.get('/k/:code', page('keeper.html'));
app.get('/g/:code', page('live.html'));
app.get('/school', page('school.html'));
app.get('/rules', page('rules.html'));
app.get('/t/:id', page('stats.html'));
app.get('/leaders', page('stats.html'));
app.get('/leaders/:sport', page('stats.html'));
app.get('/rules/:sport', page('rules.html'));

app.get('/healthz', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

/* ---- config ---- */
app.get('/api/config', (req, res) => {
  res.json({ sports: Sports.list(), createPinRequired: !!CREATE_PIN, adminEnabled: !!ADMIN_PIN, schoolSetupCodeRequired: !!SCHOOL_SETUP_CODE });
});

/* ---- schools: athletic directors set their own PIN for starting games ---- */
const needPin = (message, schools) => Object.assign(httpErr(401, message), { extra: { needPin: true, schools } });

/**
 * Who may start this game? If either team belongs to a school, someone must know one of those schools' PINs
 * (the operator's ADMIN_PIN or CREATE_PIN also work). Otherwise the old rule applies: CREATE_PIN if one is set,
 * and open if not. Runs inside the game-creation transaction, so a refusal rolls back any teams just created.
 */
async function authorizeCreate(db, req, pin, teamIds) {
  const { rows: schools } = await db.query(
    `SELECT DISTINCT s.id, s.name, s.pin_salt, s.pin_hash FROM teams t JOIN schools s ON s.id = t.school_id WHERE t.id = ANY($1::int[])`, [teamIds]);
  const isAdmin = !!ADMIN_PIN && safeEq(req.get('x-admin-pin'), ADMIN_PIN);
  if (!schools.length) {
    if (CREATE_PIN && !isAdmin && !safeEq(pin, CREATE_PIN)) throw httpErr(401, 'That access PIN is not right.');
    return isAdmin ? 'admin' : CREATE_PIN ? 'create_pin' : 'open';
  }
  if (isAdmin) return 'admin';
  if (CREATE_PIN && safeEq(pin, CREATE_PIN)) return 'create_pin';
  const names = schools.map((s) => s.name);
  if (!pin) throw needPin(`${names.join(' and ')} needs its school PIN before a game can be started. Ask your athletic director.`, names);
  const hit = schools.find((s) => Pins.verifyPin(pin, s.pin_salt, s.pin_hash));
  if (!hit) throw needPin('That school PIN is not right.', names);
  return `school:${hit.name}`;
}

async function loadSchool(id) {
  const { rows } = await pool.query('SELECT * FROM schools WHERE id = $1', [Number(id) || 0]);
  if (!rows[0]) throw httpErr(404, 'School not found.');
  return rows[0];
}
const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const pinLimit = rateLimit('school-pin', 20, 3600 * 1000); // guessing PINs is slow by design

app.get('/api/schools', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, COALESCE(json_agg(json_build_object('name', t.name, 'sport', t.sport) ORDER BY t.sport, t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS teams
       FROM schools s LEFT JOIN teams t ON t.school_id = s.id GROUP BY s.id ORDER BY s.name`);
  res.json({ schools: rows });
}));

// An athletic director registers their school and picks the PIN.
app.post('/api/schools', rateLimit('school-create', 10, 3600 * 1000), wrap(async (req, res) => {
  const b = req.body || {};
  if (SCHOOL_SETUP_CODE && !safeEq(b.setupCode, SCHOOL_SETUP_CODE)) throw httpErr(401, 'That setup code is not right. Ask the Sideline Stats administrator for it.');
  const name = cleanName(b.name);
  if (name.length < 2) throw httpErr(400, 'Enter your school name.');
  const bad = Pins.checkPinFormat(b.pin);
  if (bad) throw httpErr(400, bad);
  const { salt, hash } = Pins.hashPin(b.pin);
  try {
    const { rows } = await pool.query(
      'INSERT INTO schools (name, name_key, pin_salt, pin_hash) VALUES ($1,$2,$3,$4) RETURNING id, name', [name, name.toLowerCase(), salt, hash]);
    res.status(201).json({ school: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw httpErr(409, 'A school with that name is already registered. If it is yours, ask the administrator to reset its PIN.');
    throw err;
  }
}));

// Claim teams so the school's PIN guards games they play in.
app.post('/api/schools/:id/teams', pinLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const school = await loadSchool(req.params.id);
  const isAdmin = !!ADMIN_PIN && safeEq(req.get('x-admin-pin'), ADMIN_PIN);
  if (!isAdmin && !Pins.verifyPin(b.pin, school.pin_salt, school.pin_hash)) throw httpErr(401, 'That school PIN is not right.');
  const list = Array.isArray(b.teams) ? b.teams.slice(0, 30) : [];
  if (!list.length) throw httpErr(400, 'Add at least one team.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = [];
    for (const t of list) {
      const sport = Sports.get(t && t.sport);
      if (!sport) throw httpErr(400, 'Pick a sport for each team.');
      const team = await upsertTeam(client, t.name, sport.id);
      const cur = (await client.query('SELECT school_id FROM teams WHERE id = $1 FOR UPDATE', [team.id])).rows[0];
      if (cur.school_id && cur.school_id !== school.id) throw httpErr(409, `${team.name} (${sport.name}) already belongs to another school. Ask the administrator if that is a mistake.`);
      await client.query('UPDATE teams SET school_id = $1 WHERE id = $2', [school.id, team.id]);
      claimed.push({ name: team.name, sport: sport.id });
    }
    await client.query('COMMIT');
    res.json({ school: { id: school.id, name: school.name }, teams: claimed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// Change the PIN (needs the current one). The operator's ADMIN_PIN can reset a forgotten PIN.
app.post('/api/schools/:id/pin', pinLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const school = await loadSchool(req.params.id);
  const isAdmin = !!ADMIN_PIN && safeEq(req.get('x-admin-pin'), ADMIN_PIN);
  if (!isAdmin && !Pins.verifyPin(b.pin, school.pin_salt, school.pin_hash)) throw httpErr(401, 'That school PIN is not right.');
  const bad = Pins.checkPinFormat(b.newPin);
  if (bad) throw httpErr(400, bad);
  const { salt, hash } = Pins.hashPin(b.newPin);
  await pool.query('UPDATE schools SET pin_salt = $1, pin_hash = $2 WHERE id = $3', [salt, hash, school.id]);
  res.json({ ok: true });
}));

/* ---- create game ---- */
app.post('/api/games', rateLimit('create', 30, 3600 * 1000), wrap(async (req, res) => {
  const b = req.body || {};
  const sport = Sports.get(b.sport);
  if (!sport) throw httpErr(400, 'Pick a sport.');
  const homeRoster = parseRoster(b.home && b.home.roster, 'Home');
  const awayRoster = parseRoster(b.away && b.away.roster, 'Away');
  const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const level = String(b.level || '').trim().slice(0, 30);
  const format = String(b.format || '').trim();
  if (format && !(sport.formats || []).some((f) => f.id === format)) throw httpErr(400, `That game format is not available for ${sport.name}.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const home = await upsertTeam(client, b.home && b.home.name, sport.id);
    const away = await upsertTeam(client, b.away && b.away.name, sport.id);
    if (home.id === away.id) throw httpErr(400, 'Home and away must be different teams.');
    const authorizedBy = await authorizeCreate(client, req, b.pin, [home.id, away.id]);

    let code, key = newKey();
    for (let i = 0; i < 8; i++) {
      code = newCode();
      const clash = await client.query('SELECT 1 FROM games WHERE code = $1', [code]);
      if (!clash.rows.length) break;
      if (i === 7) throw httpErr(500, 'Could not allocate a game code. Try again.');
    }
    const ins = await client.query(
      `INSERT INTO games (code, sport, format, home_team_id, away_team_id, level, game_date, keeper_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [code, sport.id, format || sport.formatId || '', home.id, away.id, level, date, key]);
    const gameId = ins.rows[0].id;
    for (const [teamId, roster] of [[home.id, homeRoster], [away.id, awayRoster]]) {
      for (const p of roster) {
        const row = await upsertPlayer(client, teamId, p);
        await client.query('INSERT INTO game_players (game_id, player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gameId, row.id]);
      }
    }
    await audit(client, gameId, 'game_created', 'keeper', { sport: sport.id, format: format || sport.formatId || '', home: home.name, away: away.name, authorized_by: authorizedBy, home_players: homeRoster.length, away_players: awayRoster.length });
    await client.query('COMMIT');
    res.status(201).json({ code, keeperKey: key, publicUrl: `/g/${code}`, keeperUrl: `/k/${code}?key=${key}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---- recent games (home page) ---- */
app.get('/api/games', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const { rows: games } = await pool.query('SELECT * FROM games ORDER BY created_at DESC LIMIT $1', [limit]);
  const out = [];
  for (const g of games) {
    const parts = await loadParts(pool, g);
    const c = computeFor(g, parts);
    out.push({
      ...publicGame(g),
      home: { name: c.teams[0].name, score: c.teams[0].score },
      away: { name: c.teams[1].name, score: c.teams[1].score },
      period: c.periodNames[c.currentPeriod - 1],
    });
  }
  res.json({ games: out });
}));

/* ---- read a game (public) ---- */
app.get('/api/games/:code', wrap(async (req, res) => {
  const g = await loadGameRow(pool, req.params.code);
  if (!g) throw httpErr(404, 'Game not found.');
  const parts = await loadParts(pool, g);
  res.set('Cache-Control', 'no-store');
  res.json({ game: publicGame(g), ...parts, adminEnabled: !!ADMIN_PIN });
}));

app.get('/api/games/:code/box', wrap(async (req, res) => {
  const g = await loadGameRow(pool, req.params.code);
  if (!g) throw httpErr(404, 'Game not found.');
  const parts = await loadParts(pool, g);
  const computed = computeFor(g, parts);
  res.set('Cache-Control', 'no-store');
  res.json({ game: publicGame(g), box: computed, checkpoints: Engine.checkCheckpoints(computed, parts.checkpoints), openDisputes: parts.disputes.filter((d) => d.status === 'open').length });
}));

app.get('/api/games/:code/export.csv', wrap(async (req, res) => {
  const g = await loadGameRow(pool, req.params.code);
  if (!g) throw httpErr(404, 'Game not found.');
  const parts = await loadParts(pool, g);
  const computed = computeFor(g, parts);
  const csv = Engine.toCSV(computed, { date: g.game_date ? g.game_date.toISOString().slice(0, 10) : '' });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${g.code}-boxscore.csv"` });
  res.send(csv);
}));

app.get('/api/games/:code/audit', wrap(async (req, res) => {
  const g = await loadGameRow(pool, req.params.code);
  if (!g) throw httpErr(404, 'Game not found.');
  const { rows } = await pool.query('SELECT id, action, actor, detail, created_at FROM audit_log WHERE game_id = $1 ORDER BY id DESC LIMIT 300', [g.id]);
  res.set('Cache-Control', 'no-store');
  res.json({ audit: rows.map((r) => ({ ...r, id: Number(r.id) })) });
}));

app.get('/api/games/:code/stream', wrap(async (req, res) => {
  const g = await loadGameRow(pool, req.params.code);
  if (!g) throw httpErr(404, 'Game not found.');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\nevent: update\ndata: ${JSON.stringify({ version: g.version })}\n\n`);
  if (!listeners.has(g.code)) listeners.set(g.code, new Set());
  listeners.get(g.code).add(res);
  req.on('close', () => { const s = listeners.get(g.code); if (s) { s.delete(res); if (!s.size) listeners.delete(g.code); } });
}));

/* ---- log a stat (keeper) ---- */
app.post('/api/games/:code/events', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    const role = roleOf(req, g);
    if (!role) throw httpErr(401, 'Stat-keeper key required.');
    if (g.status === 'final' && role !== 'admin') throw httpErr(423, 'This game is final. Corrections need the admin PIN.');
    const b = req.body || {};
    const clientId = String(b.client_id || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw httpErr(400, 'client_id is required.');

    const dup = await db.query('SELECT id, client_id, type, team_id, player_id, player2_id, value, period, clock_s, voided, entered_by, created_at FROM events WHERE game_id = $1 AND client_id = $2', [g.id, clientId]);
    if (dup.rows[0]) return { event: { ...dup.rows[0], id: Number(dup.rows[0].id) }, duplicate: true, mutated: false };

    const sport = Sports.resolve(g.sport, g.format);
    const v = Engine.validateEvent(sport, b, await validationCtx(db, g));
    if (!v.ok) throw httpErr(422, v.error);
    let reason = '';
    if (g.status === 'final') {
      reason = String(b.reason || '').trim().slice(0, 200);
      if (!reason) throw httpErr(400, 'A reason is required for changes after a game is final.');
    }
    const e = v.event;
    const ins = await db.query(
      `INSERT INTO events (game_id, client_id, type, team_id, player_id, player2_id, value, period, clock_s, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, client_id, type, team_id, player_id, player2_id, value, period, clock_s, voided, entered_by, created_at`,
      [g.id, clientId, e.type, e.team_id, e.player_id, e.player2_id, e.value, e.period, e.clock_s, role]);
    const row = { ...ins.rows[0], id: Number(ins.rows[0].id) };
    if (role === 'admin' && g.status === 'final') await audit(db, g.id, 'event_added_after_final', 'admin', { event_id: row.id, type: e.type, reason });
    return { event: row };
  });
  res.status(out.duplicate ? 200 : 201).json(out);
}));

/* ---- void / restore (keeper) ---- */
async function setVoid(req, res, voided) {
  const out = await withGame(req.params.code, async (db, g) => {
    const role = roleOf(req, g);
    if (!role) throw httpErr(401, 'Stat-keeper key required.');
    if (g.status === 'final' && role !== 'admin') throw httpErr(423, 'This game is final. Corrections need the admin PIN.');
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    if (g.status === 'final' && !reason) throw httpErr(400, 'A reason is required for changes after a game is final.');
    const { rows } = await db.query('SELECT * FROM events WHERE id = $1 AND game_id = $2', [req.params.id, g.id]);
    const ev = rows[0];
    if (!ev) throw httpErr(404, 'Event not found.');
    if (ev.voided === voided) return { event: { id: Number(ev.id), voided }, mutated: false };
    if (voided) {
      await db.query('UPDATE events SET voided = true, void_reason = $2, voided_by = $3, voided_at = now() WHERE id = $1', [ev.id, reason || 'keeper correction', role]);
    } else {
      const def = (Sports.get(g.sport).eventMap || {})[ev.type];
      if (def && def.oncePerGame) {
        const again = await db.query('SELECT 1 FROM events WHERE game_id = $1 AND type = $2 AND NOT voided AND id <> $3', [g.id, ev.type, ev.id]);
        if (again.rows.length) throw httpErr(422, `"${def.label}" is already recorded for this game. Void that one first.`);
      }
      await db.query('UPDATE events SET voided = false, void_reason = NULL, voided_by = NULL, voided_at = NULL WHERE id = $1', [ev.id]);
    }
    await audit(db, g.id, voided ? 'event_voided' : 'event_restored', role, {
      event_id: Number(ev.id), type: ev.type, period: ev.period, team_id: ev.team_id, player_id: ev.player_id, player2_id: ev.player2_id, value: ev.value,
      reason: reason || (voided ? 'keeper correction' : ''), after_final: g.status === 'final',
    });
    return { event: { id: Number(ev.id), voided } };
  });
  res.json(out);
}
app.post('/api/games/:code/events/:id/void', wrap((req, res) => setVoid(req, res, true)));
app.post('/api/games/:code/events/:id/restore', wrap((req, res) => setVoid(req, res, false)));

/* ---- add a player mid-game ---- */
app.post('/api/games/:code/players', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    const role = roleOf(req, g);
    if (!role) throw httpErr(401, 'Stat-keeper key required.');
    if (g.status === 'final' && role !== 'admin') throw httpErr(423, 'This game is final.');
    const teamId = Number(req.body && req.body.team_id);
    if (teamId !== g.home_team_id && teamId !== g.away_team_id) throw httpErr(400, 'That team is not in this game.');
    const [p] = parseRoster(`${(req.body && req.body.jersey) || ''} ${(req.body && req.body.name) || ''}`, 'New player');
    const dupe = await db.query(
      `SELECT 1 FROM game_players gp JOIN players pl ON pl.id = gp.player_id WHERE gp.game_id = $1 AND pl.team_id = $2 AND lower(pl.jersey) = lower($3)`,
      [g.id, teamId, p.jersey]);
    if (dupe.rows.length) throw httpErr(409, `Jersey #${p.jersey} is already on this roster.`);
    const row = await upsertPlayer(db, teamId, p);
    await db.query('INSERT INTO game_players (game_id, player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, row.id]);
    await audit(db, g.id, 'player_added', role, { player_id: row.id, team_id: teamId, jersey: row.jersey, name: row.name });
    return { player: row };
  });
  res.status(201).json(out);
}));

/* ---- scoreboard checkpoint ---- */
app.post('/api/games/:code/checkpoints', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    const role = roleOf(req, g);
    if (!role) throw httpErr(401, 'Stat-keeper key required.');
    if (g.status === 'final' && role !== 'admin') throw httpErr(423, 'This game is final.');
    const sport = Sports.resolve(g.sport, g.format);
    const period = Number(req.body && req.body.period);
    const hs = Number(req.body && req.body.home), as = Number(req.body && req.body.away);
    if (!Number.isInteger(period) || period < 1 || period > sport.maxPeriods) throw httpErr(400, 'Invalid period.');
    if (![hs, as].every((n) => Number.isInteger(n) && n >= 0 && n <= 999)) throw httpErr(400, 'Scores must be whole numbers from 0 to 999.');
    const ins = await db.query('INSERT INTO checkpoints (game_id, period, home_score, away_score) VALUES ($1,$2,$3,$4) RETURNING id, period, home_score, away_score, created_at', [g.id, period, hs, as]);
    const parts = await loadParts(db, g);
    const computed = computeFor(g, parts, { currentPeriod: period });
    const result = Engine.checkCheckpoints(computed, parts.checkpoints).find((r) => r.period === period);
    await audit(db, g.id, 'scoreboard_checked', role, { period, official: [hs, as], ours: result.ours, match: result.match });
    return { checkpoint: ins.rows[0], result };
  });
  res.status(201).json(out);
}));

/* ---- finalize / reopen ---- */
app.post('/api/games/:code/finalize', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    const role = roleOf(req, g);
    if (!role) throw httpErr(401, 'Stat-keeper key required.');
    if (g.status === 'final') return { status: 'final', mutated: false };
    const parts = await loadParts(db, g);
    if (!parts.events.some((e) => !e.voided)) throw httpErr(422, 'There are no stats to finalize yet.');
    const computed = computeFor({ ...g, status: 'final' }, parts);
    const checks = Engine.checkCheckpoints(computed, parts.checkpoints);
    await db.query(`UPDATE games SET status = 'final', finalized_at = now() WHERE id = $1`, [g.id]);
    await audit(db, g.id, 'game_finalized', role, {
      score: [computed.teams[0].score, computed.teams[1].score],
      scoreboard_checks: checks.map((c) => ({ period: c.period, match: c.match })),
      warnings: computed.warnings,
    });
    return { status: 'final' };
  });
  res.json(out);
}));

app.post('/api/games/:code/reopen', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    if (!ADMIN_PIN) throw httpErr(503, 'ADMIN_PIN is not configured on this server.');
    if (!safeEq(req.get('x-admin-pin'), ADMIN_PIN)) throw httpErr(401, 'Admin PIN required.');
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    if (!reason) throw httpErr(400, 'A reason is required to reopen a final game.');
    if (g.status !== 'final') return { status: g.status, mutated: false };
    await db.query(`UPDATE games SET status = 'live', finalized_at = NULL WHERE id = $1`, [g.id]);
    await audit(db, g.id, 'game_reopened', 'admin', { reason });
    return { status: 'live' };
  });
  res.json(out);
}));

/* ---- disputes ---- */
app.post('/api/games/:code/disputes', rateLimit('dispute', 12, 3600 * 1000), wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    const message = String((req.body && req.body.message) || '').trim().slice(0, 600);
    if (message.length < 5) throw httpErr(400, 'Please describe what looks wrong.');
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
    let eventId = null;
    if (req.body && req.body.event_id) {
      const e = await db.query('SELECT id FROM events WHERE id = $1 AND game_id = $2', [req.body.event_id, g.id]);
      if (!e.rows[0]) throw httpErr(400, 'That play is not part of this game.');
      eventId = e.rows[0].id;
    }
    const ins = await db.query('INSERT INTO disputes (game_id, event_id, name, message) VALUES ($1,$2,$3,$4) RETURNING id', [g.id, eventId, name, message]);
    await audit(db, g.id, 'dispute_opened', 'public', { dispute_id: ins.rows[0].id, event_id: eventId === null ? null : Number(eventId) });
    return { id: ins.rows[0].id };
  });
  res.status(201).json(out);
}));

app.post('/api/games/:code/disputes/:id/resolve', wrap(async (req, res) => {
  const out = await withGame(req.params.code, async (db, g) => {
    if (!ADMIN_PIN) throw httpErr(503, 'ADMIN_PIN is not configured on this server.');
    if (!safeEq(req.get('x-admin-pin'), ADMIN_PIN)) throw httpErr(401, 'Admin PIN required.');
    const resolution = String((req.body && req.body.resolution) || '').trim().slice(0, 400);
    if (!resolution) throw httpErr(400, 'Say how it was resolved.');
    const up = await db.query(`UPDATE disputes SET status = 'resolved', resolution = $3, resolved_at = now() WHERE id = $1 AND game_id = $2 RETURNING id`, [req.params.id, g.id, resolution]);
    if (!up.rows[0]) throw httpErr(404, 'Dispute not found.');
    await audit(db, g.id, 'dispute_resolved', 'admin', { dispute_id: up.rows[0].id, resolution });
    return { id: up.rows[0].id };
  });
  res.json(out);
}));

/* ---- season totals and leaderboards (public; final games only) ---- */
const stats = makeStats({ pool, loadParts });
const seasonQ = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const levelQ = (v) => String(v || '').trim().slice(0, 30);

app.get('/api/teams/:id/season', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpErr(404, 'Team not found.');
  const out = await stats.teamSeason(id, { season: seasonQ(req.query.season), level: levelQ(req.query.level) });
  if (!out) throw httpErr(404, 'Team not found.');
  res.set('Cache-Control', 'public, max-age=30');
  res.json(out);
}));

app.get('/api/leaders/:sport', wrap(async (req, res) => {
  const out = await stats.leaders(req.params.sport, {
    season: seasonQ(req.query.season), level: levelQ(req.query.level),
    format: req.query.format === undefined ? undefined : String(req.query.format).slice(0, 20),
    limit: Math.min(Number(req.query.limit) || 10, 25),
  });
  if (!out) throw httpErr(404, 'Unknown sport.');
  res.set('Cache-Control', 'public, max-age=30');
  res.json(out);
}));

/* ---- athlete lookup for GoatReelz (server-to-server, key required) ---- */
function requireStatsKey(req, res, next) {
  if (!STATS_API_KEY) return next(httpErr(404, 'Not found.'));   // feature off: the endpoints do not exist
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m || !safeEq(m[1], STATS_API_KEY)) return next(httpErr(401, 'A valid stats API key is required.'));
  next();
}
app.get('/api/athletes/search', requireStatsKey, rateLimit('athlete-search', 120, 60 * 1000), wrap(async (req, res) => {
  const results = await stats.searchAthletes(req.query.q, String(req.query.sport || ''), req.query.limit);
  res.set('Cache-Control', 'no-store');
  res.json({ athletes: results });
}));
app.get('/api/athletes/:id', requireStatsKey, rateLimit('athlete', 240, 60 * 1000), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpErr(404, 'Athlete not found.');
  const out = await stats.athlete(id);
  if (!out) throw httpErr(404, 'Athlete not found.');
  res.set('Cache-Control', 'private, max-age=60');
  res.json(out);
}));

/* ---- errors ---- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: status >= 500 ? 'Something went wrong on our end.' : err.message, ...(status < 500 ? err.extra : {}) });
  res.status(status).send(status === 404 ? 'Not found' : 'Error');
});

/* ------------------------------------------------------------------ */
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  init()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Sideline Stats listening on :${PORT}`);
        if (!ADMIN_PIN) console.warn('WARNING: ADMIN_PIN is not set. Post-final corrections and dispute resolution are disabled.');
      });
    })
    .catch((err) => { console.error('Failed to start:', err); process.exit(1); });
}

module.exports = { app, pool, init, parseRoster };
