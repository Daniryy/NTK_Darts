/* Oche: все запросы страницы к серверу (договор — docs/api.md).
   Режим: «сервер», если /api отвечает, иначе «демо» (данные в браузере). Выбор можно закрепить: Api.setMode('demo' | 'server' | null).
   Очередь неотправленного (Api.ob): события счётчика сохраняются на телефоне и уходят по порядку seq, без сети — досылаются сами.
   Поток табло (Api.stream): EventSource, а без него — опрос версии раз в 30 с. Свёрнутая вкладка ничего не запрашивает. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Api = factory(root);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';
  const ls = {
    get(k) { try { const v = W.localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { if (v == null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const visible = () => !W.document || W.document.visibilityState !== 'hidden';

  // устройство: замок матча и ограничение частоты (см. «Устройство» в api.md)
  function deviceId() {
    let d = ls.get('oche.device');
    if (typeof d !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) {
      const a = new Uint8Array(18);
      (W.crypto || {}).getRandomValues ? W.crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); });
      d = Array.from(a, x => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[x % 64]).join('');
      ls.set('oche.device', d);
    }
    return d;
  }

  // ошибка запроса: status 0 — нет сети или сервер не ответил
  class ApiError extends Error {
    constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data || {}; }
    get net() { return this.status === 0; }
  }
  const NET_MSG = 'Нет связи с сервером';

  const Api = {
    mode: 'demo', config: { vk: false, phone: false, dev: false }, me: null, admin: false, role: null, perms: [], clubs: [], base: '',
    ApiError,
    get device() { return deviceId(); },

    async req(method, path, body, o) {
      o = o || {};
      const headers = { 'X-Device-Id': deviceId() };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      const ctl = W.AbortController ? new W.AbortController() : null, tm = ctl && setTimeout(() => ctl.abort(), o.timeout || 15000);
      try {
        res = await W.fetch(Api.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: ctl && ctl.signal });
      } catch (e) {
        throw new ApiError(0, 'net', NET_MSG);
      } finally { if (tm) clearTimeout(tm); }
      if (res.status === 204) return null;
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        const er = data && data.error ? data.error : { code: res.status >= 500 ? 'server' : 'bad', message: 'Ошибка сервера (' + res.status + ')' };
        throw new ApiError(res.status, er.code, er.message, er);
      }
      return data;
    },
    get: (p, o) => Api.req('GET', p, undefined, o),
    post: (p, b) => Api.req('POST', p, b === undefined ? {} : b),
    put: (p, b) => Api.req('PUT', p, b === undefined ? {} : b),
    patch: (p, b) => Api.req('PATCH', p, b === undefined ? {} : b),
    del: p => Api.req('DELETE', p),
    // файл (фото) телом запроса как есть
    async upload(path, blob) {
      let res;
      try {
        res = await W.fetch(Api.base + path, { method: 'POST', headers: { 'X-Device-Id': deviceId(), 'Content-Type': blob.type || 'image/jpeg' }, body: blob, credentials: 'same-origin' });
      } catch (e) { throw new ApiError(0, 'net', NET_MSG); }
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) { const er = data && data.error ? data.error : { code: 'server', message: 'Ошибка сервера (' + res.status + ')' }; throw new ApiError(res.status, er.code, er.message, er); }
      return data;
    },

    // режим работы: закреплённый выбор или «сервер, если отвечает»
    storedMode: () => ls.get('oche.mode'),
    setMode(m) { ls.set('oche.mode', m || null); },
    async detect() {
      const want = ls.get('oche.mode');
      if (want === 'demo') { Api.mode = 'demo'; return Api.mode; }
      try {
        Api.config = await Api.get('/api/config', { timeout: 3000 });
        Api.mode = 'server';
        Api.offline = false;
        await Api.loadMe().catch(() => {});
        ls.set('oche.lastMode', 'server');
      } catch (e) {
        // без сети страница, работавшая с сервером, остаётся на сервере: очередь счёта дождётся связи
        const last = ls.get('oche.lastMe');
        if (e.net && ls.get('oche.lastMode') === 'server') {
          Api.mode = 'server'; Api.offline = true;
          if (last) { Api.setMe(last); Api.config = last.config || Api.config; }
        } else Api.mode = 'demo';
      }
      return Api.mode;
    },
    // ответ «кто я» (/api/me, вход, правка профиля): игрок, роль, клубы ведущего; запоминается для входа без сети
    setMe(r) {
      Api.me = r.player || r.me || null; Api.admin = !!r.admin; Api.role = Api.me ? r.role || Api.me.role || 'player' : null; Api.clubs = r.clubs || [];
      Api.perms = Api.me ? r.perms || [] : [];
      if (Api.mode === 'server') ls.set('oche.lastMe', Api.me ? { player: Api.me, admin: Api.admin, role: Api.role, perms: Api.perms, clubs: Api.clubs, config: Api.config } : null);
      return r;
    },
    async loadMe() { return Api.setMe(await Api.get('/api/me')); },
    // роль не ниже: player < host и свои роли (тарифы) < admin < tech
    can: role => { const R = { player: 0, host: 1, admin: 2, tech: 3 }, rk = r => r in R ? R[r] : 1; return !!Api.me && rk(Api.role) >= rk(role); },
    // право из настроек ролей сервера (club_tour, streams, accounts, host_nums, players, block, give_host, clubs, …)
    perm: k => !!Api.me && (Api.role === 'tech' || Api.perms.includes(k)),
    // вход администратора по логину и паролю
    async passwordLogin(login, password) { return Api.setMe(await Api.post('/api/auth/password', { login, password })); },
    // link — привязать VK к аккаунту, в который уже вошли
    loginUrl: (ret, link) => '/api/auth/vk?return=' + encodeURIComponent(ret || '/') + (link ? '&link=1' : ''),
    async devLogin(playerId) { await Api.post('/api/auth/dev', { playerId }); return Api.loadMe(); },
    // вход по телефону: код в SMS, затем проверка; link — привязать номер к своему аккаунту
    phoneStart: phone => Api.post('/api/auth/phone', { phone }),
    async phoneVerify(phone, code, link) { return Api.setMe(await Api.post('/api/auth/phone/verify', { phone, code, link: !!link })); },
    async codeLogin(code) { return Api.setMe(await Api.post('/api/auth/code', { code })); },
    // почта: регистрация (ответ — письмо с кодом или сразу аккаунт), письмо с кодом (link | reset), проверка кода, вход
    async register(b) { const r = await Api.post('/api/auth/register', b); return r.player ? Api.setMe(r) : r; },
    mailSend: (email, purpose) => Api.post('/api/auth/email/send', { email, purpose }),
    async mailVerify(b) { return Api.setMe(await Api.post('/api/auth/email/verify', b)); },
    async mailLogin(email, password) { return Api.setMe(await Api.post('/api/auth/email/login', { email, password })); },
    async logout() { await Api.post('/api/auth/logout'); Api.setMe({}); },

    /* ===== Очередь неотправленного =====
       item: { id, start: тело PUT или null, ev: [события с seq], acked: сколько принято, stop: null | { code, message, … }, done }
       События отправляются пачками до 50, строго по порядку; reopen — отдельный запрос, когда всё до него принято. */
    ob: {
      items: ls.get('oche.outbox') || {},
      busy: {}, retry: {}, wait: {}, onchange: null,
      save() { ls.set('oche.outbox', Api.ob.items); if (Api.ob.onchange) Api.ob.onchange(); },
      get: id => Api.ob.items[id] || null,
      // новый матч: start — тело PUT /api/matches/:id
      open(id, start) {
        if (!Api.ob.items[id]) Api.ob.items[id] = { id, start, ev: [], acked: 0, stop: null, t: Date.now() };
        Api.ob.save();
        return Api.ob.items[id];
      },
      // добавить события; seq — по порядку после последнего
      push(id, evs) {
        const it = Api.ob.items[id];
        if (!it || !evs.length) return;
        evs.forEach(e => { it.ev.push(Object.assign({ seq: (it.ev.length ? it.ev[it.ev.length - 1].seq : it.base || 0) + 1 }, e)); });
        Api.ob.save();
        Api.ob.kick(id);
      },
      // неотправленных событий (и старт матча, если он ещё не принят)
      pending(id) {
        const it = Api.ob.items[id];
        return it ? it.ev.length - it.acked + (it.start ? 1 : 0) : 0;
      },
      total() { return Object.keys(Api.ob.items).reduce((a, id) => a + Api.ob.pending(id), 0); },
      drop(id) { delete Api.ob.items[id]; Api.ob.save(); },
      // после «забрать ведение счёта»: на сервере уже есть events, дальше seq продолжается от них
      reset(id, start, lastSeq) {
        Api.ob.items[id] = { id, start: null, ev: [], base: lastSeq, acked: 0, stop: null, t: Date.now() };
        if (start) Api.ob.items[id].start = start;
        Api.ob.save();
      },
      kick(only) {
        if (Api.mode !== 'server') return;
        Object.keys(Api.ob.items).forEach(id => { if (!only || id === only) Api.ob.run(id); });
      },
      async run(id) {
        const ob = Api.ob, it = ob.items[id];
        if (!it || ob.busy[id] || it.stop) return;
        if (ob.wait[id] && ob.wait[id] > Date.now()) return;
        ob.busy[id] = true;
        try {
          for (;;) {
            const cur = ob.items[id];
            if (!cur || cur.stop) break;
            if (cur.start) {
              const r = await Api.put('/api/matches/' + id, cur.start);
              cur.start = null;
              if (r && r.match && r.match.lastSeq > (cur.base || 0) && !cur.acked) {
                // повтор старта того же матча: сервер уже знает часть событий
                cur.acked = cur.ev.filter(e => e.seq <= r.match.lastSeq).length;
              }
              ob.save();
              continue;
            }
            if (cur.acked >= cur.ev.length) break;
            const next = cur.ev[cur.acked];
            if (next.type === 'reopen') {
              await Api.post('/api/matches/' + id + '/reopen');
              cur.acked++; ob.save();
              continue;
            }
            const batch = [];
            for (let k = cur.acked; k < cur.ev.length && batch.length < 50 && cur.ev[k].type !== 'reopen'; k++) batch.push(cur.ev[k]);
            try {
              const r = await Api.post('/api/matches/' + id + '/events', { events: batch });
              cur.acked = cur.ev.filter(e => e.seq <= r.seq).length;
            } catch (e) {
              if (e.code === 'seq_gap' && e.data.expectSeq) {
                // сервер ждёт более ранний номер: досылаем с него
                const k = cur.ev.findIndex(x => x.seq === e.data.expectSeq);
                if (k < 0 || k >= cur.acked) throw e;
                cur.acked = k;
              } else throw e;
            }
            ob.save();
          }
          ob.retry[id] = 0;
          const fin = ob.items[id];
          if (fin && !fin.start && fin.acked >= fin.ev.length && fin.ev.some(e => e.type === 'finish') && fin.ev[fin.ev.length - 1].type === 'finish') fin.done = true;
        } catch (e) {
          const cur = ob.items[id];
          if (cur) {
            if (e.net || e.status >= 500 || e.status === 429) {
              // нет сети или сервер занят: повтор через 1 → 2 → 5 → 10 → 30 с
              const steps = [1, 2, 5, 10, 30], n = ob.retry[id] = (ob.retry[id] || 0) + 1;
              ob.wait[id] = Date.now() + steps[Math.min(steps.length - 1, n - 1)] * 1000;
              setTimeout(() => ob.kick(id), ob.wait[id] - Date.now() + 20);
            } else cur.stop = { code: e.code, status: e.status, message: e.message, by: e.data.by, until: e.data.until, matchId: e.data.matchId, seq: e.data.seq };
            ob.save();
          }
        } finally {
          ob.busy[id] = false;
          if (Api.ob.onchange) Api.ob.onchange();
        }
      },
      // повторить остановленную отправку (после входа и т. п.)
      resume(id) { const it = Api.ob.items[id]; if (it) { it.stop = null; Api.ob.retry[id] = 0; Api.ob.wait[id] = 0; Api.ob.save(); Api.ob.kick(id); } },
      // убрать отправленные завершённые матчи
      clean() {
        Object.keys(Api.ob.items).forEach(id => { const it = Api.ob.items[id]; if (it.done && Api.ob.pending(id) === 0) delete Api.ob.items[id]; });
        ls.set('oche.outbox', Api.ob.items);
      }
    },

    /* ===== Поток турнира =====
       h: { snapshot(s), match(m), tour(x), poll() } — poll вызывается раз в 30 с, если поток не держится. */
    stream(tid, h) {
      let es = null, timer = null, closed = false, okAt = 0;
      const open = () => {
        if (closed || es || !visible() || !W.EventSource) return;
        // ?d= — устройство: лимит частоты считается по нему, а не по общему IP зала
        es = new W.EventSource(Api.base + '/api/tournaments/' + encodeURIComponent(tid) + '/stream?d=' + deviceId());
        es.addEventListener('snapshot', e => { okAt = Date.now(); h.snapshot && h.snapshot(JSON.parse(e.data)); });
        es.addEventListener('match', e => { okAt = Date.now(); h.match && h.match(JSON.parse(e.data)); });
        es.addEventListener('tour', e => { okAt = Date.now(); h.tour && h.tour(JSON.parse(e.data)); });
        es.onopen = () => { okAt = Date.now(); };
      };
      const shut = () => { if (es) { es.close(); es = null; } };
      const tick = () => {
        if (closed) return;
        if (!visible()) { shut(); return; }
        open();
        // поток молчит дольше минуты (прокси режет соединение) — опрашиваем версию
        if (!es || es.readyState === 2 || Date.now() - okAt > 60000) { if (h.poll) h.poll(); }
      };
      const vis = () => { if (visible()) { open(); if (h.poll && !es) h.poll(); } else shut(); };
      if (W.document) W.document.addEventListener('visibilitychange', vis);
      open();
      timer = setInterval(tick, 30000);
      return {
        close() { closed = true; shut(); clearInterval(timer); if (W.document) W.document.removeEventListener('visibilitychange', vis); },
        get live() { return !!es && es.readyState === 1; }
      };
    }
  };

  if (W.addEventListener) {
    W.addEventListener('online', () => { Object.keys(Api.ob.wait).forEach(k => { Api.ob.wait[k] = 0; }); Api.ob.kick(); });
    if (W.document) W.document.addEventListener('visibilitychange', () => { if (visible()) Api.ob.kick(); });
  }
  return Api;
});
