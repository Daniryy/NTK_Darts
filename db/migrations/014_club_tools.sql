-- Тариф «Ведущий»: логотип и спонсоры клуба на табло, помощники, взносы.
ALTER TABLE clubs ADD COLUMN logo text;                       -- /uploads/…
-- помощники клуба: ведут счёт и ставят мишени в турнирах клуба, но не управляют ими
CREATE TABLE club_helpers (
  club_id     text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id   text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  added_by    text REFERENCES players(id) ON DELETE SET NULL,
  created_at  bigint NOT NULL,
  PRIMARY KEY (club_id, player_id)
);
CREATE INDEX club_helpers_player ON club_helpers (player_id);
-- баннеры клуба (спонсоры): показываются на его турнирах вместо баннеров Oche
ALTER TABLE banners ADD COLUMN club_id text REFERENCES clubs(id) ON DELETE CASCADE;
CREATE INDEX banners_club ON banners (club_id) WHERE club_id IS NOT NULL;
-- логотип клуба — тоже загруженная картинка
ALTER TABLE photos DROP CONSTRAINT photos_kind_check;
ALTER TABLE photos ADD CONSTRAINT photos_kind_check CHECK (kind IN ('avatar', 'tour', 'banner', 'club'));
-- взнос за участие и отметка «оплатил»
ALTER TABLE tournaments ADD COLUMN fee integer CHECK (fee BETWEEN 0 AND 100000);
ALTER TABLE entries ADD COLUMN paid boolean NOT NULL DEFAULT false;
-- что даёт тариф «Ведущий» — с новыми инструментами клуба
UPDATE plans SET about = 'Всё из Pro' || chr(10) || 'Турниры от имени клуба, страница клуба с расписанием' || chr(10) ||
  'Логотип и свои спонсоры на табло вместо рекламы Oche' || chr(10) || 'Помощники для ведения счёта' || chr(10) ||
  'Взносы и касса турнира' || chr(10) || 'Статистика клуба: кто ходит, кто пропал' || chr(10) || 'Камеры, свои номера игроков, аккаунты по коду'
WHERE role = 'host' AND name = 'Ведущий' AND about LIKE 'Всё из Pro%';
