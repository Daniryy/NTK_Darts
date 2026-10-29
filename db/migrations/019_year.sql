-- Оплата за год и скидка за каждое звание отдельно.
-- year_price — цена за год (null — только помесячно); заявка и подключение помнят, на год ли (year).
ALTER TABLE plans ADD COLUMN year_price integer CHECK (year_price BETWEEN 0 AND 10000000);
UPDATE plans SET year_price = 2490 WHERE role = 'plus' AND price = 249;
UPDATE plans SET year_price = 7990 WHERE role = 'host' AND price = 799;
ALTER TABLE player_plans ADD COLUMN year boolean NOT NULL DEFAULT false;
-- ЗМС −90%, МСМК −70%, МС −40%, КМС −10%, 1 разряд −5%
INSERT INTO settings (key, value, updated_at) VALUES ('discounts', '{"zms": 90, "msmk": 70, "ms": 40, "kms": 10, "r1": 5}', 0)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = 0;
