-- Ручной рейтинг: администратор задаёт рейтинг для посева. Пересчёт Эло начинается не с 1500, а с этой основы.
ALTER TABLE players ADD COLUMN IF NOT EXISTS rating_base double precision NOT NULL DEFAULT 1500;
