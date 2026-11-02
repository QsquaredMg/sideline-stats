/*
 * Stat engine. Pure functions, no I/O. Runs in Node and in the browser.
 *
 * The event log is the single source of truth. Box scores, team scores, period
 * scores and pitcher/goalkeeper credit are all RE-COMPUTED from the log every
 * time. Nothing is ever stored as a running total, so a void or a correction
 * can never leave a stat out of sync with the play that produced it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sports'));
  else root.StatEngine = factory(root.StatSports);
})(typeof self !== 'undefined' ? self : this, function (Sports) {
  'use strict';

  const bump = (stats, key, amt) => { stats[key] = (stats[key] || 0) + amt; };

  function periodName(sport, n) {
    if (n <= sport.periods) return sport.periodNames[n - 1];
    return sport.otName(n - sport.periods);
  }

  /** Expand {stats, valueStats} for one event into a flat { stat: amount } map. */
  function credits(part, value) {
    const out = {};
    if (!part) return out;
    if (part.stats) for (const k of Object.keys(part.stats)) bump(out, k, part.stats[k]);
    if (part.valueStats && value !== null && value !== undefined) {
      for (const k of Object.keys(part.valueStats)) bump(out, k, part.valueStats[k] * value);
    }
    return out;
  }

  /** Primary player's credit, which can differ when a second player is named. */
  function primaryCredits(def, ev) {
    const base = ev.player2_id && def.statsWith ? { stats: def.statsWith, valueStats: def.valueStats } : { stats: def.stats, valueStats: def.valueStats };
    return credits(base, ev.value);
  }

  /* ------------------------------------------------------------------ */
  /* Validation (used by the server on write and the keeper UI on tap)    */
  /* ------------------------------------------------------------------ */

  /**
   * ctx = { playersById: Map|obj of dressed players, homeId, awayId, status }
   * Returns { ok:true, event } with a normalized event, or { ok:false, error }.
   */
  function validateEvent(sport, input, ctx) {
    const def = sport.eventMap[input.type];
    if (!def) return { ok: false, error: `Unknown stat "${input.type}" for ${sport.name}.` };

    const period = Number(input.period);
    if (!Number.isInteger(period) || period < 1 || period > sport.maxPeriods) {
      return { ok: false, error: `Period must be between 1 and ${sport.maxPeriods}.` };
    }

    const get = (id) => (ctx.playersById instanceof Map ? ctx.playersById.get(id) : ctx.playersById[id]);
    const other = (teamId) => (teamId === ctx.homeId ? ctx.awayId : ctx.homeId);
    const out = { type: def.id, period, player_id: null, player2_id: null, team_id: null, value: null, clock_s: null };

    if (def.oncePerGame && ctx.liveEvents && ctx.liveEvents.some((e) => e.type === def.id && !e.voided)) {
      return { ok: false, error: `"${def.label}" is already recorded for this game. Void the existing one first if it needs to change.` };
    }
    if (sport.clock) {
      const raw = input.clock_s;
      if (raw !== undefined && raw !== null && raw !== '') {
        const c = Number(raw);
        const len = Sports.periodLength(sport, period) || 3600;
        if (!Number.isInteger(c) || c < 0 || c > len) return { ok: false, error: `The clock time must be between 0:00 and ${Math.floor(len / 60)}:${String(len % 60).padStart(2, '0')} for this ${sport.periodWord.toLowerCase()}.` };
        out.clock_s = c;
      } else if (def.lineup) {
        return { ok: false, error: 'Set the game clock before entering a substitution so minutes are counted correctly.' };
      }
    }

    if (def.scope === 'team') {
      const tid = Number(input.team_id);
      if (tid !== ctx.homeId && tid !== ctx.awayId) return { ok: false, error: 'That team is not in this game.' };
      if (input.player_id) return { ok: false, error: `"${def.label}" is a team stat and cannot be given to a player.` };
      out.team_id = tid;
    } else {
      const pid = Number(input.player_id);
      const p = get(pid);
      if (!p) return { ok: false, error: 'Pick a player on the roster for this game.' };
      out.player_id = pid;
      out.team_id = p.team_id;
    }

    if (input.player2_id) {
      if (!def.secondary) return { ok: false, error: `"${def.label}" does not involve a second player.` };
      const p2id = Number(input.player2_id);
      const p2 = get(p2id);
      if (!p2) return { ok: false, error: 'The second player is not on this game\'s roster.' };
      if (p2id === out.player_id) return { ok: false, error: 'A player cannot be credited twice on the same play (for example, assisting his or her own basket).' };
      const wantTeam = def.secondary.team === 'same' ? out.team_id : other(out.team_id);
      if (p2.team_id !== wantTeam) {
        return { ok: false, error: `${def.secondary.prompt} must be a player on the ${def.secondary.team === 'same' ? 'same' : 'other'} team.` };
      }
      out.player2_id = p2id;
    } else if (def.secondary && def.secondary.required) {
      return { ok: false, error: `${def.secondary.prompt} is required for "${def.label}".` };
    }

    if (def.value) {
      let val = input.value;
      if (val === undefined || val === null || val === '') val = def.value.default;
      if (val === undefined || val === null) return { ok: false, error: `${def.value.label} is required.` };
      val = Number(val);
      if (!Number.isInteger(val)) return { ok: false, error: `${def.value.label} must be a whole number.` };
      if (def.value.kind === 'choice') {
        if (!def.value.choices.some((c) => c.value === val)) return { ok: false, error: `${def.value.label} is not a valid choice.` };
      } else if (val < def.value.min || val > def.value.max) {
        return { ok: false, error: `${def.value.label} must be between ${def.value.min} and ${def.value.max}.` };
      }
      out.value = val;
    } else if (input.value !== undefined && input.value !== null && input.value !== '') {
      return { ok: false, error: `"${def.label}" does not take a number.` };
    }

    return { ok: true, event: out };
  }

  /* ------------------------------------------------------------------ */
  /* Core computation                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * input = {
   *   sport: 'basketball' | sportObject,
   *   teams: [{id,name}, {id,name}]   // [home, away]
   *   players: [{id, team_id, jersey, name}]   // everyone dressed for this game
   *   events: [{id, type, team_id, player_id, player2_id, value, period, voided, void_reason, created_at}]
   *   final: boolean
   * }
   */
  function computeGame(input) {
    const sport = Sports.resolve(input.sport, input.format);
    if (!sport) throw new Error(`Unknown sport ${input.sport}`);
    const [home, away] = input.teams;
    const teamIds = [home.id, away.id];
    const opp = (tid) => (tid === home.id ? away.id : home.id);

    const playersById = new Map(input.players.map((p) => [p.id, p]));
    const pstats = new Map(input.players.map((p) => [p.id, {}]));
    const tstats = { [home.id]: {}, [away.id]: {} };
    const role = { [home.id]: null, [away.id]: null };
    const scoring = []; // { team, period, pts }
    const warnings = [];
    const warned = new Set();
    const log = [];
    let maxPeriod = 1;
    let voidedCount = 0;
    const clockMax = {};            // latest clock reading seen per period
    const lineupEvs = [];           // applied lineup events (minutes are computed in game-time order below)
    const roleHolders = new Set();  // anyone who was ever set as pitcher / goalkeeper
    const run = { [home.id]: 0, [away.id]: 0 };
    const stints = { [home.id]: [], [away.id]: [] };   // pitching stints, in order, per team
    const snaps = [];               // score after every scoring play, with who was pitching
    const confirmedDecisions = [];

    const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); warnings.push(msg); } };
    const label = (p) => (p ? `#${p.jersey}${p.name ? ' ' + p.name : ''}` : '');

    const events = input.events.slice().sort((a, b) => Number(a.id) - Number(b.id));
    for (const ev of events) {
      const def = sport.eventMap[ev.type];
      const player = ev.player_id ? playersById.get(ev.player_id) : null;
      const player2 = ev.player2_id ? playersById.get(ev.player2_id) : null;
      const teamId = ev.team_id || (player && player.team_id);

      // Log entry (voided entries stay visible in the log; they just carry no stats)
      const entry = {
        id: ev.id, client_id: ev.client_id, type: ev.type, period: ev.period, team_id: teamId,
        label: def ? def.label : ev.type, who: label(player), who2: label(player2),
        prompt: def && def.secondary ? def.secondary.prompt : '', value: ev.value,
        valueLabel: def && def.value ? def.value.label : '',
        valueText: def && def.value && def.value.kind === 'choice' && ev.value !== null && ev.value !== undefined
          ? (def.value.choices.find((c) => c.value === ev.value) || {}).label : null,
        clock_s: ev.clock_s === undefined ? null : ev.clock_s,
        voided: !!ev.voided, void_reason: ev.void_reason || null, created_at: ev.created_at, entered_by: ev.entered_by,
        pending: !!ev.pending,
      };
      log.push(entry);
      if (ev.voided) { voidedCount += 1; continue; }
      if (!def || !teamIds.includes(teamId)) { warnOnce(`bad:${ev.id}`, `Event ${ev.id} (${ev.type}) could not be applied and was skipped.`); continue; }
      if (ev.period > maxPeriod) maxPeriod = ev.period;

      if (ev.clock_s !== null && ev.clock_s !== undefined) clockMax[ev.period] = Math.max(clockMax[ev.period] || 0, ev.clock_s);
      if (def.lineup && player) lineupEvs.push({ ev, player, def });
      if (def.decision && player) confirmedDecisions.push({ decision: def.decision, player_id: player.id, team_id: teamId, event_id: ev.id });

      if (def.setsRole && player) {
        role[teamId] = player.id;
        roleHolders.add(player.id);
        stints[teamId].push({ player_id: player.id, entryDiff: run[teamId] - run[opp(teamId)], outs: 0, event_id: ev.id });
      }

      if (player) {
        const s = pstats.get(player.id);
        const c = primaryCredits(def, ev);
        for (const k of Object.keys(c)) bump(s, k, c[k]);
      }
      if (player2 && def.secondary) {
        const s2 = pstats.get(player2.id);
        const c2 = credits({ stats: def.secondary.stats }, null);
        for (const k of Object.keys(c2)) bump(s2, k, c2[k]);
        if (def.secondary.valueStats && ev.value !== null && ev.value !== undefined) {
          for (const k of Object.keys(def.secondary.valueStats)) bump(s2, k, def.secondary.valueStats[k] * ev.value);
        }
      }
      if (def.teamStats) for (const k of Object.keys(def.teamStats)) bump(tstats[teamId], k, def.teamStats[k]);

      let pts = 0;
      if (def.teamScore) { scoring.push({ team: teamId, period: ev.period, pts: def.teamScore }); pts += def.teamScore; run[teamId] += def.teamScore; }
      if (def.oppScore) { scoring.push({ team: opp(teamId), period: ev.period, pts: def.oppScore }); run[opp(teamId)] += def.oppScore; }
      if ((def.teamScore || def.oppScore) && sport.decisions) {
        snaps.push({ h: run[home.id], a: run[away.id], hs: stints[home.id].length - 1, as: stints[away.id].length - 1 });
      }
      entry.pts = pts;
      entry.oppPts = def.oppScore || 0;

      if (def.defense) {
        const holder = role[opp(teamId)];
        if (holder) {
          const c = credits(def.defense, ev.value);
          const s = pstats.get(holder);
          for (const k of Object.keys(c)) bump(s, k, c[k]);
          const cur = stints[opp(teamId)][stints[opp(teamId)].length - 1];
          if (cur && c.outs) cur.outs += c.outs;
        } else {
          const side = opp(teamId) === home.id ? home.name : away.name;
          warnOnce(`norole:${opp(teamId)}`, `No ${sport.roleLabel} is set for ${side}, so ${sport.roleLabel} credit is being skipped. Set one with "${sport.events.find((e) => e.setsRole).label}".`);
        }
      }
    }

    /* Scores --------------------------------------------------------- */
    const periodCount = Math.max(sport.periods, maxPeriod, Number(input.currentPeriod) || 1);
    const periodPts = { [home.id]: new Array(periodCount).fill(0), [away.id]: new Array(periodCount).fill(0) };
    for (const sc of scoring) periodPts[sc.team][sc.period - 1] += sc.pts;

    const currentPeriod = Math.max(maxPeriod, Number(input.currentPeriod) || 1);
    const totals = {};
    const setsWon = { [home.id]: 0, [away.id]: 0 };
    if (sport.scoreMode === 'sets') {
      for (let p = 1; p <= periodCount; p++) {
        const complete = p < currentPeriod || (p === currentPeriod && input.final);
        if (!complete) continue;
        const h = periodPts[home.id][p - 1], a = periodPts[away.id][p - 1];
        if (h > a) setsWon[home.id] += 1; else if (a > h) setsWon[away.id] += 1;
      }
      totals[home.id] = setsWon[home.id];
      totals[away.id] = setsWon[away.id];
    } else {
      for (const t of teamIds) totals[t] = periodPts[t].reduce((a, b) => a + b, 0);
    }

    /* Minutes, starts, games played ---------------------------------- */
    // Minutes come from lineup events replayed in GAME-TIME order (period, clock), not entry order,
    // so a late or offline entry cannot change who was on the court when.
    const minS = new Map(), started = new Set(), appeared = new Set();
    const onSince = new Map();
    let onCourtNow = [];
    const tracked = { [home.id]: false, [away.id]: false };
    if (sport.minutes) {
      lineupEvs.sort((a, b) => a.ev.period - b.ev.period || (a.ev.clock_s || 0) - (b.ev.clock_s || 0) || Number(a.ev.id) - Number(b.ev.id));
      for (const { ev, player, def } of lineupEvs) {
        const pid = player.id, p = ev.period, c = ev.clock_s || 0;
        tracked[player.team_id] = true;
        if (def.lineup === 'in') {
          if (onSince.has(pid)) { warnOnce(`dupin:${ev.id}`, `${label(player)} was entered twice without leaving. The second entry was ignored.`); continue; }
          onSince.set(pid, { p, c });
          appeared.add(pid);
          if (p === 1 && c === 0) started.add(pid);
          const n = [...onSince.keys()].filter((id) => playersById.get(id).team_id === player.team_id).length;
          if (sport.onCourtMax && n > sport.onCourtMax) {
            warnOnce(`over:${player.team_id}:${p}:${c}`, `${n} players are entered at once for ${player.team_id === home.id ? home.name : away.name} (the limit is ${sport.onCourtMax}). Check the substitutions near ${periodName(sport, p)} ${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}.`);
          }
        } else {
          const since = onSince.get(pid);
          if (!since) { warnOnce(`outnoin:${ev.id}`, `${label(player)} left the game but was never entered, so that stretch is not counted in minutes.`); continue; }
          minS.set(pid, (minS.get(pid) || 0) + elapsedBetween(sport, since.p, since.c, p, c));
          onSince.delete(pid);
        }
      }
      onCourtNow = [...onSince.keys()];
      // Anyone still in at the end is counted to the last known time (or the full period once the game is final).
      let endP = maxPeriod;
      let endC = input.final ? Sports.periodLength(sport, endP) : (clockMax[endP] || 0);
      const lc = input.liveClock;
      if (!input.final && lc && Number.isInteger(lc.period) && lc.period >= endP && Number.isInteger(lc.clock_s)) { endP = lc.period; endC = lc.clock_s; }
      for (const [pid, since] of onSince) {
        minS.set(pid, (minS.get(pid) || 0) + elapsedBetween(sport, since.p, since.c, Math.max(endP, since.p), endP > since.p ? endC : Math.max(endC, since.c)));
      }
    }
    for (const p of input.players) {
      const s = pstats.get(p.id);
      const played = Object.keys(s).length > 0 || appeared.has(p.id) || roleHolders.has(p.id);
      if (played) s.gp = 1;
      if (started.has(p.id)) s.gs = 1;
      if (sport.minutes && tracked[p.team_id]) {
        if (minS.get(p.id)) { s.min_s = minS.get(p.id); s.min_g = 1; }
        else if (appeared.has(p.id)) s.min_g = 1;
        else if (Object.keys(s).length > (s.gp ? 1 : 0)) {
          warnOnce(`noapp:${p.id}`, `${label(p)} has stats but was never entered in the lineup, so no minutes are counted for the player.`);
        }
      }
    }

    /* Pitcher decisions: proposals the scorer confirms -------------------- */
    const decisions = sport.decisions
      ? buildDecisions({ sport, home, away, totals, snaps, stints, playersById, confirmed: confirmedDecisions, final: !!input.final, label, warnOnce })
      : null;

    /* Box-score sections -------------------------------------------- */
    const teamOut = [home, away].map((t, i) => {
      const roster = input.players
        .filter((p) => p.team_id === t.id)
        .sort((a, b) => jerseySort(a.jersey, b.jersey));
      const sections = buildSections(sport, roster.map((p) => ({ id: p.id, jersey: p.jersey, name: p.name, stats: pstats.get(p.id) })), tstats[t.id], true);
      return {
        id: t.id, name: t.name, side: i === 0 ? 'home' : 'away',
        score: totals[t.id], periodPts: periodPts[t.id], setsWon: setsWon[t.id],
        currentRole: role[t.id] ? label(playersById.get(role[t.id])) : null,
        onCourt: onCourtNow.filter((id) => playersById.get(id).team_id === t.id),
        lineupTracked: !!tracked[t.id],
        sections,
      };
    });

    return {
      sport: sport.id, sportName: sport.name, scoreMode: sport.scoreMode,
      format: sport.formatId || null, formatLabel: sport.formatLabel || '',
      clock: !!sport.clock, minutes: !!sport.minutes,
      periodCount, currentPeriod, periodNames: Array.from({ length: periodCount }, (_, i) => periodName(sport, i + 1)),
      teams: teamOut, warnings, log, voidedCount, final: !!input.final,
      decisions,
      playerStats: Object.fromEntries(pstats),
    };
  }

  /** Seconds between two points in game time. Periods have fixed lengths, so a stint can span several. */
  function elapsedBetween(sport, p1, c1, p2, c2) {
    if (p2 < p1) return 0;
    if (p2 === p1) return Math.max(0, c2 - c1);
    let t = Math.max(0, (Sports.periodLength(sport, p1) || 0) - c1);
    for (let p = p1 + 1; p < p2; p++) t += Sports.periodLength(sport, p) || 0;
    return t + c2;
  }

  /**
   * Box-score tables for one team (or one season). rows = [{ id, jersey, name, stats }].
   * Columns marked showIf only appear when somebody on the roster has data for them.
   */
  function buildSections(sport, rows, teamOnly, withFlags) {
    const rosterAgg = {};
    for (const r of rows) for (const k of Object.keys(r.stats)) bump(rosterAgg, k, r.stats[k]);
    return sport.sections.map((sec) => {
      const cols = sec.columns.filter((c) => !c.showIf || c.showIf(rosterAgg, sport));
      const out = [];
      const agg = {};
      for (const r of rows) {
        const st = r.stats;
        if (!sec.showAll && !(sec.visible && sec.visible(st))) continue;
        out.push({
          player_id: r.id, jersey: r.jersey, name: r.name,
          cells: cols.map((c) => c.calc(st, sport)),
          flags: withFlags ? (sport.flags || []).filter((f) => f.stat in st && st[f.stat] >= f.gte && (f.lt === undefined || st[f.stat] < f.lt)).map((f) => ({ label: f.label, tone: f.tone })) : [],
          stats: st,
        });
        for (const k of Object.keys(st)) bump(agg, k, st[k]);
      }
      const aggAll = Object.assign({}, agg);
      if (sec.showAll && teamOnly) for (const k of Object.keys(teamOnly)) bump(aggAll, k, teamOnly[k]);
      return { id: sec.id, title: sec.title, columns: cols.map((c) => ({ key: c.key, label: c.label })), rows: out, totals: cols.map((c) => c.calc(aggAll, sport)), showAll: !!sec.showAll };
    }).filter((sec) => sec.rows.length > 0 || sec.showAll);
  }

  /* ------------------------------------------------------------------ */
  /* Pitcher decisions (W / L / SV)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Proposes the win, loss and save from the play log and compares them with what the scorer confirmed.
   * The proposal never changes a stat by itself: a decision only counts once a dec_* event is entered.
   *
   * Rules used (standard official-scoring rules, simplified and stated on the rules page):
   *  - The WIN goes to the pitcher of record when the winning team took the lead it never gave up again.
   *    A starter must have recorded the minimum outs (5 innings of 9, 4 of 7); otherwise the scorer picks
   *    the most effective reliever, and we suggest the one with the most outs.
   *  - The LOSS goes to the losing team's pitcher on the mound when that final lead was taken.
   *  - The SAVE goes to the winning team's finishing pitcher (not the winner) who entered with a lead of
   *    3 or fewer and got at least 3 outs, or got 9 outs with any lead. "Tying run on deck" is not computed.
   * Inherited runners are not charged to the previous pitcher, same as the earned-run note.
   */
  function buildDecisions(c) {
    const { sport, home, away, totals, snaps, stints, playersById, confirmed, final, label, warnOnce } = c;
    const who = (pid) => label(playersById.get(pid));
    const proposals = [];
    const hs = totals[home.id], as = totals[away.id];
    const decided = final && hs !== as;
    if (decided && snaps.length) {
      const win = hs > as ? home : away, lose = win === home ? away : home;
      const wk = win === home ? 'h' : 'a', lk = win === home ? 'a' : 'h';
      const ws = stints[win.id], ls = stints[lose.id];
      // Walk back from the end to find the moment the winner took the lead it never gave up.
      let i = snaps.length - 1;
      while (i > 0 && snaps[i - 1][wk] > snaps[i - 1][lk]) i -= 1;
      const go = snaps[i];
      const wIdx = win === home ? go.hs : go.as;
      const lIdx = win === home ? go.as : go.hs;
      let winStint = ws[wIdx];
      if (!winStint) {
        proposals.push({ decision: 'W', team_id: win.id, player_id: null, reason: `No pitcher was set for ${win.name} when the winning lead was taken, so no win can be suggested.`, needsJudgment: true });
      } else {
        let reason = `${who(winStint.player_id)} was pitching when ${win.name} took the lead it kept.`;
        let judgment = false;
        if (wIdx === 0 && winStint.outs < (sport.winMinOuts || 0) && ws.length > 1) {
          const relievers = ws.slice(1);
          const best = relievers.reduce((a, b) => (b.outs > a.outs ? b : a), relievers[0]);
          winStint = best;
          judgment = true;
          reason = `The starter did not get ${sport.winMinOuts} outs, so the scorer chooses the most effective reliever. Suggested: ${who(best.player_id)}, who got the most outs (${best.outs}) of the relievers.`;
        }
        proposals.push({ decision: 'W', team_id: win.id, player_id: winStint.player_id, label: who(winStint.player_id), reason, needsJudgment: judgment });
        // Save
        const fin = ws[ws.length - 1];
        if (fin && fin !== winStint && ws.length > 1) {
          const lead = fin.entryDiff;
          const okShort = lead > 0 && lead <= 3 && fin.outs >= 3;
          const okLong = lead > 0 && fin.outs >= 9;
          if (okShort || okLong) {
            proposals.push({ decision: 'SV', team_id: win.id, player_id: fin.player_id, label: who(fin.player_id),
              reason: `${who(fin.player_id)} finished the game for ${win.name}, entered with a ${lead}-run lead and got ${fin.outs} outs.`, needsJudgment: false });
          }
        }
      }
      const loseStint = ls[lIdx];
      if (!loseStint) {
        proposals.push({ decision: 'L', team_id: lose.id, player_id: null, reason: `No pitcher was set for ${lose.name} when the winning lead was taken, so no loss can be suggested.`, needsJudgment: true });
      } else {
        proposals.push({ decision: 'L', team_id: lose.id, player_id: loseStint.player_id, label: who(loseStint.player_id),
          reason: `${who(loseStint.player_id)} was pitching when ${win.name} took the lead it kept.`, needsJudgment: false });
      }
    }

    const differs = [];
    for (const pr of proposals) {
      const conf = confirmed.find((x) => x.decision === pr.decision);
      if (conf && pr.player_id && conf.player_id !== pr.player_id) {
        differs.push({ decision: pr.decision, confirmed: who(conf.player_id), proposed: pr.label });
      }
    }
    for (const kind of ['W', 'L', 'SV']) {
      if (confirmed.filter((x) => x.decision === kind).length > 1) warnOnce(`dup:${kind}`, `More than one ${kind === 'W' ? 'winning pitcher' : kind === 'L' ? 'losing pitcher' : 'save'} is recorded. Void the extra one.`);
    }
    if (decided) {
      const win = hs > as ? home : away;
      for (const x of confirmed) {
        const shouldBeWinner = x.decision === 'W' || x.decision === 'SV';
        if ((x.team_id === win.id) !== shouldBeWinner) warnOnce(`wrongteam:${x.event_id}`, `${x.decision === 'L' ? 'The loss' : x.decision === 'W' ? 'The win' : 'The save'} is recorded for ${who(x.player_id)}, who is on the ${shouldBeWinner ? 'losing' : 'winning'} team.`);
      }
    }
    return { available: true, decided, proposals, confirmed, differs };
  }

  function jerseySort(a, b) {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  /* ------------------------------------------------------------------ */
  /* Scoreboard checkpoints                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Compare what the event log says against what the official scoreboard showed.
   * checkpoints: [{ id, period, home_score, away_score }]; the latest one per period is used.
   */
  function checkCheckpoints(computed, checkpoints) {
    const latest = new Map();
    for (const cp of checkpoints.slice().sort((a, b) => Number(a.id) - Number(b.id))) latest.set(cp.period, cp);
    const [h, a] = computed.teams;
    const res = [];
    for (const [period, cp] of [...latest.entries()].sort((x, y) => x[0] - y[0])) {
      let ours;
      if (computed.scoreMode === 'sets') ours = [h.periodPts[period - 1] || 0, a.periodPts[period - 1] || 0];
      else ours = [h, a].map((t) => t.periodPts.slice(0, period).reduce((x, y) => x + y, 0));
      const official = [cp.home_score, cp.away_score];
      res.push({
        period, periodName: computed.periodNames[period - 1] || String(period),
        official, ours, match: ours[0] === official[0] && ours[1] === official[1],
        diff: [official[0] - ours[0], official[1] - ours[1]],
      });
    }
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* Plain-English description of what a button does (rules page)         */
  /* ------------------------------------------------------------------ */

  function explain(sport, def) {
    const L = (k) => sport.statLabels[k] || k.toUpperCase();
    const fmt = (map) => Object.keys(map || {}).map((k) => `${map[k] >= 0 ? '+' : ''}${map[k]} ${L(k)}`);
    const lines = [];
    const prim = def.stats ? fmt(def.stats) : [];
    if (def.valueStats) prim.push(...Object.keys(def.valueStats).map((k) => `+${def.value ? def.value.label.toLowerCase() : 'value'} to ${L(k)}`));
    if (def.lineup) {
      lines.push({ who: 'Selected player', what: [def.lineup === 'in'
        ? 'enters the game at the clock time entered; minutes, starts (in at the opening tip/whistle) and games played are counted from this'
        : 'leaves the game at the clock time entered; minutes stop counting'] });
    } else if (def.scope === 'team') {
      if (def.teamStats) lines.push({ who: 'Team total', what: fmt(def.teamStats) });
    } else if (def.setsRole) {
      lines.push({ who: 'Selected player', what: [`becomes the current ${sport.roleLabel || 'role'}; later results credit this player automatically`] });
    } else if (prim.length) {
      lines.push({ who: 'Selected player', what: prim });
    }
    if (def.secondary) {
      const sec = fmt(def.secondary.stats);
      if (def.secondary.valueStats) sec.push(...Object.keys(def.secondary.valueStats).map((k) => `+${def.value ? def.value.label.toLowerCase() : 'value'} to ${L(k)}`));
      lines.push({ who: `${def.secondary.prompt} (${def.secondary.team === 'same' ? 'same team' : 'other team'}${def.secondary.required ? ', required' : ', optional'})`, what: sec });
      if (def.statsWith) lines.push({ who: 'Selected player instead gets', what: fmt(def.statsWith), note: 'when a second player is named' });
    }
    if (def.defense) {
      const d = fmt(def.defense.stats);
      if (def.defense.valueStats) d.push(...Object.keys(def.defense.valueStats).map((k) => `+${def.value ? def.value.label.toLowerCase() : 'value'} to ${L(k)}`));
      lines.push({ who: `Opposing ${sport.roleLabel}`, what: d });
    }
    if (def.teamScore) lines.push({ who: 'Score', what: [`+${def.teamScore} to the player's team`] });
    if (def.oppScore) lines.push({ who: 'Score', what: [`+${def.oppScore} to the opponent`] });
    return lines;
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                  */
  /* ------------------------------------------------------------------ */

  function csvCell(x) {
    const s = String(x === null || x === undefined ? '' : x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(computed, meta) {
    const rows = [];
    rows.push(['Game', `${computed.teams[0].name} vs ${computed.teams[1].name}`]);
    rows.push(['Sport', computed.sportName]);
    if (meta && meta.date) rows.push(['Date', meta.date]);
    rows.push(['Status', computed.final ? 'FINAL' : 'LIVE']);
    rows.push(['Score', `${computed.teams[0].name} ${computed.teams[0].score} - ${computed.teams[1].score} ${computed.teams[1].name}`]);
    rows.push([]);
    rows.push(['Period', ...computed.teams.map((t) => t.name)]);
    for (let i = 0; i < computed.periodCount; i++) rows.push([computed.periodNames[i], ...computed.teams.map((t) => t.periodPts[i])]);
    for (const t of computed.teams) {
      for (const sec of t.sections) {
        rows.push([]);
        rows.push([`${t.name} - ${sec.title}`]);
        rows.push(['#', 'Player', ...sec.columns.map((c) => c.label)]);
        for (const r of sec.rows) rows.push([r.jersey, r.name, ...r.cells]);
        if (sec.totals) rows.push(['', 'TOTAL', ...sec.totals]);
      }
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ */
  /* Season totals and leaderboards                                       */
  /* ------------------------------------------------------------------ */

  /** Adds raw stat objects together (every stat in the engine is additive, including gp, gs and minutes). */
  function sumStats(list) {
    const out = {};
    for (const s of list) for (const k of Object.keys(s || {})) bump(out, k, s[k]);
    return out;
  }

  /** Season label for a game date: August to July, so a March 2027 game belongs to "2026-27". */
  function seasonLabel(dateStr) {
    const m = /^(\d{4})-(\d{2})/.exec(String(dateStr || ''));
    if (!m) return 'Unknown';
    const y = Number(m[1]), mo = Number(m[2]);
    const start = mo >= 8 ? y : y - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
  }

  const timeText = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, '0')}`;

  /** Per-game averages for a stat line (games played as the denominator; minutes use games with minutes). */
  function averagesLine(sport, stats) {
    const gp = stats.gp || 0;
    return (sport.averages || []).map((a) => {
      const den = a.time ? (stats.min_g || 0) : gp;
      const val = a.get(stats, sport);
      return { key: a.key, label: a.label, value: den ? (a.time ? timeText(val / den) : (val / den).toFixed(1)) : '-' };
    });
  }

  /** Box-score style tables for a season: rows = [{ id, jersey, name, stats }] with summed stats. */
  function seasonSections(sport, rows) {
    return buildSections(sport, rows, null, false);
  }

  /**
   * Leaderboards. rows = [{ player_id, team_id, team_name, jersey, name, stats, teamGames }].
   * Counting stats have no minimum. Per-game stats need half of the team's games played. Rate stats
   * (percentages, ERA) only list players who meet the category's stated minimum, so one lucky attempt
   * cannot top a board.
   */
  function computeLeaders(sport, rows, opts) {
    const limit = (opts && opts.limit) || 10;
    return (sport.leaders || []).map((cat) => {
      const list = [];
      for (const r of rows) {
        const st = r.stats || {}, gp = st.gp || 0;
        if (!gp) continue;
        let val = cat.get(st, sport);
        let ok = true;
        if (cat.mode === 'avg') { ok = gp >= Math.max(1, Math.ceil(0.5 * (r.teamGames || 0))); val = val / gp; }
        else if (cat.mode === 'rate') ok = val !== null && val !== undefined && cat.qual(st, r.teamGames || 0);
        else ok = val > 0;
        if (!ok || val === null || val === undefined || !isFinite(val)) continue;
        if (cat.mode === 'avg' && val <= 0) continue;
        list.push({ player_id: r.player_id, team_id: r.team_id, team_name: r.team_name, jersey: r.jersey, name: r.name, value: val });
      }
      const dir = cat.lowerBetter ? 1 : -1;
      list.sort((a, b) => dir * (a.value - b.value) || String(a.name).localeCompare(String(b.name)));
      const fmtv = cat.fmt || (cat.mode === 'avg' ? (x) => x.toFixed(1) : (x) => String(Math.round(x * 10) / 10));
      const ranked = [];
      list.forEach((x, idx) => {
        const prev = ranked[ranked.length - 1];
        const tied = prev && Math.abs(prev.value - x.value) < 1e-9;
        const rank = tied ? prev.rank : idx + 1;
        if (rank > limit) return;
        ranked.push(Object.assign({}, x, { rank, tied: !!tied || (list[idx + 1] && Math.abs(list[idx + 1].value - x.value) < 1e-9) || false, display: fmtv(x.value) }));
      });
      return { id: cat.id, label: cat.label, mode: cat.mode, qualText: cat.qualText || (cat.mode === 'avg' ? 'min. half of the team\'s games played' : ''), leaders: ranked };
    });
  }

  return { computeGame, validateEvent, checkCheckpoints, explain, toCSV, periodName, jerseySort, elapsedBetween, buildSections, sumStats, seasonLabel, averagesLine, seasonSections, computeLeaders };
});
