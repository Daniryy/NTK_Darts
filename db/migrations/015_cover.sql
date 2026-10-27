-- Общее фото игроков в конце турнира: показывается на странице итогов и в ленте.
ALTER TABLE tournaments ADD COLUMN cover text REFERENCES photos(id) ON DELETE SET NULL;
