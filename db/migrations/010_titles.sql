-- Спортивные звания и разряды — только через заявку с документом: подача → автоматическая проверка →
-- ручная проверка администратором → подтверждено. Самому вписать звание в профиль больше нельзя.

-- документы заявок: лежат в закрытой папке (PRIVATE_DIR), отдаются только через API владельцу и администратору
CREATE TABLE title_docs (
  id          text PRIMARY KEY,
  player_id   text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id  text,
  file        text NOT NULL UNIQUE,
  mime        text NOT NULL,
  bytes       integer NOT NULL,
  created_at  bigint NOT NULL
);
CREATE INDEX title_docs_player ON title_docs (player_id, created_at);

CREATE SEQUENCE title_req_seq;
-- status: review — автопроверка пройдена, ждёт администратора; approved — подтверждено; rejected — отклонено;
-- cancelled — игрок отозвал. auto — результаты автопроверки [{ k, st: ok|warn|info, text }]
CREATE TABLE title_requests (
  id          text PRIMARY KEY DEFAULT 'r' || nextval('title_req_seq'),
  player_id   text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  title       text NOT NULL,
  sport       text NOT NULL DEFAULT 'дартс',
  order_no    text NOT NULL DEFAULT '',
  order_date  bigint,
  issuer      text NOT NULL DEFAULT '',
  comment     text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('review', 'approved', 'rejected', 'cancelled')),
  auto        jsonb NOT NULL DEFAULT '[]',
  auto_at     bigint,
  note        text NOT NULL DEFAULT '',
  decided_by  text REFERENCES players(id) ON DELETE SET NULL,
  decided_at  bigint,
  created_at  bigint NOT NULL
);
CREATE UNIQUE INDEX title_req_open ON title_requests (player_id) WHERE status = 'review';
CREATE INDEX title_req_status ON title_requests (status, created_at DESC);
ALTER TABLE title_docs ADD CONSTRAINT title_docs_req FOREIGN KEY (request_id) REFERENCES title_requests(id) ON DELETE SET NULL;

-- подтверждённое звание игрока; вписанные самостоятельно звания больше не показываем
ALTER TABLE players ADD COLUMN title_req text REFERENCES title_requests(id) ON DELETE SET NULL;
UPDATE players SET title = '';
