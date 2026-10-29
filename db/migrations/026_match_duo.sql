-- «каждый за себя»: оба игрока нажали «Готов» на своих телефонах — каждый вносит свои подходы со своего телефона
ALTER TABLE matches ADD COLUMN duo boolean NOT NULL DEFAULT false;
