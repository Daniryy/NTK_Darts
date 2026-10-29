-- Судьи турнира: { "chief": { "name", "city" } | null, "pool": ["Иванов И.", …], "at": { "r:i": "Иванов И." } } —
-- главный судья (для протокола), судьи турнира и кто судит каждый матч сетки
ALTER TABLE tournaments ADD COLUMN refs jsonb;
