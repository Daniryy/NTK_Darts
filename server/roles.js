// Роли по старшинству: игрок < ведущий < администратор < тех. администратор.
// Права: у каждого права роли по умолчанию; тех. администратор меняет, каким ролям оно доступно (settings.perms).
// Тех. администратору доступно всё. Роли администратора и тех. администратора и сами права меняет только он —
// это не настраивается, иначе роль могла бы выдать права выше себя.
const RANK = { player: 0, host: 1, admin: 2, tech: 3 };
const ROLES = Object.keys(RANK);
const ROLE_NAME = { player: 'игрок', host: 'ведущий', admin: 'администратор', tech: 'тех. администратор' };
const atLeast = (p, role) => !!p && !p.blocked && RANK[p.role] >= RANK[role];

// [ключ, роль по умолчанию, что разрешает]
const PERMS = [
  ['club_tour', 'host', 'Турниры от имени своего клуба (официальные)'],
  ['streams', 'host', 'Камеры (трансляции) в своих турнирах'],
  ['accounts', 'host', 'Заводить аккаунты с кодом входа'],
  ['host_nums', 'host', 'Свои номера игроков'],
  ['players', 'admin', 'Править любых игроков, подтверждать, выдавать коды'],
  ['block', 'admin', 'Блокировать игроков'],
  ['give_host', 'admin', 'Выдавать и снимать роль ведущего'],
  ['clubs', 'admin', 'Подтверждать клубы и назначать ведущих'],
  ['any_tour', 'admin', 'Управлять любыми турнирами и матчами'],
  ['official', 'admin', 'Официальный статус турниров'],
  ['stats', 'admin', 'Сводка'],
  ['audit', 'admin', 'Журнал действий'],
  ['banners', 'tech', 'Баннеры']
];
const PERM = Object.fromEntries(PERMS.map(([k, min, name]) => [k, { min, name }]));
// роли, которым право можно дать в настройках (тех. администратору доступно всё и так)
const GRANTABLE = ['player', 'host', 'admin'];
const byDefault = k => GRANTABLE.filter(r => RANK[r] >= RANK[PERM[k].min]);

let custom = {};
// настройки из базы: { ключ: [роли] }; неизвестное отбрасывается
function setPerms(v) {
  const out = {};
  if (v && typeof v === 'object') for (const k of Object.keys(PERM)) if (Array.isArray(v[k])) out[k] = GRANTABLE.filter(r => v[k].includes(r));
  custom = out;
  return out;
}
const rolesOf = k => custom[k] || byDefault(k);
const can = (p, k) => !!p && !p.blocked && !!PERM[k] && (p.role === 'tech' || rolesOf(k).includes(p.role));
const permsOf = p => Object.keys(PERM).filter(k => can(p, k));
// таблица для панели: [{ key, name, min, roles }]
const permTable = () => PERMS.map(([key, min, name]) => ({ key, name, min, roles: rolesOf(key) }));
// старое «администратор или выше» — для мест, где права не делятся
const isAdmin = p => atLeast(p, 'admin');

module.exports = { RANK, ROLES, ROLE_NAME, PERM, GRANTABLE, atLeast, isAdmin, can, permsOf, permTable, setPerms };
