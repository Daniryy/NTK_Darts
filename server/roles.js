// Роли по старшинству: игрок < ведущий < администратор < тех. администратор.
const RANK = { player: 0, host: 1, admin: 2, tech: 3 };
const ROLES = Object.keys(RANK);
const ROLE_NAME = { player: 'игрок', host: 'ведущий', admin: 'администратор', tech: 'тех. администратор' };
const atLeast = (p, role) => !!p && !p.blocked && RANK[p.role] >= RANK[role];
const isAdmin = p => atLeast(p, 'admin');

module.exports = { RANK, ROLES, ROLE_NAME, atLeast, isAdmin };
