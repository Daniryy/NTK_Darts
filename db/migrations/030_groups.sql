-- Групповой этап («Стандарт», «Лига», «Комплексный»): { "n": групп, "adv": выходит из группы, "ids": [[…], …] — состав
-- после жеребьёвки, "done": групповой этап закрыт }. Пока идёт stage = 'groups' — турнир как круговой; после закрытия
-- матчи групп уходят в r + 64 (их место в сетке занимает плей-офф), сетка строится из вышедших.
ALTER TABLE tournaments ADD COLUMN groups jsonb;
ALTER TABLE tournaments DROP CONSTRAINT tournaments_stage_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_stage_check CHECK (stage IN ('qual', 'groups'));
