-- Sideline Stats schema. Idempotent: safe to run on every boot.
--
-- Design rules that make the numbers trustworthy:
--   * `events` is APPEND-ONLY. Nothing is ever edited or deleted; a mistake is
--     voided (with who/when/why) and the box score is recomputed from the log.
--   * There are no stored totals anywhere. Stats are always derived.
--   * `audit_log` records every action, including voids, finals and reopenings.
--   * `checkpoints` hold what the official scoreboard said, so the event log can
--     be reconciled against it at any time.

-- A school (or club) is the unit an athletic director controls. The AD picks a PIN; anyone who wants to
-- start a game involving one of the school's teams has to know it. Only a salted scrypt hash is stored.
CREATE TABLE IF NOT EXISTS schools (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  pin_salt    TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A team is (name, sport): "Provine Rams" basketball and "Provine Rams" football are
-- different teams with different players, so #23 in one can never be mistaken for #23 in the other.
CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,                   -- lower(trim(name)) so rosters can be reused
  sport       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upgrade path for databases created by v1 (name_key was unique on its own).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT '';
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_sport_idx ON teams (name_key, sport);
-- v2.1: a team can belong to one school, whose PIN then guards starting games for that team.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS school_id INT REFERENCES schools(id);

-- A player is (team, jersey, name). The same jersey with a DIFFERENT name is a different
-- person (new season, new kid), so old games keep their old names and stats never merge
-- two people into one career.
CREATE TABLE IF NOT EXISTS players (
  id        SERIAL PRIMARY KEY,
  team_id   INT  NOT NULL REFERENCES teams(id),
  jersey    TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  name_key  TEXT NOT NULL DEFAULT ''
);
ALTER TABLE players ADD COLUMN IF NOT EXISTS name_key TEXT NOT NULL DEFAULT '';
UPDATE players SET name_key = lower(name) WHERE name_key = '' AND name <> '';
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_team_id_jersey_key;
CREATE UNIQUE INDEX IF NOT EXISTS players_identity_idx ON players (team_id, jersey, name_key);

CREATE TABLE IF NOT EXISTS games (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,         -- public share code, e.g. K7M2QX
  sport          TEXT NOT NULL,
  home_team_id   INT  NOT NULL REFERENCES teams(id),
  away_team_id   INT  NOT NULL REFERENCES teams(id),
  level          TEXT NOT NULL DEFAULT '',     -- Varsity / JV / College ...
  format         TEXT NOT NULL DEFAULT '',     -- rules in force: hs, college, college_m ... ('' = the sport's default)
  game_date      DATE,
  status         TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'final')),
  keeper_key     TEXT NOT NULL,                -- secret; grants stat-keeper access
  version        INT  NOT NULL DEFAULT 0,      -- bumps on every change (drives live updates)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at   TIMESTAMPTZ,
  CHECK (home_team_id <> away_team_id)
);

-- Who was dressed for THIS game (rosters can change game to game).
CREATE TABLE IF NOT EXISTS game_players (
  game_id    INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  INT NOT NULL REFERENCES players(id),
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,          -- server order = scoring order
  game_id      INT  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL,                  -- generated on the phone; makes retries idempotent
  type         TEXT NOT NULL,                  -- key from shared/sports.js
  team_id      INT  NOT NULL REFERENCES teams(id),
  player_id    INT  REFERENCES players(id),
  player2_id   INT  REFERENCES players(id),    -- assist / blocker / receiver / ...
  value        INT,                            -- yards, earned-run flag, ...
  period       INT  NOT NULL CHECK (period >= 1),
  clock_s      INT  CHECK (clock_s IS NULL OR (clock_s >= 0 AND clock_s <= 7200)),   -- seconds ELAPSED in the period (timed sports)
  entered_by   TEXT NOT NULL DEFAULT 'keeper', -- keeper | admin
  voided       BOOLEAN NOT NULL DEFAULT false,
  void_reason  TEXT,
  voided_by    TEXT,
  voided_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, client_id)
);
CREATE INDEX IF NOT EXISTS events_game_idx ON events (game_id, id);

-- Backfill for databases created by v1: a team that only ever played one sport gets that sport.
UPDATE teams t SET sport = s.sport
  FROM (SELECT team_id, MIN(sport) AS sport, COUNT(DISTINCT sport) AS n
          FROM (SELECT home_team_id AS team_id, sport FROM games UNION ALL SELECT away_team_id, sport FROM games) x
         GROUP BY team_id) s
 WHERE t.id = s.team_id AND t.sport = '' AND s.n = 1;

-- v2 upgrades (additive; old rows keep working: no clock, default format).
ALTER TABLE games  ADD COLUMN IF NOT EXISTS format  TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS clock_s INT CHECK (clock_s IS NULL OR (clock_s >= 0 AND clock_s <= 7200));
CREATE INDEX IF NOT EXISTS games_final_idx ON games (sport, status);
CREATE INDEX IF NOT EXISTS game_players_player_idx ON game_players (player_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id          SERIAL PRIMARY KEY,
  game_id     INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  period      INT NOT NULL CHECK (period >= 1),
  home_score  INT NOT NULL CHECK (home_score >= 0),
  away_score  INT NOT NULL CHECK (away_score >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkpoints_game_idx ON checkpoints (game_id, id);

-- Anyone at the game can flag a problem; an administrator resolves it.
CREATE TABLE IF NOT EXISTS disputes (
  id           SERIAL PRIMARY KEY,
  game_id      INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_id     BIGINT REFERENCES events(id),
  name         TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS disputes_game_idx ON disputes (game_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  game_id     INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,                   -- keeper | admin | public
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_game_idx ON audit_log (game_id, id);
