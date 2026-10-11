/* offline.js — camada de API + cache + fila offline (Ministério Pessoal, IASD Nova Brasília)
 *
 * Substitui o google.script.run: o frontend continua chamando gsRun('nomeDaFuncao', ...args),
 * mas agora a chamada vai por fetch ao Web App do Apps Script, e:
 *  - leituras do Painel de Registro são guardadas no aparelho (localStorage) e servidas de lá sem internet;
 *  - escritas (chamada, membros, localização) são aplicadas localmente na hora e entram numa fila,
 *    enviada ao servidor assim que houver conexão (cada operação é idempotente: usa ID gerado no aparelho).
 */
(function () {
  'use strict';

  // >>> COLE AQUI a URL do seu Web App (termina em /exec) <<<
  const API_URL = 'COLE_AQUI_A_URL_DO_APPS_SCRIPT/exec';

  const LS_CACHE = 'mp_cache_v1', LS_QUEUE = 'mp_queue_v1', LS_FAILED = 'mp_failed_v1';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage cheio?', e); } };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  let cache = load(LS_CACHE, { directory: null, pgsLoc: null, groups: {} });
  let queue = load(LS_QUEUE, []);
  let failed = load(LS_FAILED, []);
  const persist = () => { save(LS_CACHE, cache); save(LS_QUEUE, queue); save(LS_FAILED, failed); };

  const newId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const gkey = (tipo, gid) => tipo + ':' + String(gid);
  const sameId = (a, b) => String(a) === String(b);

  class NetErr extends Error {}

  async function post(fn, args) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    let resp;
    try {
      // text/plain evita o preflight CORS, que o Apps Script não responde.
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: fn, args: args }),
        signal: ctrl.signal,
      });
    } catch (e) { clearTimeout(t); throw new NetErr('Sem conexão com o servidor.'); }
    clearTimeout(t);
    if (!resp.ok) throw new NetErr('Servidor indisponível (' + resp.status + ').');
    let json;
    try { json = await resp.json(); } catch (e) { throw new NetErr('Resposta inválida do servidor.'); }
    if (!json.ok) throw new Error(json.error || 'Erro no servidor.');
    return json.data;
  }

  async function localHash(tipo, gid, pw) {
    if (!(window.crypto && crypto.subtle)) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mp|' + tipo + '|' + gid + '|' + pw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function group(key) {
    if (!cache.groups[key]) cache.groups[key] = {};
    return cache.groups[key];
  }

  // ---------- Fila de sincronização ----------
  const opErrors = {};
  let flushing = null;

  async function doFlush() {
    while (queue.length) {
      const op = queue[0];
      try {
        await post(op.fn, op.args);
        queue.shift(); persist();
      } catch (e) {
        if (e instanceof NetErr) break;               // sem internet: tenta depois
        queue.shift();                                 // erro "de verdade" do servidor: não adianta repetir
        opErrors[op.opId] = e.message;
        failed.push({ opId: op.opId, fn: op.fn, msg: e.message, ts: Date.now() });
        persist();
      }
      badge();
    }
  }
  function flush() {
    if (!flushing) {
      flushing = doFlush().finally(() => { flushing = null; badge(); });
    }
    return flushing;
  }
  const hasPending = (key) => queue.some(o => o.key === key);

  async function enqueue(op) {
    op.opId = newId(); op.ts = Date.now();
    queue.push(op); persist(); badge();
    await flush();
    if (queue.some(o => o.opId === op.opId)) await flush();
    if (opErrors[op.opId]) {
      const msg = opErrors[op.opId]; delete opErrors[op.opId];
      failed = failed.filter(f => f.opId !== op.opId); persist(); badge();
      throw new Error(msg);                            // o chamador vê o erro na hora
    }
    return true;
  }

  // ---------- Leituras ----------
  async function readThrough(fn, args, store, fallback) {
    try {
      const d = await post(fn, args);
      store(d); persist();
      return d;
    } catch (e) {
      if (!(e instanceof NetErr)) throw e;
      const fb = fallback();
      if (fb === undefined || fb === null) throw e;
      return clone(fb);
    }
  }

  async function groupRead(fn, tipo, gid, args, field) {
    const key = gkey(tipo, gid);
    await flush();
    if (!hasPending(key)) {                            // com pendências, o cache local é mais novo que o servidor
      try {
        const d = await post(fn, args);
        group(key)[field] = d; persist();
        return d;
      } catch (e) { if (!(e instanceof NetErr)) throw e; }
    }
    const g = cache.groups[key];
    if (!g || g[field] === undefined) {
      throw new NetErr('Sem conexão, e este grupo ainda não foi baixado neste aparelho. Conecte-se uma vez para habilitar o modo offline.');
    }
    return clone(g[field]);
  }

  async function checkGroupPassword(tipo, gid, pw) {
    const key = gkey(tipo, gid);
    try {
      const ok = await post('checkGroupPassword', [tipo, gid, pw]);
      if (ok) { const h = await localHash(tipo, gid, pw); if (h) { group(key).hash = h; persist(); } }
      return ok;
    } catch (e) {
      if (!(e instanceof NetErr)) throw e;
      const g = cache.groups[key];
      const h = await localHash(tipo, gid, pw);
      if (g && g.hash && h) return g.hash === h;
      throw new NetErr('Sem conexão. Entre uma vez com internet neste aparelho para liberar o acesso offline deste grupo.');
    }
  }

  // ---------- Roteador ----------
  async function call(fn, args) {
    args = args || [];
    switch (fn) {
      case 'getGroupsDirectory':
        return readThrough(fn, args, d => { cache.directory = d; }, () => cache.directory);
      case 'getPgsLocations':
        return readThrough(fn, args, d => { cache.pgsLoc = d; },
          () => cache.pgsLoc || (cache.directory && cache.directory.pgs) || []);
      case 'checkGroupPassword':
        return checkGroupPassword(args[0], args[1], args[2]);
      case 'getGroupMembers':     return groupRead(fn, args[0], args[1], args, 'members');
      case 'getEncontros':        return groupRead(fn, args[0], args[1], args, 'encontros');
      case 'getFrequenciaGrupo':  return groupRead(fn, args[0], args[1], args, 'freq');
      case 'getFrequencia': {     // (tipo, gid, encontroId, pw) — responde do cache quando o grupo já foi baixado
        const g = cache.groups[gkey(args[0], args[1])];
        if (g && Array.isArray(g.freq)) {
          return g.freq.filter(f => sameId(f.encontroId, args[2])).map(f => ({ membroId: f.membroId, presente: f.presente }));
        }
        return post(fn, args);
      }

      // ----- escritas do Painel de Registro: aplica local + fila -----
      case 'addMemberRegistro': {            // (tipo, gid, nome, tel, batizado, pw)
        const [tipo, gid, nome, tel, bat, pw] = args; const id = newId(); const key = gkey(tipo, gid);
        const g = group(key);
        if (Array.isArray(g.members)) g.members.push({ id: id, nome: nome, batizado: !!bat });
        return enqueue({ fn: fn, key: key, args: [tipo, gid, nome, tel, bat, pw, id] });
      }
      case 'updateMemberRegistro': {         // (memberId, tipo, gid, nome, tel, batizado, pw)
        const [mid, tipo, gid, nome, , bat] = args; const key = gkey(tipo, gid); const g = group(key);
        const m = (g.members || []).find(x => sameId(x.id, mid));
        if (m) { m.nome = nome; m.batizado = !!bat; }
        return enqueue({ fn: fn, key: key, args: args });
      }
      case 'deleteMemberRegistro': {         // (memberId, tipo, gid, pw)
        const [mid, tipo, gid] = args; const key = gkey(tipo, gid); const g = group(key);
        if (Array.isArray(g.members)) g.members = g.members.filter(x => !sameId(x.id, mid));
        if (Array.isArray(g.freq)) g.freq = g.freq.filter(f => !sameId(f.membroId, mid));
        return enqueue({ fn: fn, key: key, args: args });
      }
      case 'registrarChamada': {             // (tipo, gid, data, obs, presencas, pw)
        const [tipo, gid, data, obs, presencas, pw] = args; const id = newId(); const key = gkey(tipo, gid);
        const g = group(key);
        if (Array.isArray(g.encontros)) g.encontros.push({ id: id, tipo: tipo, grupoId: String(gid), data: data, observacoes: obs || '' });
        if (Array.isArray(g.freq)) (presencas || []).forEach(p => g.freq.push({ encontroId: id, membroId: p.membroId, presente: !!p.presente }));
        return enqueue({ fn: fn, key: key, args: [tipo, gid, data, obs, presencas, pw, id] }).then(() => id);
      }
      case 'saveFrequencia': {               // (tipo, gid, encontroId, presencas, pw)
        const [tipo, gid, eid, presencas] = args; const key = gkey(tipo, gid); const g = group(key);
        if (Array.isArray(g.freq)) {
          g.freq = g.freq.filter(f => !sameId(f.encontroId, eid))
            .concat((presencas || []).map(p => ({ encontroId: eid, membroId: p.membroId, presente: !!p.presente })));
        }
        return enqueue({ fn: fn, key: key, args: args });
      }
      case 'deleteEncontro': {               // (tipo, gid, encontroId, pw)
        const [tipo, gid, eid] = args; const key = gkey(tipo, gid); const g = group(key);
        if (Array.isArray(g.encontros)) g.encontros = g.encontros.filter(e => !sameId(e.id, eid));
        if (Array.isArray(g.freq)) g.freq = g.freq.filter(f => !sameId(f.encontroId, eid));
        return enqueue({ fn: fn, key: key, args: args });
      }
      case 'updateGroupLocation': {          // (tipo, gid, lat, lng, pw)
        const [tipo, gid, lat, lng] = args;
        const upd = (list) => (list || []).forEach(p => { if (sameId(p.id, gid)) { p.lat = lat; p.lng = lng; } });
        if (cache.directory) upd(cache.directory.pgs);
        upd(cache.pgsLoc);
        return enqueue({ fn: fn, key: gkey(tipo, gid), args: args });
      }

      // ----- painel do coordenador e demais: sempre direto no servidor (precisa de internet) -----
      default:
        return post(fn, args);
    }
  }

  // ---------- Indicador de sincronização ----------
  let hadPending = false, okTimer = null;
  function badge() {
    let el = document.getElementById('mp-sync-badge');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'mp-sync-badge';
      el.style.cssText = 'position:fixed;left:14px;bottom:62px;z-index:98;padding:7px 12px;border-radius:999px;font:600 11.5px Inter,sans-serif;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.2);cursor:pointer;display:none';
      el.onclick = () => {
        if (failed.length) {
          alert('Estes registros não puderam ser enviados:\n\n' + failed.map(f => '• ' + f.fn + ': ' + f.msg).join('\n'));
          failed = []; persist(); badge();
        } else { flush(); }
      };
      document.body.appendChild(el);
    }
    const n = queue.length, off = !navigator.onLine;
    let txt = '', bg = '#64748B';
    if (failed.length) { txt = '⚠ ' + failed.length + ' registro(s) não sincronizado(s) — toque para ver'; bg = '#C8102E'; }
    else if (n > 0) { hadPending = true; txt = (flushing ? 'Sincronizando… ' : (off ? 'Offline · ' : 'Aguardando envio · ')) + n + ' pendente(s)'; bg = flushing ? '#0F4C86' : '#B8862A'; }
    else if (hadPending) { hadPending = false; txt = '✓ Tudo sincronizado'; bg = '#0F4C86'; clearTimeout(okTimer); okTimer = setTimeout(badge, 3000); }
    else if (off) { txt = 'Offline — dados salvos neste aparelho'; }
    if (n === 0 && !failed.length && !txt) { el.style.display = 'none'; return; }
    if (!txt) { el.style.display = 'none'; return; }
    el.textContent = txt; el.style.background = bg; el.style.display = 'block';
  }

  window.addEventListener('online', () => { badge(); flush(); });
  window.addEventListener('offline', badge);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
  setInterval(() => { if (queue.length) flush(); }, 30000);
  window.addEventListener('DOMContentLoaded', () => { badge(); flush(); });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e)); });
  }

  window.MPOffline = { call: call, flush: flush, pending: () => queue.length };
})();
