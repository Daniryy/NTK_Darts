-- Фото игроков и итогов турнира, ссылки к итогам, разряд игрока, аккаунты от администратора.

-- photo — адрес аватара (/uploads/…), title — разряд или звание, claim — код привязки аккаунта,
-- созданного администратором: игрок входит через VK и вводит код, аккаунт становится его.
ALTER TABLE players
  ADD COLUMN photo text,
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN claim text UNIQUE;

-- Ссылки к итогам турнира: [{ "title": "Трансляция", "url": "https://…" }]
ALTER TABLE tournaments ADD COLUMN links jsonb;

-- Загруженные фото. Файл лежит в UPLOAD_DIR под именем file, отдаётся по /uploads/file.
CREATE TABLE photos (
  id            text PRIMARY KEY,
  file          text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('avatar', 'tour')),
  owner_id      text REFERENCES players(id) ON DELETE SET NULL,   -- кто загрузил
  player_id     text REFERENCES players(id) ON DELETE CASCADE,    -- чей аватар
  tournament_id text REFERENCES tournaments(id) ON DELETE CASCADE,
  w             integer NOT NULL,
  h             integer NOT NULL,
  bytes         integer NOT NULL,
  created_at    bigint NOT NULL,
  CHECK ((kind = 'avatar') = (player_id IS NOT NULL) AND (kind = 'tour') = (tournament_id IS NOT NULL))
);
CREATE INDEX photos_tour ON photos (tournament_id, created_at) WHERE tournament_id IS NOT NULL;
CREATE INDEX photos_player ON photos (player_id) WHERE player_id IS NOT NULL;
