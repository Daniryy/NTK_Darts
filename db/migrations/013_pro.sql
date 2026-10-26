-- Тариф Pro для игроков: выходная музыка (walk-on) на табло; роль plus теперь называется Pro.
ALTER TABLE players ADD COLUMN walkon text NOT NULL DEFAULT '';
UPDATE roles SET name = 'Pro' WHERE key = 'plus' AND name = 'Игрок+';
UPDATE plans SET name = 'Pro', about = 'Статистика Pro: форма по неделям, закрытия по остаткам, наборы, рекорды упражнений' || chr(10) ||
  'Личные встречи с любым соперником' || chr(10) || 'Сравнение с игроками своего уровня' || chr(10) || 'Выходная музыка на табло и значок PRO' || chr(10) ||
  'Выгрузка всех матчей в Excel' || chr(10) || 'Без рекламы'
WHERE role = 'plus' AND name = 'Игрок+';
UPDATE plans SET about = 'Всё из Pro' || chr(10) || about WHERE role = 'host' AND name = 'Ведущий' AND about NOT LIKE 'Всё из Pro%';
