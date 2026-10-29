-- Лайт-профиль: аккаунт, который завёл ведущий или игрок (гость), без своего способа входа — ни VK, ни телефона,
-- ни почты, ни логина. Играет по QR-карточке, в общий рейтинг не входит. Привязал вход — профиль полный, матчи при нём.
ALTER TABLE players ADD COLUMN lite boolean GENERATED ALWAYS AS
  (owner_id IS NOT NULL AND vk_id IS NULL AND phone IS NULL AND email IS NULL AND login IS NULL AND pass_hash IS NULL) STORED;

-- QR-карточка лайт-профиля многоразовая; как только у профиля появился свой вход — карточка перестаёт работать
-- (если в том же изменении не выдан новый код)
CREATE FUNCTION players_lite_claim() RETURNS trigger AS $$
BEGIN
  IF OLD.owner_id IS NOT NULL AND OLD.vk_id IS NULL AND OLD.phone IS NULL AND OLD.email IS NULL AND OLD.login IS NULL AND OLD.pass_hash IS NULL
    AND (NEW.vk_id IS NOT NULL OR NEW.phone IS NOT NULL OR NEW.email IS NOT NULL OR NEW.login IS NOT NULL OR NEW.pass_hash IS NOT NULL)
    AND NEW.claim IS NOT DISTINCT FROM OLD.claim THEN
    NEW.claim := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER players_lite_claim BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION players_lite_claim();
