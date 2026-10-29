-- «Готов»: игроки готовой игры сетки отмечаются у мишени; когда готовы оба, матч начинается сам.
-- ready — { "r:i": { "id игрока": время } }
ALTER TABLE tournaments ADD COLUMN ready jsonb;
