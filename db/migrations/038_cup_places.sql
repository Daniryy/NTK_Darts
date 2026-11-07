-- «Кубок B»: места сквозные — к местам в кубке прибавляется число игроков основной сетки
ALTER TABLE tournaments ADD COLUMN place_off integer NOT NULL DEFAULT 0 CHECK (place_off >= 0);
