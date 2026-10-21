class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const E = {
  bad: (message, fields) => new ApiError(400, 'bad_request', message, fields ? { fields: [].concat(fields) } : null),
  auth: () => new ApiError(401, 'unauthorized', 'Нужно войти'),
  forbidden: (message) => new ApiError(403, 'forbidden', message || 'Нет прав'),
  notFound: (message) => new ApiError(404, 'not_found', message || 'Не найдено'),
  conflict: (code, message, extra) => new ApiError(409, code, message, extra),
  badEvent: (message, seq) => new ApiError(422, 'bad_event', message, { seq }),
  locked: (by, until) => new ApiError(423, 'locked', 'Матч ведёт другое устройство', { by, until })
};

// проверки полей: бросают 400 с именем поля
const V = {
  str(v, field, min, max) {
    if (typeof v !== 'string') throw E.bad('Поле ' + field + ' должно быть строкой', field);
    const s = v.trim().replace(/\s+/g, ' ');
    if (s.length < min || s.length > max) throw E.bad('Поле ' + field + ': от ' + min + ' до ' + max + ' символов', field);
    return s;
  },
  optStr(v, field, max) { return v == null ? '' : V.str(v, field, 0, max); },
  int(v, field, min, max) {
    if (!Number.isInteger(v) || v < min || v > max) throw E.bad('Поле ' + field + ': целое число от ' + min + ' до ' + max, field);
    return v;
  },
  optTime(v, field) {
    if (v == null) return null;
    if (!Number.isInteger(v) || v < 0 || v > 4102444800000) throw E.bad('Поле ' + field + ': время в миллисекундах', field);
    return v;
  },
  oneOf(v, field, list) {
    if (!list.includes(v)) throw E.bad('Поле ' + field + ': одно из ' + list.join(', '), field);
    return v;
  },
  bool(v, field) {
    if (typeof v !== 'boolean') throw E.bad('Поле ' + field + ': true или false', field);
    return v;
  },
  id(v, field) {
    if (typeof v !== 'string' || !/^[a-z]\w{0,40}$/.test(v)) throw E.bad('Поле ' + field + ': неверный id', field);
    return v;
  }
};

module.exports = { ApiError, E, V };
