// Тариф Pro (право pro): статистика за период, личные встречи, выгрузка матчей.
const { pool, one } = require('../db');
const { E, V } = require('../errors');
const { needPerm } = require('../auth');
const P = require('../pro');

module.exports = async function (app) {
  // GET /api/me/pro?period=30|90|365|all
  app.get('/api/me/pro', async req => {
    const me = needPerm(req, 'pro', 'Статистика Pro — в тарифе Pro');
    const period = req.query.period == null ? '90' : V.oneOf(String(req.query.period), 'period', Object.keys(P.PERIODS));
    return P.proStats(pool, me.id, period);
  });
  // личные встречи со мной
  app.get('/api/players/:id/h2h', async req => {
    const me = needPerm(req, 'pro', 'Личные встречи — в тарифе Pro');
    if (req.params.id === me.id) throw E.bad('Это вы', 'id');
    if (!await one(pool, 'SELECT 1 FROM players WHERE id = $1', [req.params.id])) throw E.notFound('Игрок не найден');
    return P.h2h(pool, me.id, req.params.id);
  });
  // все мои матчи в CSV для Excel
  app.get('/api/me/export.csv', async (req, reply) => {
    const me = needPerm(req, 'pro', 'Выгрузка матчей — в тарифе Pro');
    const csv = await P.exportCsv(pool, me.id);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="oche-' + me.code + '.csv"').header('Cache-Control', 'private, no-store');
    return '﻿' + csv;
  });
};
