-- «Кубок B»: не вышедшие из групп играют свой турнир; parent — основной турнир (у него в groups.cupB — id кубка)
ALTER TABLE tournaments ADD COLUMN parent text REFERENCES tournaments(id) ON DELETE SET NULL;
