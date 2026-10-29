-- двухфакторный вход администраторов: секрет приложения-генератора кодов (зашифрован), последний принятый шаг, резервные коды (хэши)
ALTER TABLE players ADD COLUMN totp_secret text, ADD COLUMN totp_on boolean NOT NULL DEFAULT false, ADD COLUMN totp_last bigint,
  ADD COLUMN totp_backup jsonb NOT NULL DEFAULT '[]';
