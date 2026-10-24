-- Роли, клубы, вход по телефону, номера ведущего, баннеры.

-- role: player — игрок; host — ведущий (клуб зарегистрирован официально: турниры от клуба, камеры,
-- свои номера игроков, аккаунты для тех, кто не может войти сам); admin — администратор (заказчик:
-- игроки, клубы, ведущие, любые турниры); tech — тех. администратор (разработчики: роли, баннеры).
ALTER TABLE players ADD COLUMN role text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'host', 'admin', 'tech'));
UPDATE players SET role = 'tech' WHERE admin;
ALTER TABLE players DROP COLUMN admin;
-- phone — для входа по SMS (+79991234567); blocked — не может войти и писать
ALTER TABLE players
  ADD COLUMN phone text UNIQUE,
  ADD COLUMN blocked boolean NOT NULL DEFAULT false;

-- Клубы: игрок подаёт заявку, администратор подтверждает — подавший становится ведущим клуба.
CREATE SEQUENCE club_seq;
CREATE TABLE clubs (
  id          text PRIMARY KEY DEFAULT 'c' || nextval('club_seq'),
  name        text NOT NULL,
  city        text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  contact     text NOT NULL DEFAULT '',            -- телефон или ссылка для связи
  about       text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'closed')),
  owner_id    text REFERENCES players(id) ON DELETE SET NULL, -- кто подал заявку
  note        text NOT NULL DEFAULT '',            -- ответ администратора (причина отказа)
  decided_by  text REFERENCES players(id) ON DELETE SET NULL,
  decided_at  bigint,
  created_at  bigint NOT NULL
);
CREATE UNIQUE INDEX clubs_name ON clubs (lower(name)) WHERE status IN ('pending', 'active');
CREATE INDEX clubs_status ON clubs (status, created_at DESC);

-- ведущие клуба
CREATE TABLE club_hosts (
  club_id    text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id  text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (club_id, player_id)
);
CREATE INDEX club_hosts_player ON club_hosts (player_id);

-- турнир от имени клуба
ALTER TABLE tournaments ADD COLUMN club_id text REFERENCES clubs(id) ON DELETE SET NULL;

-- Номера игроков у ведущего: свой список «номер → игрок», чтобы быстро набирать участников.
CREATE TABLE host_nums (
  host_id    text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  n          integer NOT NULL CHECK (n BETWEEN 1 AND 9999),
  player_id  text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (host_id, n),
  UNIQUE (host_id, player_id)
);

-- Коды входа по SMS: один действующий код на номер. Хранится хэш кода.
CREATE TABLE phone_codes (
  phone       text PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  bigint NOT NULL,
  tries       integer NOT NULL DEFAULT 0,
  sent_at     bigint NOT NULL
);
-- отправленные SMS: ограничения по номеру и за сутки
CREATE TABLE sms_log (
  phone      text NOT NULL,
  device_id  text,
  t          bigint NOT NULL
);
CREATE INDEX sms_log_t ON sms_log (t);
CREATE INDEX sms_log_phone ON sms_log (phone, t);

-- Баннеры (тех. администратор): place — где показывать.
CREATE SEQUENCE banner_seq;
CREATE TABLE banners (
  id          text PRIMARY KEY DEFAULT 'b' || nextval('banner_seq'),
  place       text NOT NULL CHECK (place IN ('feed', 'tour', 'tv')),
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  image       text,                                -- /uploads/… или https://…
  link        text,
  active      boolean NOT NULL DEFAULT true,
  starts      bigint,
  ends        bigint,
  clicks      integer NOT NULL DEFAULT 0,
  created_by  text REFERENCES players(id) ON DELETE SET NULL,
  created_at  bigint NOT NULL
);
CREATE INDEX banners_place ON banners (place) WHERE active;

-- картинки баннеров — те же загруженные фото
ALTER TABLE photos DROP CONSTRAINT photos_kind_check;
ALTER TABLE photos ADD CONSTRAINT photos_kind_check CHECK (kind IN ('avatar', 'tour', 'banner'));
