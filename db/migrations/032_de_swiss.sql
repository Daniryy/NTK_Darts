-- Двойное выбывание (de) и швейцарская система (sw, rounds — сколько туров)
ALTER TABLE tournaments DROP CONSTRAINT tournaments_format_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_format_check CHECK (format IN ('pl', 'ko', 'rr', 'de', 'sw'));
ALTER TABLE tournaments ADD COLUMN rounds integer CHECK (rounds BETWEEN 1 AND 15);
