# Sideline Stats

Fair, auditable, multi-sport live stat tracker for high school and college programs.
Basketball, football, baseball, softball, soccer and volleyball. Node/Express + Postgres, one Railway service.

## How it works
- One person (the stat keeper) taps plays on a phone: pick a player, tap what they did. Assists, blocks, steals, receivers and yardage are captured in the same step.
- Everyone else opens the public link and watches the box score update live.
- Every number is **computed from the play log**. Nothing is typed in as a total.

## Fairness built in
- Same buttons and formulas for both teams; the rules page (`/rules/<sport>`) is generated from the same definitions the app runs.
- Append-only log: mistakes are *voided* with a reason, never deleted. Public play-by-play shows corrections.
- Scoreboard checks: the keeper enters the official score; any gap with the stats is shown publicly.
- Public audit trail of every action.
- Final lock: after "End game", only someone with `ADMIN_PIN` can change anything, and each change needs a written reason.
- Anyone can flag a problem from the game page; only the admin resolves it.
- Team is derived from the player server-side, self-assists and cross-team assists are rejected, retries are idempotent.
- Works offline at the gym: plays queue on the phone and send when the connection returns.

## Deploy on Railway
1. New project, add the **PostgreSQL** plugin, then deploy this repo/folder as a service.
2. Variables on the web service:
   - `DATABASE_URL` (reference the Postgres plugin variable)
   - `ADMIN_PIN` (athletic director PIN: corrections after final, dispute resolution, reopen)
   - `CREATE_PIN` (optional: one shared PIN for starting games, for teams that no school has claimed)
   - `SCHOOL_SETUP_CODE` (optional: if set, athletic directors need it to register a school, which stops someone registering your school's name first)
   - `STATS_API_KEY` (optional: turns on the athlete lookup API GoatReelz uses; unset = those endpoints return 404)
3. Start command is `npm start`. The schema is created automatically on boot. Health check: `/healthz`.

## Run locally
```
npm install
DATABASE_URL=postgres://user@localhost:5432/stats ADMIN_PIN=1234 npm start
```

## Tests
```
npm test                                   # engine tests (no database needed)
TEST_DATABASE_URL=postgres://... npm test  # plus API integration tests (WIPES the public schema)
```

## Adding or changing a sport
Everything about a sport lives in `shared/sports.js`: buttons, exactly which stats each credits, how the score moves, box-score columns. The keeper UI, public page, rules page, validation and CSV export all read that one definition.

## Athletic directors choose their own PIN
Athletic directors open `/school`, register their school with a PIN they choose (6+ characters), and add their teams. From then on, starting a game that involves one of those teams needs that school's PIN: the home or the away school's PIN works, so a visiting scorer can use their own. Teams no school has claimed keep the old rule (`CREATE_PIN` if set, otherwise open). Viewing games and stats is always public.
- PINs are stored only as salted scrypt hashes, guesses are rate limited, and a refused attempt creates nothing.
- Changing a PIN needs the current one. A forgotten PIN is reset by the operator with `ADMIN_PIN` (send `x-admin-pin` to `POST /api/schools/:id/pin` with `{"newPin": "..."}`); the operator's `ADMIN_PIN` can also start any game.
- A team belongs to one school; claiming one that another school owns is refused.
- Removing a team (`DELETE /api/schools/:id/teams`) or deleting a school (`DELETE /api/schools/:id`, which also needs the school name typed as confirmation) needs the school PIN, or the operator's `ADMIN_PIN` for a school whose PIN was lost. Either one only *releases* the teams: they, their players and every game they played are left untouched, and anyone can then start games for those teams again. Stats are never deleted.

## Season totals, leaderboards, clock and minutes
- **Season pages** (`/t/<team id>`, `/stats`): season totals per player and leaderboards, computed only from *final* games. Seasons run August to July. Leaderboards offer total, per-game average (a player must have played in at least half their team's games) and rate stats (with a qualifying minimum). Ties share a rank. Leaders never mix formats or levels (high school vs college, men vs women).
- **Rule formats**: pick high school or college rules per game (for example 4x8 min vs 2x20 min basketball, best of 5 vs 3 volleyball). Period lengths and the clock direction come from the format.
- **Game clock and minutes**: the keeper can set the clock; plays are stamped with it, and minutes are replayed from substitutions in (period, clock) order. Everything is derived, so voiding a sub fixes minutes too. When a game is final, the last period counts to full length.
- **Pitcher decisions**: the engine *proposes* the win, loss and save from the rules (go-ahead lead never given up, starter minimum outs, save situation). The scorer confirms or overrides them when finishing the game; the box score shows where the confirmed decision differs from the proposal.

## GoatReelz link
With `STATS_API_KEY` set, `GET /api/athletes/search?q=` and `GET /api/athletes/:id` (Bearer key) return a player's season lines. GoatReelz calls these server-side. It stores only the player id and a name snapshot, and fetches the numbers when a profile is viewed, so Sideline stays the single source of truth. See the GoatReelz migration `0026_stat_links.sql` for the consent and coach-approval rules.

## Known limits
- If a team's lineup is not tracked (no starters / subs entered), that team gets no minutes; it is never guessed. A warning is shown.
- Pitcher save check does not evaluate the "tying run on deck" case, and runs charged to inherited runners are not computed; the scorer confirms decisions for exactly this reason.
- Season totals do not include team-only stats.
- Live-update (SSE) and the leaderboard cache are in memory: run a single instance.
- No accounts: access is by keeper link, `ADMIN_PIN` and `STATS_API_KEY`.
