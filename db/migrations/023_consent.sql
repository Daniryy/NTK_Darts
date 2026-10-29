-- согласие на обработку персональных данных: когда игрок его дал (регистрация, первый вход)
ALTER TABLE players ADD COLUMN consent_at bigint;
