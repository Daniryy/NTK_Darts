-- Роль, выданная вручную (администратором), отдельно от роли тарифа и клуба: когда тариф кончается
-- или клуб закрывают, игрок возвращается к ней, а не к «игроку».
ALTER TABLE players ADD COLUMN base_role text NOT NULL DEFAULT 'player' REFERENCES roles(key);
-- у кого роль не из тарифа и не из открытого клуба — она и была выдана вручную
UPDATE players p SET base_role = p.role
WHERE p.role NOT IN ('player', 'admin', 'tech')
  AND NOT EXISTS (SELECT 1 FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id
                  WHERE pp.player_id = p.id AND pp.status = 'active' AND pl.role = p.role)
  AND NOT EXISTS (SELECT 1 FROM club_hosts h JOIN clubs c ON c.id = h.club_id WHERE h.player_id = p.id AND c.status = 'active');
