-- Время везде в миллисекундах с 1970 года (как Date.now() на странице).

CREATE SEQUENCE player_seq;
CREATE SEQUENCE tour_seq;

CREATE TABLE players (
  id          text PRIMARY KEY DEFAULT 'p' || nextval('player_seq'),
  name        text NOT NULL,
  handle      text NOT NULL UNIQUE,
  code        text NOT NULL UNIQUE,
  city        text NOT NULL DEFAULT '',
  club        text NOT NULL DEFAULT '',
  ver         boolean NOT NULL DEFAULT false,      -- подтверждённый игрок
  admin       boolean NOT NULL DEFAULT false,
  vk_id       bigint UNIQUE,                       -- null у гостей без VK
  owner_id    text REFERENCES players(id) ON DELETE SET NULL, -- кто создал гостя
  rating      double precision NOT NULL DEFAULT 1500, -- Эло без округления, как в recalc()
  rated       integer NOT NULL DEFAULT 0,          -- турнирных матчей в рейтинге
  created_at  bigint NOT NULL
);
CREATE INDEX players_owner_name ON players (owner_id, lower(name)) WHERE vk_id IS NULL;
CREATE INDEX players_rated ON players (rating DESC) WHERE rated > 0;

-- Готовая статистика (как pStats на странице): scope all — все матчи, tour — турнирные.
CREATE TABLE player_stats (
  player_id  text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('all', 'tour')),
  n          integer NOT NULL DEFAULT 0,
  w          integer NOT NULL DEFAULT 0,
  pts        integer NOT NULL DEFAULT 0,
  darts      integer NOT NULL DEFAULT 0,
  f9s        double precision NOT NULL DEFAULT 0,
  f9n        integer NOT NULL DEFAULT 0,
  coh        integer NOT NULL DEFAULT 0,
  coa        integer NOT NULL DEFAULT 0,
  hco        integer NOT NULL DEFAULT 0,
  hi         integer NOT NULL DEFAULT 0,
  c180       integer NOT NULL DEFAULT 0,
  c140       integer NOT NULL DEFAULT 0,
  c100       integer NOT NULL DEFAULT 0,
  bl         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, scope)
);

CREATE TABLE tournaments (
  id          text PRIMARY KEY DEFAULT 't' || nextval('tour_seq'),
  name        text NOT NULL,
  official    boolean NOT NULL DEFAULT false,
  owner_id    text REFERENCES players(id) ON DELETE SET NULL,
  org_name    text,                                -- подпись организатора; null — имя владельца
  org_ver     boolean NOT NULL DEFAULT false,
  city        text NOT NULL DEFAULT '',
  venue       text NOT NULL DEFAULT '',
  start       bigint NOT NULL,
  reg_until   bigint,
  status      text NOT NULL CHECK (status IN ('reg', 'live', 'done')),
  format      text NOT NULL CHECK (format IN ('pl', 'ko', 'rr')),
  mode        integer NOT NULL CHECK (mode IN (301, 501, 701)),
  ltw         integer NOT NULL CHECK (ltw BETWEEN 1 AND 5),
  dbl         boolean NOT NULL DEFAULT true,
  cap         integer NOT NULL,
  slots       jsonb,                               -- посев сетки (pl, ko): id или null
  version     integer NOT NULL DEFAULT 1,
  done_at     bigint,                              -- когда сыгран последний матч
  created_at  bigint NOT NULL
);
CREATE INDEX tournaments_status ON tournaments (status, start DESC);
CREATE INDEX tournaments_done ON tournaments (done_at DESC) WHERE status = 'done';

-- Участники. seed_no — порядок в t.players (посев); place_* — текущее место или диапазон.
CREATE TABLE entries (
  tournament_id text NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seed_no       integer NOT NULL,
  place_lo      integer,
  place_hi      integer,
  PRIMARY KEY (tournament_id, player_id)
);
CREATE INDEX entries_player ON entries (player_id);

-- Матч: идущий (live) или сыгранный (done). Турнирный привязан к игре сетки (r, i).
CREATE TABLE matches (
  id             text PRIMARY KEY,
  tournament_id  text REFERENCES tournaments(id) ON DELETE CASCADE,
  r              integer,
  i              integer,
  status         text NOT NULL CHECK (status IN ('live', 'done')),
  mode           integer NOT NULL,
  ltw            integer NOT NULL,
  dbl            boolean NOT NULL,
  starter        integer NOT NULL DEFAULT 0,
  players        jsonb NOT NULL,                   -- [{ id, name }]
  legs           jsonb NOT NULL,                   -- выигранные леги по игрокам
  w              integer,                          -- индекс победителя
  quick          boolean NOT NULL DEFAULT false,   -- счёт внесён без бросков
  last_seq       integer NOT NULL DEFAULT 0,
  version        integer NOT NULL DEFAULT 1,
  lock_device    text,
  lock_player    text REFERENCES players(id) ON DELETE SET NULL,
  lock_until     bigint,
  created_by     text REFERENCES players(id) ON DELETE SET NULL,
  started        bigint NOT NULL,
  finished       bigint,
  CHECK ((tournament_id IS NULL) = (r IS NULL) AND (r IS NULL) = (i IS NULL))
);
CREATE UNIQUE INDEX matches_game ON matches (tournament_id, r, i) WHERE tournament_id IS NOT NULL;
CREATE INDEX matches_done ON matches (finished DESC) WHERE status = 'done';

-- События счётчика: visit, undo, finish, reopen.
CREATE TABLE match_events (
  match_id  text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq       integer NOT NULL,
  ver       integer NOT NULL,                      -- версия матча после события
  type      text NOT NULL CHECK (type IN ('visit', 'undo', 'finish', 'reopen')),
  data      jsonb NOT NULL,
  t         bigint NOT NULL,
  PRIMARY KEY (match_id, seq)
);
CREATE INDEX match_events_ver ON match_events (match_id, ver);

-- Итоговая строка игрока в сыгранном матче (Line на странице).
CREATE TABLE match_lines (
  match_id   text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  player_id  text REFERENCES players(id) ON DELETE SET NULL,
  name       text NOT NULL,
  legs       integer NOT NULL,
  pts        integer NOT NULL,
  darts      integer NOT NULL,
  f9         double precision,
  hi         integer NOT NULL DEFAULT 0,
  hco        integer NOT NULL DEFAULT 0,
  c180       integer NOT NULL DEFAULT 0,
  c140       integer NOT NULL DEFAULT 0,
  c100       integer NOT NULL DEFAULT 0,
  coh        integer NOT NULL DEFAULT 0,
  coa        integer NOT NULL DEFAULT 0,
  bl         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, idx)
);
CREATE INDEX match_lines_player ON match_lines (player_id);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,                    -- sha256 токена из cookie
  player_id   text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  device_id   text,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL
);
CREATE INDEX sessions_player ON sessions (player_id);
