-- Вход по почте и паролю: регистрация с кодом из письма, привязка почты к аккаунту, новый пароль по письму.
-- email — в нижнем регистре; email_ok — адрес подтверждён кодом из письма.
ALTER TABLE players ADD COLUMN email text, ADD COLUMN email_ok boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX players_email ON players (email) WHERE email IS NOT NULL;

-- коды из писем: reg — регистрация (data: имя, город, хэш пароля), link — привязать почту, reset — новый пароль
CREATE TABLE email_codes (
  email       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('reg', 'link', 'reset')),
  code_hash   text NOT NULL,
  expires_at  bigint NOT NULL,
  tries       integer NOT NULL DEFAULT 0,
  sent_at     bigint NOT NULL,
  player_id   text REFERENCES players(id) ON DELETE CASCADE,
  data        jsonb,
  PRIMARY KEY (email, purpose)
);
-- отправленные письма: лимиты на адрес, устройство и сервер
CREATE TABLE mail_log (
  email      text NOT NULL,
  device_id  text,
  t          bigint NOT NULL
);
CREATE INDEX mail_log_email ON mail_log (email, t);
CREATE INDEX mail_log_t ON mail_log (t);
