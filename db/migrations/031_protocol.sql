-- Протокол результатов: фамилия, имя, отчество отдельно от имени в профиле, год рождения, пол, субъект РФ
-- (пусто — по городу), заметки ведущего; у турнира — шапка протокола и выполненные разряды
-- { "league": "Лига …", "tour": "1 тур", "about": "о клубе", "done": { "p5": "КМС" } }
ALTER TABLE players
  ADD COLUMN last_name text NOT NULL DEFAULT '',
  ADD COLUMN first_name text NOT NULL DEFAULT '',
  ADD COLUMN mid_name text NOT NULL DEFAULT '',
  ADD COLUMN birth_year integer CHECK (birth_year BETWEEN 1900 AND 2100),
  ADD COLUMN sex text CHECK (sex IN ('m', 'f')),
  ADD COLUMN region text NOT NULL DEFAULT '',
  ADD COLUMN note text NOT NULL DEFAULT '';
ALTER TABLE tournaments ADD COLUMN proto jsonb;
