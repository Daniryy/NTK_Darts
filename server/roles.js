// Роли: игрок (0), роли игроков и ведущих (1, в том числе свои — их добавляет тех. администратор, например для тарифов),
// администратор (2), тех. администратор (3). Список ролей — в базе (таблица roles), здесь его копия.
// Права: у каждого права роли по умолчанию; тех. администратор меняет, каким ролям оно доступно (settings.perms).
// Тех. администратору доступно всё. Роли администратора и тех. администратора и сами права меняет только он —
// это не настраивается, иначе роль могла бы выдать права выше себя.
const RANK = { player: 0, host: 1, admin: 2, tech: 3 };
const ROLE_NAME = { player: 'игрок', host: 'ведущий', admin: 'администратор', tech: 'тех. администратор' };
// ROLES и RANK меняются на месте при загрузке из базы: модули держат ссылки на них
const ROLES = Object.keys(RANK);
const atLeast = (p, role) => !!p && !p.blocked && (RANK[p.role] || 0) >= RANK[role];

// [ключ, роль по умолчанию, что разрешает, свои роли, которым право дано по умолчанию]
const PERMS = [
  ['create_tour', 'player', 'Создавать свои турниры'],
  ['pro', 'host', 'Pro: расширенная статистика, личные встречи, выходная музыка, без рекламы', ['plus']],
  ['club_tour', 'host', 'Турниры от имени своего клуба (официальные)'],
  ['club_tools', 'host', 'Клуб: логотип и спонсоры на табло, помощники, взносы, статистика клуба'],
  ['streams', 'host', 'Камеры (трансляции) в своих турнирах'],
  ['accounts', 'host', 'Заводить аккаунты с кодом входа'],
  ['host_nums', 'host', 'Свои номера игроков'],
  ['players', 'admin', 'Править любых игроков, подтверждать, выдавать коды'],
  ['contacts', 'admin', 'Видеть телефон и почту игроков (кроме своих аккаунтов)'],
  ['block', 'admin', 'Блокировать игроков'],
  ['give_host', 'admin', 'Выдавать роли игроков (ведущий, роли тарифов)'],
  ['clubs', 'admin', 'Подтверждать клубы и назначать ведущих'],
  ['any_tour', 'admin', 'Управлять любыми турнирами и матчами'],
  ['official', 'admin', 'Официальный статус турниров'],
  ['plans', 'admin', 'Тарифы: подключать, продлевать, завершать игрокам'],
  ['stats', 'admin', 'Сводка'],
  ['titles', 'admin', 'Подтверждать и снимать звания'],
  ['audit', 'admin', 'Журнал действий'],
  ['banners', 'tech', 'Баннеры'],
  ['plans_edit', 'tech', 'Тарифы: цены и состав, скидки за звание'],
  ['delete_players', 'tech', 'Удалять аккаунты игроков'],
  ['cleanup', 'tech', 'Очистка сервера от демо-данных (все турниры и игроки без входа)']
];
const PERM = Object.fromEntries(PERMS.map(([k, min, name, extra]) => [k, { min, name, extra: extra || [] }]));
// роли, которым право можно дать в настройках (тех. администратору доступно всё и так)
const grantable = () => ROLES.filter(r => r !== 'tech');
// по умолчанию: роли не ниже нужной; свои роли (ранг 1) по умолчанию прав ведущего не получают
// право «для игроков» по умолчанию есть у всех ролей, в том числе своих (тарифы)
const byDefault = k => PERM[k].min === 'player' ? grantable() : grantable().filter(r => ((r in { player: 1, host: 1, admin: 1 }) && RANK[r] >= RANK[PERM[k].min]) || PERM[k].extra.includes(r));

let custom = {};
// настройки из базы: { ключ: [роли] }; неизвестное отбрасывается
function setPerms(v) {
  const out = {};
  if (v && typeof v === 'object') for (const k of Object.keys(PERM)) if (Array.isArray(v[k])) out[k] = grantable().filter(r => v[k].includes(r));
  custom = out;
  return out;
}
// роли из базы: [{ key, name, rank }]
function setRoles(rows) {
  ROLES.length = 0;
  Object.keys(RANK).forEach(k => delete RANK[k]);
  Object.keys(ROLE_NAME).forEach(k => delete ROLE_NAME[k]);
  rows.slice().sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1)).forEach(r => { ROLES.push(r.key); RANK[r.key] = r.rank; ROLE_NAME[r.key] = r.name.toLowerCase(); });
}
const rolesOf = k => custom[k] || byDefault(k);
const can = (p, k) => !!p && !p.blocked && !!PERM[k] && (p.role === 'tech' || rolesOf(k).includes(p.role));
const permsOf = p => Object.keys(PERM).filter(k => can(p, k));
// таблица для панели: [{ key, name, min, roles }]
const permTable = () => PERMS.map(([key, min, name, extra]) => ({ key, name, min, extra: extra || [], roles: rolesOf(key) }));
// старое «администратор или выше» — для мест, где права не делятся
const isAdmin = p => atLeast(p, 'admin');

module.exports = { RANK, ROLES, ROLE_NAME, PERM, atLeast, isAdmin, can, permsOf, permTable, setPerms, setRoles, grantable };
