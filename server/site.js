// Настройки сайта (settings.site, меняет тех. администратор в панели):
//   signup — регистрация открыта: почта, телефон и VK создают новые аккаунты;
//   selfEdit — игрок сам правит профиль, фото и способы входа; selfPass — сам меняет пароль.
// По умолчанию всё закрыто: аккаунты, логины и данные игроков ведут администратор и ведущие клуба.
// SITE_OPEN=1 — по умолчанию открыто (разработка, тесты).
const { E } = require('./errors');
const { RANK } = require('./roles');

const KEYS = ['signup', 'selfEdit', 'selfPass'];
const base = () => Object.fromEntries(KEYS.map(k => [k, process.env.SITE_OPEN === '1']));
let cur = base();
function setSite(v) {
  const o = base();
  if (v && typeof v === 'object') for (const k of KEYS) if (typeof v[k] === 'boolean') o[k] = v[k];
  cur = o;
  return o;
}
const site = () => cur;
// обычный игрок: ведущих и администраторов настройки не ограничивают
const plain = p => !!p && (RANK[p.role] || 0) < RANK.host;
const needSignup = () => { if (!cur.signup) throw E.forbidden('Регистрация закрыта: аккаунт выдаёт администратор клуба'); };
const needSelfEdit = p => { if (!cur.selfEdit && plain(p)) throw E.forbidden('Профиль меняет администратор клуба'); };
const needSelfPass = p => { if (!cur.selfPass && plain(p)) throw E.forbidden('Пароль меняет администратор клуба'); };

module.exports = { KEYS, site, setSite, plain, needSignup, needSelfEdit, needSelfPass };
