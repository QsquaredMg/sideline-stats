'use strict';
/*
 * Team directory: associations (NCAA divisions, NAIA, NJCAA ...), their programs, and season rosters.
 *
 * Rosters are DATA SOMEONE SUPPLIED: a school (with its PIN, marked verified), the operator (admin PIN, unverified) or a
 * CSV import. Nothing here scrapes or copies a third party's feed. Every roster line carries its source and whether the
 * school itself has verified it, so the game screen can say so.
 */
const express = require('express');
const Engine = require('../shared/engine');
const Sports = require('../shared/sports');
const Pins = require('./pins');

const MAX_ROWS = 5000;

/** Minimal CSV reader (quotes, commas, newlines). Returns an array of objects keyed by the header row. */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function makeDirectory({ pool, wrap, httpErr, safeEq, getAdminPin, rateLimit, loadSchool, upsertTeam }) {
  const router = express.Router();
  const isAdmin = (req) => !!getAdminPin() && safeEq(req.get('x-admin-pin'), getAdminPin());
  const season = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const clean = (v, n) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, n);
  const pinLimit = rateLimit('directory-pin', 30, 3600 * 1000);

  router.get('/associations', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.key, a.name, COUNT(t.id)::int AS teams FROM associations a LEFT JOIN teams t ON t.association_id = a.id GROUP BY a.id ORDER BY a.sort`);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ associations: rows });
  }));

  router.get('/teams', wrap(async (req, res) => {
    const q = clean(req.query.q, 60).toLowerCase().replace(/[\\%_]/g, '\\$&');
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.sport, t.conference, t.location, a.key AS association, a.name AS association_name, (t.school_id IS NOT NULL) AS claimed,
              r.season, r.count, r.verified
         FROM teams t JOIN associations a ON a.id = t.association_id
         LEFT JOIN LATERAL (SELECT season, COUNT(*)::int AS count, bool_and(verified) AS verified FROM roster_entries WHERE team_id = t.id
                             GROUP BY season ORDER BY season DESC LIMIT 1) r ON true
        WHERE ($1 = '' OR a.key = $1) AND ($2 = '' OR t.sport = $2) AND ($3 = '' OR t.name_key LIKE $4 ESCAPE '\\')
        ORDER BY t.name_key, t.sport LIMIT $5`,
      [clean(req.query.assoc, 20), clean(req.query.sport, 20), q, `%${q}%`, Math.min(Number(req.query.limit) || 25, 100)]);
    res.set('Cache-Control', 'no-store');
    res.json({ teams: rows.map((r) => ({
      id: r.id, name: r.name, sport: r.sport, conference: r.conference, location: r.location, association: { key: r.association, name: r.association_name },
      claimed: r.claimed, roster: r.season ? { season: r.season, count: r.count, verified: !!r.verified } : null })) });
  }));

  router.get('/teams/:id/roster', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpErr(404, 'Team not found.');
    const t = (await pool.query(`SELECT t.id, t.name, t.sport, a.name AS association FROM teams t JOIN associations a ON a.id = t.association_id WHERE t.id = $1`, [id])).rows[0];
    if (!t) throw httpErr(404, 'Team not found.');
    const want = season(req.query.season);
    const s = want || ((await pool.query('SELECT MAX(season) AS s FROM roster_entries WHERE team_id = $1', [id])).rows[0] || {}).s;
    const { rows } = s ? await pool.query('SELECT jersey, name, position, class_year, source, verified FROM roster_entries WHERE team_id = $1 AND season = $2', [id, s]) : { rows: [] };
    rows.sort((a, b) => Engine.jerseySort(a.jersey, b.jersey));
    res.set('Cache-Control', 'no-store');
    res.json({ team: t, season: s || null, verified: rows.length > 0 && rows.every((r) => r.verified), players: rows.map((r) => ({ jersey: r.jersey, name: r.name, position: r.position, class: r.class_year, source: r.source, verified: r.verified })) });
  }));

  /** List a program in an association. The operator can add any; a school can list a team it has claimed (its PIN is required). */
  router.post('/teams', pinLimit, wrap(async (req, res) => {
    const b = req.body || {};
    const sport = Sports.get(b.sport);
    if (!sport) throw httpErr(400, 'Pick a sport.');
    const assoc = (await pool.query('SELECT id FROM associations WHERE key = $1', [clean(b.association, 20)])).rows[0];
    if (!assoc) throw httpErr(400, 'Pick an association.');
    let school = null;
    if (!isAdmin(req)) {
      school = await loadSchool(b.school_id);
      if (!Pins.verifyPin(b.pin, school.pin_salt, school.pin_hash)) throw httpErr(401, 'That school PIN is not right.');
    }
    const team = await upsertTeam(pool, b.name, sport.id);
    const cur = (await pool.query('SELECT school_id FROM teams WHERE id = $1', [team.id])).rows[0];
    if (school && cur.school_id && cur.school_id !== school.id) throw httpErr(409, 'That team already belongs to another school.');
    await pool.query('UPDATE teams SET association_id = $2, conference = $3, location = $4, school_id = COALESCE($5, school_id) WHERE id = $1',
      [team.id, assoc.id, clean(b.conference, 60), clean(b.location, 60), school ? school.id : null]);
    res.status(201).json({ team: { id: team.id, name: team.name, sport: sport.id } });
  }));

  /** Replace one season's roster. The school's PIN marks it verified; the operator's marks it as operator-entered. */
  router.put('/teams/:id/roster', pinLimit, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = Number.isInteger(id) ? (await pool.query('SELECT id, school_id FROM teams WHERE id = $1 AND association_id IS NOT NULL', [id])).rows[0] : null;
    if (!t) throw httpErr(404, 'Team not found in the directory.');
    let source, verified;
    if (isAdmin(req)) { source = 'admin'; verified = false; } else {
      if (!t.school_id) throw httpErr(401, 'This team has no school yet. Register the school and claim the team first.');
      const school = await loadSchool(t.school_id);
      if (!Pins.verifyPin(b.pin, school.pin_salt, school.pin_hash)) throw httpErr(401, 'That school PIN is not right.');
      source = 'school'; verified = true;
    }
    const s = season(b.season) || Engine.seasonLabel(new Date().toISOString().slice(0, 10));
    const lines = Array.isArray(b.players) ? b.players : null;
    if (!lines || !lines.length) throw httpErr(400, 'Send the roster as a list of players.');
    if (lines.length > 120) throw httpErr(400, 'A roster can have at most 120 players.');
    const seen = new Set();
    const players = lines.map((p) => {
      const jersey = clean(p && p.jersey, 4).replace(/^#/, '');
      if (!/^(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{1,4}$/.test(jersey)) throw httpErr(400, `Could not read jersey "${jersey}".`);
      if (seen.has(jersey.toLowerCase())) throw httpErr(400, `Jersey #${jersey} appears twice.`);
      seen.add(jersey.toLowerCase());
      return { jersey, name: clean(p.name, 40), position: clean(p.position, 12), class_year: clean(p.class || p.class_year, 12) };
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM roster_entries WHERE team_id = $1 AND season = $2', [id, s]);
      for (const p of players) {
        await client.query('INSERT INTO roster_entries (team_id, season, jersey, name, position, class_year, source, verified) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, s, p.jersey, p.name, p.position, p.class_year, source, verified]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ season: s, players: players.length, verified });
  }));

  /**
   * Bulk import (operator only). CSV columns: association,team,sport,conference,location,season,jersey,name,position,class
   * Imported rosters are unverified until the school confirms them with its PIN.
   */
  router.post('/import', wrap(async (req, res) => {
    if (!isAdmin(req)) throw httpErr(401, 'Admin PIN required.');
    const rows = parseCSV(req.body && req.body.csv);
    if (!rows.length) throw httpErr(400, 'The CSV needs a header row and at least one player.');
    if (rows.length > MAX_ROWS) throw httpErr(400, `Import at most ${MAX_ROWS} rows at a time.`);
    const assocs = new Map((await pool.query('SELECT key, id FROM associations')).rows.map((a) => [a.key, a.id]));
    const client = await pool.connect();
    const teamsSeen = new Set(); let players = 0;
    try {
      await client.query('BEGIN');
      const cleared = new Set(); const teamIds = new Map();
      for (const [i, r] of rows.entries()) {
        const where = `Row ${i + 2}`;
        const sport = Sports.get(r.sport);
        if (!sport) throw httpErr(400, `${where}: unknown sport "${r.sport}".`);
        const aid = assocs.get(clean(r.association, 20).toLowerCase());
        if (!aid) throw httpErr(400, `${where}: unknown association "${r.association}". Use one of: ${[...assocs.keys()].join(', ')}.`);
        const s = season(r.season);
        if (!s) throw httpErr(400, `${where}: season must look like 2026-27.`);
        const jersey = clean(r.jersey, 4).replace(/^#/, '');
        if (!/^(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{1,4}$/.test(jersey)) throw httpErr(400, `${where}: could not read jersey "${r.jersey}".`);
        const tk = `${r.team}|${sport.id}`;
        if (!teamIds.has(tk)) {
          const team = await upsertTeam(client, r.team, sport.id);
          await client.query('UPDATE teams SET association_id = $2, conference = COALESCE(NULLIF($3, \'\'), conference), location = COALESCE(NULLIF($4, \'\'), location) WHERE id = $1',
            [team.id, aid, clean(r.conference, 60), clean(r.location, 60)]);
          teamIds.set(tk, team.id); teamsSeen.add(team.id);
        }
        const tid = teamIds.get(tk);
        if (!cleared.has(`${tid}|${s}`)) {   // a re-import replaces that team's season, but never a school-verified one
          const ver = await client.query('SELECT 1 FROM roster_entries WHERE team_id = $1 AND season = $2 AND verified LIMIT 1', [tid, s]);
          if (ver.rows.length) throw httpErr(409, `${where}: ${clean(r.team, 60)} ${s} is already verified by the school. The school has to change it.`);
          await client.query('DELETE FROM roster_entries WHERE team_id = $1 AND season = $2', [tid, s]);
          cleared.add(`${tid}|${s}`);
        }
        const ins = await client.query(
          `INSERT INTO roster_entries (team_id, season, jersey, name, position, class_year, source, verified) VALUES ($1,$2,$3,$4,$5,$6,'import',false)
             ON CONFLICT (team_id, season, jersey) DO NOTHING`, [tid, s, jersey, clean(r.name, 40), clean(r.position, 12), clean(r.class || r.class_year, 12)]);
        if (!ins.rowCount) throw httpErr(400, `${where}: jersey #${jersey} appears twice for ${clean(r.team, 60)}.`);
        players += 1;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ teams: teamsSeen.size, players });
  }));

  return router;
}

module.exports = { makeDirectory, parseCSV };
