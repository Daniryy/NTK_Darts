-- Без тарифов и рекламы: сайт у клуба целиком — тарифы, промокоды, Pro и баннеры (в том числе спонсоры клубов) убраны.
-- Возможности клуба и статистика игроков доступны по ролям, без оплаты.
DROP TABLE IF EXISTS player_plans, promo_codes, plans, banners CASCADE;
DELETE FROM photos WHERE kind = 'banner';
DELETE FROM settings WHERE key IN ('discounts', 'sale');
-- роль тарифа Pro больше не нужна
UPDATE players SET role = 'player' WHERE role = 'plus';
UPDATE players SET base_role = 'player' WHERE base_role = 'plus';
DELETE FROM roles WHERE key = 'plus';
