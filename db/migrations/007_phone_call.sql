-- Вход звонком-сбросом: код из 4 цифр (последние цифры номера, с которого звонят), у SMS — 6.
ALTER TABLE phone_codes ADD COLUMN digits integer NOT NULL DEFAULT 6;
