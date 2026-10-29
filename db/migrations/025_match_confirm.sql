-- подтверждение дружеского матча игроком: матч, который завёл другой аккаунт, идёт в статистику игрока, только если он подтвердил
-- (true — «да, я играл», false — «это не я»; null — ещё не ответил)
ALTER TABLE match_lines ADD COLUMN confirmed boolean;
CREATE INDEX match_lines_pending ON match_lines (player_id) WHERE confirmed IS NULL AND player_id IS NOT NULL;
