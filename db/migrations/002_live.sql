-- Живой счёт для табло: текущее состояние матча и уведомления после каждой записи.
-- pg_notify доставляется только после COMMIT, поэтому табло не видит отменённых изменений.

ALTER TABLE matches ADD COLUMN state jsonb; -- { leg, cur, scores, last }

CREATE FUNCTION oche_notify_tour() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('oche_tour', json_build_object('tid', OLD.id, 'deleted', true)::text);
  ELSIF OLD.version IS DISTINCT FROM NEW.version THEN
    PERFORM pg_notify('oche_tour', json_build_object('tid', NEW.id, 'v', NEW.version)::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tournaments_notify AFTER UPDATE OR DELETE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION oche_notify_tour();

CREATE FUNCTION oche_notify_match() RETURNS trigger AS $$
DECLARE r matches;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF r.tournament_id IS NOT NULL THEN
    PERFORM pg_notify('oche_match', json_build_object('tid', r.tournament_id, 'id', r.id, 'deleted', TG_OP = 'DELETE')::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER matches_notify AFTER INSERT OR UPDATE OR DELETE ON matches
  FOR EACH ROW EXECUTE FUNCTION oche_notify_match();
