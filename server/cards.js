// MatchCard из api.md: сыгранный матч со строками игроков и подписью игры сетки.
const B = require('../shared/bracket.js');
const { all } = require('./db');
const { TOUR_SQL, loadTours, gameLabel } = require('./tour');

const lineJSON = l => ({ id: l.player_id, n: l.name, legs: l.legs, pts: l.pts, darts: l.darts, f9: l.f9, hi: l.hi, hco: l.hco, c180: l.c180, c140: l.c140, c100: l.c100, coh: l.coh, coa: l.coa, bl: l.bl });

// ms — строки matches со status = 'done'
async function matchCards(c, ms) {
  if (!ms.length) return [];
  const lines = await all(c, 'SELECT * FROM match_lines WHERE match_id = ANY($1) ORDER BY idx', [ms.map(m => m.id)]);
  const tids = [...new Set(ms.map(m => m.tournament_id).filter(Boolean))];
  const tours = tids.length ? await loadTours(c, await all(c, TOUR_SQL + ' WHERE t.id = ANY($1)', [tids])) : [];
  const rv = new Map(tours.map(t => [t.id, B.resolver(t)]));
  return ms.map(m => {
    const t = m.tournament_id && tours.find(x => x.id === m.tournament_id);
    return {
      id: m.id, t: m.finished, tid: m.tournament_id, tname: t ? t.name : null, r: m.r, i: m.i,
      label: t ? gameLabel(t, B.gameAt(t, m.r, m.i), rv.get(t.id)) : null, off: !!(t && t.official),
      mode: m.mode, ltw: m.ltw, dbl: m.dbl, w: m.w, quick: m.quick,
      pl: lines.filter(l => l.match_id === m.id).map(lineJSON)
    };
  });
}

module.exports = { matchCards, lineJSON };
