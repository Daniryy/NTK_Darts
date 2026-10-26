-- Роли в базе: тех. администратор добавляет свои (например, для тарифов). Тарифы: цена, срок, роль, которую дают.
-- Подключение тарифа: игрок оставляет заявку, администратор подключает на срок; по окончании роль снимается сама.
-- Скидка за подтверждённое звание — settings.discounts.

-- rank: 0 игрок, 1 — роли игроков и ведущих (свои роли тоже 1), 2 администратор, 3 тех. администратор
CREATE TABLE roles (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  rank        integer NOT NULL CHECK (rank BETWEEN 0 AND 3),
  builtin     boolean NOT NULL DEFAULT false,
  created_at  bigint NOT NULL
);
INSERT INTO roles (key, name, rank, builtin, created_at) VALUES
  ('player', 'Игрок', 0, true, 0), ('host', 'Ведущий', 1, true, 0), ('admin', 'Администратор', 2, true, 0), ('tech', 'Тех. администратор', 3, true, 0);
ALTER TABLE players DROP CONSTRAINT players_role_check;
ALTER TABLE players ADD CONSTRAINT players_role_fk FOREIGN KEY (role) REFERENCES roles(key);

CREATE SEQUENCE plan_seq;
CREATE TABLE plans (
  id          text PRIMARY KEY DEFAULT 'pl' || nextval('plan_seq'),
  name        text NOT NULL,
  price       integer NOT NULL CHECK (price BETWEEN 0 AND 1000000),  -- рублей за срок
  days        integer NOT NULL CHECK (days BETWEEN 1 AND 3660),
  role        text NOT NULL REFERENCES roles(key),
  about       text NOT NULL DEFAULT '',                              -- что даёт, по строке на пункт
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  bigint NOT NULL
);

-- подключения: requested — заявка игрока, active — действует до ends, ended — срок вышел или завершили,
-- rejected / cancelled — отказ администратора или игрок отозвал. price — цена со скидкой на момент подключения
CREATE TABLE player_plans (
  id          bigserial PRIMARY KEY,
  player_id   text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  plan_id     text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('requested', 'active', 'ended', 'rejected', 'cancelled')),
  price       integer NOT NULL DEFAULT 0,
  discount    integer NOT NULL DEFAULT 0,
  starts      bigint,
  ends        bigint,
  note        text NOT NULL DEFAULT '',
  granted_by  text REFERENCES players(id) ON DELETE SET NULL,
  created_at  bigint NOT NULL
);
CREATE UNIQUE INDEX player_plans_req ON player_plans (player_id) WHERE status = 'requested';
CREATE INDEX player_plans_active ON player_plans (ends) WHERE status = 'active';
CREATE INDEX player_plans_player ON player_plans (player_id, created_at DESC);

-- свои роли тарифов и сами тарифы для начала (цены и состав меняются в админке)
INSERT INTO roles (key, name, rank, builtin, created_at) VALUES ('plus', 'Игрок+', 1, false, 0);
INSERT INTO plans (name, price, days, role, about, sort, created_at) VALUES
  ('Игрок+', 249, 30, 'plus', 'Значок «Игрок+» в профиле и на табло' || chr(10) || 'Расширенная статистика (скоро)', 1, 0),
  ('Ведущий', 799, 30, 'host', 'Турниры от имени клуба' || chr(10) || 'Камеры и трансляции' || chr(10) || 'Свои номера игроков' || chr(10) || 'Аккаунты для игроков по коду', 2, 0);
-- скидка за подтверждённое звание, %: МС и выше, КМС, 1 разряд
INSERT INTO settings (key, value, updated_at) VALUES ('discounts', '{"ms": 25, "kms": 10, "r1": 5}', 0) ON CONFLICT (key) DO NOTHING;
