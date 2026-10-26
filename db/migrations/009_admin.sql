-- Вход администраторов по логину и паролю, настройка прав ролей, журнал действий.

-- login — только у администраторов и тех. администраторов; pass_hash — scrypt с солью.
-- pass_fails и pass_lock_until — защита от подбора: после 5 неверных паролей вход по логину закрыт на 15 минут.
ALTER TABLE players
  ADD COLUMN login text UNIQUE,
  ADD COLUMN pass_hash text,
  ADD COLUMN pass_fails integer NOT NULL DEFAULT 0,
  ADD COLUMN pass_lock_until bigint;

-- настройки сервера: perms — у каких ролей какие права (меняет тех. администратор)
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  bigint NOT NULL,
  updated_by  text REFERENCES players(id) ON DELETE SET NULL
);

-- журнал действий администраторов и ведущих: кто, что, с кем
CREATE TABLE audit (
  id           bigserial PRIMARY KEY,
  t            bigint NOT NULL,
  actor_id     text REFERENCES players(id) ON DELETE SET NULL,
  actor_name   text NOT NULL DEFAULT '',
  action       text NOT NULL,
  target       text,
  target_name  text,
  data         jsonb
);
CREATE INDEX audit_t ON audit (t DESC);
CREATE INDEX audit_target ON audit (target, t DESC);
