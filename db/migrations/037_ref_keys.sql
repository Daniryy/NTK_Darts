-- Судья по QR конкретного матча: организатор выдаёт ключ на игру сетки (хранится только хэш).
-- Судья открывает счётчик без аккаунта и вводит имя; ключ действует, пока у игры та же пара и нет результата.
CREATE TABLE ref_keys (
  tournament_id text NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  r             integer NOT NULL,
  i             integer NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  pa            text NOT NULL,
  pb            text NOT NULL,
  created_at    bigint NOT NULL,
  created_by    text REFERENCES players(id) ON DELETE SET NULL,
  PRIMARY KEY (tournament_id, r, i)
);
-- кто ведёт счёт по QR судьи (у такого судьи нет аккаунта)
ALTER TABLE matches ADD COLUMN lock_ref text;
