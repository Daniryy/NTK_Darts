-- Заявок на подтверждение звания больше нет: звание игроку вписывает администратор в карточке.
ALTER TABLE players DROP COLUMN IF EXISTS title_req;
DROP TABLE IF EXISTS title_docs;
DROP TABLE IF EXISTS title_requests;
