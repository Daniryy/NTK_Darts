// Свои номера игроков у ведущего: «7 — Иван Петров». В баре не нужно вписывать имена и коды:
// ведущий раз нумерует постоянных игроков, а участников турнира набирает номерами.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { playerShort } = require('../players');
const { needPerm } = require('../auth');
const { setNum } = require('./admin');

const numsOf = async (c, hostId) => (await all(c, 'SELECT h.n, p.* FROM host_nums h JOIN players p ON p.id = h.player_id WHERE h.host_id = $1 ORDER BY h.n', [hostId]))
  .map(r => ({ n: r.n, player: playerShort(r) }));

module.exports = async function (app) {
  app.get('/api/host/nums', async req => {
    const me = needPerm(req, 'host_nums', 'Номера игроков — для ведущих');
    return { nums: await numsOf(pool, me.id) };
  });

  // PUT /api/host/nums/:n — { playerId }: номер занят — переходит этому игроку; у игрока был номер — меняется
  app.put('/api/host/nums/:n', async req => {
    const me = needPerm(req, 'host_nums', 'Номера игроков — для ведущих');
    const n = V.int(+req.params.n, 'n', 1, 9999), pid = V.id((req.body || {}).playerId, 'playerId');
    return tx(async c => {
      if (!await one(c, 'SELECT 1 FROM players WHERE id = $1', [pid])) throw E.notFound('Игрок не найден');
      await setNum(c, me.id, n, pid);
      return { nums: await numsOf(c, me.id) };
    });
  });

  app.delete('/api/host/nums/:n', async req => {
    const me = needPerm(req, 'host_nums', 'Номера игроков — для ведущих');
    await pool.query('DELETE FROM host_nums WHERE host_id = $1 AND n = $2', [me.id, V.int(+req.params.n, 'n', 1, 9999)]);
    return { nums: await numsOf(pool, me.id) };
  });
};
