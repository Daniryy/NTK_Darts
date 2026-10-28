-- Клуб больше не даёт роль ведущего: она — у тарифа «Ведущий» (или выдана вручную).
-- Ведущим, получившим роль только от клуба, возвращаем роль по тарифу или выданную вручную.
UPDATE players p SET role = COALESCE((
    SELECT pl.role FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id
    WHERE pp.player_id = p.id AND pp.status = 'active' AND pp.ends > (extract(epoch FROM now()) * 1000)::bigint
    ORDER BY pp.ends DESC LIMIT 1), p.base_role)
WHERE p.role = 'host' AND p.base_role <> 'host'
  AND NOT EXISTS (SELECT 1 FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id
                  WHERE pp.player_id = p.id AND pp.status = 'active' AND pp.ends > (extract(epoch FROM now()) * 1000)::bigint AND pl.role = 'host');
