-- До скольких побед по стадиям сетки: { "f": 5, "sf": 3, "qf": 2, "early": 1, "places": 1 } — ставит ведущий;
-- стадии без значения — общее ltw. Сильным сеткам — больше легов: общее до 11.
ALTER TABLE tournaments ADD COLUMN ltw_by jsonb;
ALTER TABLE tournaments DROP CONSTRAINT tournaments_ltw_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_ltw_check CHECK (ltw BETWEEN 1 AND 11);
