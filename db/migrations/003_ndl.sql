-- Упражнения, квалификация и сетки частями (формат NDL), мишени и номера игроков.

-- Турнир: упражнение матчей (null — x01 по mode и dbl), квалификация { ex, tries },
-- размер части сетки split (сетка строится частями по split мест), block — фактический размер части у построенной сетки,
-- stage = 'qual' пока идёт квалификация, мишени { n, at: { 'r:i': номер } }, номера игроков { id: номер }.
ALTER TABLE tournaments
  ADD COLUMN ex jsonb,
  ADD COLUMN qual jsonb,
  ADD COLUMN split integer CHECK (split IN (4, 8, 16, 32)),
  ADD COLUMN block integer,
  ADD COLUMN stage text CHECK (stage IN ('qual')),
  ADD COLUMN boards jsonb,
  ADD COLUMN nums jsonb;

-- Матч: упражнение (null — x01) и попытка квалификации (игрок, номер попытки с 0).
-- Попытка квалификации — матч турнира без игры сетки (r и i пустые).
ALTER TABLE matches
  ADD COLUMN ex jsonb,
  ADD COLUMN q_player text REFERENCES players(id) ON DELETE CASCADE,
  ADD COLUMN q_try integer;
ALTER TABLE matches DROP CONSTRAINT matches_check;
ALTER TABLE matches ADD CONSTRAINT matches_check CHECK (
  (r IS NULL) = (i IS NULL)
  AND (q_player IS NULL) = (q_try IS NULL)
  AND (tournament_id IS NOT NULL OR (r IS NULL AND q_player IS NULL))
  AND (q_player IS NULL OR r IS NULL)
  AND (tournament_id IS NULL OR r IS NOT NULL OR q_player IS NOT NULL)
);
CREATE UNIQUE INDEX matches_qual ON matches (tournament_id, q_player, q_try) WHERE q_player IS NOT NULL;

-- Бросок в булл при ничьей в леге (лег без закрытия): событие bull { leg, p } — p выиграл лег
ALTER TABLE match_events DROP CONSTRAINT match_events_type_check;
ALTER TABLE match_events ADD CONSTRAINT match_events_type_check CHECK (type IN ('visit', 'undo', 'finish', 'reopen', 'bull'));

-- Итоги легов упражнения у строки матча: [845, 790]
ALTER TABLE match_lines ADD COLUMN sc jsonb;

-- Результаты квалификации: из счётчика (match_id) или внесённые организатором.
CREATE TABLE qual_results (
  tournament_id text NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  try           integer NOT NULL CHECK (try >= 0 AND try < 5),
  v             integer NOT NULL CHECK (v >= 0),
  match_id      text REFERENCES matches(id) ON DELETE CASCADE,
  t             bigint NOT NULL,
  PRIMARY KEY (tournament_id, player_id, try)
);

-- попытки квалификации тоже идут в табло турнира: триггер уведомлений уже срабатывает на любой матч с tournament_id
