'use strict';
/*
 * Season totals, leaderboards and the athlete lookup that GoatReelz uses.
 *
 * Nothing here stores a total. Every season figure is the sum of the per-game figures that the shared engine
 * computes from each FINAL game's event log, so a correction to one game (void + reason, audited) flows into the
 * season page the next time it is read. Live and unfinished games never count toward season numbers.
 */
const Sports = require('../shared/sports');
const Engine = require('../shared/engine');

const CACHE_MAX = 3000;

function makeStats({ pool, loadParts }) {
  const cache = new Map(); // `${gameId}:${version}` -> summary of one final game

  const dateOf = (g) => {
    const d = g.game_date || g.created_at;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  };

  /** Per-game numbers for a final game, cached by (game, version): any edit bumps the version, so it recomputes. */
  async function finalSummary(db, g) {
    const key = `${g.id}:${g.version}`;
    if (cache.has(key)) return cache.get(key);
    const parts = await loadParts(db, g);
    const c = Engine.computeGame({ sport: g.sport, format: g.format, teams: parts.teams, players: parts.players, events: parts.events, final: true });
    const out = {
      id: g.id, code: g.code, sport: g.sport, format: g.format || '', level: g.level || '', date: dateOf(g), season: Engine.seasonLabel(dateOf(g)),
      teams: c.teams.map((t) => ({ id: t.id, name: t.name, score: t.score })),
      players: parts.players, playerStats: c.playerStats, decisions: c.decisions ? c.decisions.confirmed.length : 0,
    };
    cache.set(key, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return out;
  }

  const seasonRange = (label) => {
    const m = /^(\d{4})-\d{2}$/.exec(label || '');
    if (!m) return null;
    const y = Number(m[1]);
    return [`${y}-08-01`, `${y + 1}-07-31`];
  };

  async function finalGames(db, where, params, season) {
    const range = seasonRange(season);
    const p = params.slice();
    let sql = `SELECT g.* FROM games g WHERE g.status = 'final' AND ${where}`;
    if (range) { p.push(range[0], range[1]); sql += ` AND COALESCE(g.game_date, g.created_at::date) BETWEEN $${p.length - 1} AND $${p.length}`; }
    sql += ' ORDER BY COALESCE(g.game_date, g.created_at::date), g.id';
    return (await db.query(sql, p)).rows;
  }

  async function seasonsFor(db, where, params) {
    const { rows } = await db.query(
      `SELECT DISTINCT to_char(COALESCE(g.game_date, g.created_at::date), 'YYYY-MM') AS ym FROM games g WHERE g.status = 'final' AND ${where}`, params);
    return [...new Set(rows.map((r) => Engine.seasonLabel(`${r.ym}-01`)))].sort().reverse();
  }

  const mostCommon = (arr) => {
    const n = new Map();
    for (const x of arr) n.set(x, (n.get(x) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0] ? [...n.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
  };

  /* ---- one team's season ---- */
  async function teamSeason(teamId, opts) {
    const t = (await pool.query('SELECT id, name, sport FROM teams WHERE id = $1', [teamId])).rows[0];
    if (!t) return null;
    const where = '(g.home_team_id = $1 OR g.away_team_id = $1)';
    const seasons = await seasonsFor(pool, where, [teamId]);
    const season = opts.season || seasons[0] || null;
    const games = season ? await finalGames(pool, where, [teamId], season) : [];
    const sums = await Promise.all(games.map((g) => finalSummary(pool, g)));
    const levels = [...new Set(sums.map((s) => s.level).filter(Boolean))].sort();
    const use = sums.filter((s) => !opts.level || s.level === opts.level);
    const format = use.length ? use[use.length - 1].format : '';
    const sport = Sports.resolve(t.sport, format);

    let w = 0, l = 0, tie = 0;
    const list = use.map((s) => {
      const us = s.teams.find((x) => x.id === teamId), them = s.teams.find((x) => x.id !== teamId);
      const home = s.teams[0].id === teamId;
      const result = us.score > them.score ? 'W' : us.score < them.score ? 'L' : 'T';
      if (result === 'W') w += 1; else if (result === 'L') l += 1; else tie += 1;
      return { code: s.code, date: s.date, level: s.level, opponent: them.name, home, us: us.score, them: them.score, result };
    });

    const per = new Map();
    for (const s of use) {
      for (const p of s.players) {
        if (p.team_id !== teamId) continue;
        const cur = per.get(p.id) || { id: p.id, jersey: p.jersey, name: p.name, parts: [] };
        cur.parts.push(s.playerStats[p.id] || {});
        per.set(p.id, cur);
      }
    }
    const rows = [...per.values()]
      .map((r) => ({ id: r.id, jersey: r.jersey, name: r.name, stats: Engine.sumStats(r.parts) }))
      .filter((r) => (r.stats.gp || 0) > 0)
      .sort((a, b) => Engine.jerseySort(a.jersey, b.jersey));
    return {
      team: { id: t.id, name: t.name, sport: t.sport, sportName: sport.name }, format: sport.formatId, formatLabel: sport.formatLabel || '',
      season, seasons, levels, level: opts.level || '', record: { w, l, t: tie, games: list.length }, games: list,
      sections: Engine.seasonSections(sport, rows),
      players: rows.map((r) => ({ player_id: r.id, jersey: r.jersey, name: r.name, gp: r.stats.gp || 0, gs: r.stats.gs || 0, averages: Engine.averagesLine(sport, r.stats) })),
      averageLabels: (sport.averages || []).map((a) => a.label),
    };
  }

  /* ---- league leaders for one sport ---- */
  async function leaders(sportId, opts) {
    if (!Sports.get(sportId)) return null;
    const where = 'g.sport = $1';
    const seasons = await seasonsFor(pool, where, [sportId]);
    const season = opts.season || seasons[0] || null;
    const games = season ? await finalGames(pool, where, [sportId], season) : [];
    const sums = await Promise.all(games.map((g) => finalSummary(pool, g)));
    const levels = [...new Set(sums.map((s) => s.level).filter(Boolean))].sort();
    const formats = [...new Set(sums.map((s) => s.format).filter((x) => x !== undefined))];
    // Never mix levels of play on one board: default to the most common format; filter by level if asked.
    const format = opts.format !== undefined && opts.format !== '' ? opts.format : mostCommon(sums.map((s) => s.format));
    const use = sums.filter((s) => s.format === format && (!opts.level || s.level === opts.level));
    const sport = Sports.resolve(sportId, format);

    const teamGames = new Map(), teamNames = new Map(), per = new Map();
    for (const s of use) {
      for (const tm of s.teams) { teamGames.set(tm.id, (teamGames.get(tm.id) || 0) + 1); teamNames.set(tm.id, tm.name); }
      for (const p of s.players) {
        const cur = per.get(p.id) || { player_id: p.id, team_id: p.team_id, jersey: p.jersey, name: p.name, parts: [] };
        cur.parts.push(s.playerStats[p.id] || {});
        per.set(p.id, cur);
      }
    }
    const rows = [...per.values()].map((r) => ({
      player_id: r.player_id, team_id: r.team_id, team_name: teamNames.get(r.team_id) || '', jersey: r.jersey, name: r.name,
      stats: Engine.sumStats(r.parts), teamGames: teamGames.get(r.team_id) || 0,
    }));
    return {
      sport: { id: sport.id, name: sport.name }, season, seasons, level: opts.level || '', levels, format,
      formats: (Sports.get(sportId).formats || []).filter((f) => formats.includes(f.id)).map((f) => ({ id: f.id, label: f.label })),
      games: use.length, categories: Engine.computeLeaders(sport, rows, { limit: opts.limit || 10 }),
    };
  }

  /* ---- athlete lookup (used by GoatReelz, behind STATS_API_KEY) ---- */
  async function searchAthletes(q, sportId, limit) {
    const term = String(q || '').trim().toLowerCase().replace(/[\\%_]/g, '\\$&');
    if (term.length < 2) return [];
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.jersey, t.id AS team_id, t.name AS team_name, t.sport,
              COUNT(DISTINCT g.id) FILTER (WHERE g.status = 'final') AS final_games,
              MAX(COALESCE(g.game_date, g.created_at::date)) FILTER (WHERE g.status = 'final') AS last_date
         FROM players p
         JOIN teams t ON t.id = p.team_id
         LEFT JOIN game_players gp ON gp.player_id = p.id
         LEFT JOIN games g ON g.id = gp.game_id
        WHERE p.name_key LIKE $1 ESCAPE '\\' AND p.name <> '' AND ($2 = '' OR t.sport = $2)
        GROUP BY p.id, t.id
       HAVING COUNT(DISTINCT g.id) FILTER (WHERE g.status = 'final') > 0
        ORDER BY last_date DESC NULLS LAST, p.id LIMIT $3`, [`%${term}%`, sportId || '', Math.min(Number(limit) || 10, 25)]);
    return rows.map((r) => ({
      player_id: r.id, name: r.name, jersey: r.jersey, team: { id: r.team_id, name: r.team_name }, sport: r.sport,
      final_games: Number(r.final_games), last_game: r.last_date ? new Date(r.last_date).toISOString().slice(0, 10) : null,
    }));
  }

  async function athlete(playerId) {
    const pl = (await pool.query(
      `SELECT p.id, p.name, p.jersey, t.id AS team_id, t.name AS team_name, t.sport
         FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`, [playerId])).rows[0];
    if (!pl) return null;
    const { rows: gs } = await pool.query(
      `SELECT g.* FROM games g JOIN game_players gp ON gp.game_id = g.id
        WHERE gp.player_id = $1 AND g.status = 'final' ORDER BY COALESCE(g.game_date, g.created_at::date), g.id`, [playerId]);
    const sums = await Promise.all(gs.map((g) => finalSummary(pool, g)));
    const bySeason = new Map();
    for (const s of sums) {
      const st = s.playerStats[playerId] || {};
      if (!(st.gp > 0)) continue;     // dressed but did not play: not a game played
      const cur = bySeason.get(s.season) || { season: s.season, formats: [], levels: new Set(), parts: [], w: 0, l: 0, t: 0 };
      cur.formats.push(s.format); if (s.level) cur.levels.add(s.level); cur.parts.push(st);
      const us = s.teams.find((x) => x.id === pl.team_id), them = s.teams.find((x) => x.id !== pl.team_id);
      if (us.score > them.score) cur.w += 1; else if (us.score < them.score) cur.l += 1; else cur.t += 1;
      bySeason.set(s.season, cur);
    }
    const seasons = [...bySeason.values()].sort((a, b) => (a.season < b.season ? 1 : -1)).map((c) => {
      const sport = Sports.resolve(pl.sport, mostCommon(c.formats));
      const stats = Engine.sumStats(c.parts);
      const sections = Engine.seasonSections(sport, [{ id: pl.id, jersey: pl.jersey, name: pl.name, stats }]);
      return {
        season: c.season, levels: [...c.levels], format: sport.formatId, games: stats.gp || 0, starts: stats.gs || 0,
        team_record: { w: c.w, l: c.l, t: c.t },
        averages: Engine.averagesLine(sport, stats),
        sections: sections.map((s) => ({ id: s.id, title: s.title, columns: s.columns, cells: s.rows[0] ? s.rows[0].cells : [] })).filter((s) => s.cells.length),
        stats,
      };
    });
    return {
      player: { id: pl.id, name: pl.name, jersey: pl.jersey, sport: pl.sport, sportName: (Sports.get(pl.sport) || {}).name || pl.sport, team: { id: pl.team_id, name: pl.team_name } },
      seasons,
    };
  }

  return { finalSummary, teamSeason, leaders, searchAthletes, athlete, seasonRange, _cache: cache };
}

module.exports = { makeStats };
