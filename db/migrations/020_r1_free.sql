-- 1 разряд — без скидки (таких игроков много); скидки остаются у ЗМС, МСМК, МС и КМС
UPDATE settings SET value = jsonb_set(value, '{r1}', '0') WHERE key = 'discounts';
