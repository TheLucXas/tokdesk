'use strict';
// ---------- LIVE dentro de la app ----------
// Los directos llegan en FLV (el HLS nativo de Chromium no los decodifica): los reproduce mpegts.js.
// Fuentes medidas desde la web: webcast/feed canal 87 = recomendados, canal 81 = seguidos en vivo ahora,
// /api-live/user/room/ = la sala de un usuario.

function flvOf(streamData, low) {
  try {
    const sd = JSON.parse(streamData).data;
    return (low ? ['sd', 'ld', 'hd'] : ['hd', 'sd', 'ld', 'origin']).map((q) => sd[q] && sd[q].main && sd[q].main.flv).find(Boolean) || null;
  } catch { return null; }
}

function liveItem(room) {
  const ow = room.owner || {};
  const su = room.stream_url || {};
  const fp = su.flv_pull_url || {};
  const flv = flvOf(su.live_core_sdk_data && su.live_core_sdk_data.pull_data && su.live_core_sdk_data.pull_data.stream_data)
    || fp.HD1 || fp.SD1 || fp.FULL_HD1 || fp.SD2 || null;
  return {
    id: 'live' + (room.id_str || room.id), roomId: room.id_str || String(room.id), live: true, src: null, photos: [], flv, likeCount: room.like_count || 0,
    cover: urlOf(room.cover) || urlOf(ow.avatar_large) || urlOf(ow.avatar_thumb), ratio: 16 / 9,
    author: ow.display_id, nick: ow.nickname, avatar: urlOf(ow.avatar_thumb), authorId: ow.id_str || String(ow.id || ''), secUid: ow.sec_uid,
    desc: room.title || '', music: '', likes: 0, comments: 0, saves: 0, shares: 0, plays: 0,
    viewers: room.user_count || (room.stats && room.stats.total_user) || 0,
    subtitles: [], liked: false, saved: false, followed: !!(ow.follow_info && ow.follow_info.follow_status), lang: '',
  };
}

async function loadLives(f, channel) {
  if (f.loading || !f.hasMore) return;
  f.loading = true;
  const r = await api('GET', 'https://webcast.tiktok.com/webcast/feed/', { channel_id: channel, count: 10, max_time: f.cursor || 0 });
  f.loading = false;
  const d = r.data;
  const list = d && Array.isArray(d.data) ? d.data.map((x) => x.data).filter((x) => x && x.owner) : null;
  if (!list) { f.hasMore = false; f.error = true; feedChanged(f); return; }
  for (const room of list) {
    const it = liveItem(room);
    if (!f.ids.has(it.id)) { f.ids.add(it.id); f.items.push(it); }
  }
  f.cursor = (d.extra && d.extra.max_time) || 0;
  f.hasMore = channel !== 81 && !!(d.extra && d.extra.has_more) && list.length > 0;
  feedChanged(f);
}

// Sala de un usuario (para directos del feed o de un anillo): null si no está en vivo
async function roomOf(uniqueId) {
  const r = await api('GET', '/api-live/user/room/', { uniqueId, sourceType: 54 });
  const d = r.data && r.data.data;
  const lr = d && d.liveRoom;
  if (!lr || lr.status !== 2) return null;
  const raw = lr.streamData && lr.streamData.pull_data && lr.streamData.pull_data.stream_data;
  return { flv: flvOf(raw), flvLow: flvOf(raw, true), title: lr.title,
    viewers: lr.liveRoomStats && lr.liveRoomStats.userCount, cover: lr.coverUrl, user: d.user || {}, roomId: d.user && d.user.roomId };
}

// La pantalla del directo es la de la app, no la de un video: anfitrión con me gusta y botón de seguir arriba
// a la izquierda, espectadores y cerrar arriba a la derecha, chat superpuesto abajo y la barra de escribir
function liveOverlay(it) {
  return `<div class="lv-top">
      <div class="lv-host"><img alt="" src="${esc(it.avatar || '')}"><div class="lv-hn"><b>${esc(it.nick || it.author || '')}</b>
        <span class="lv-likes">${ICON.heart}<i>${it.likeCount ? fmt(it.likeCount) : ''}</i></span></div>
        <button class="lv-follow"${it.followed ? ' hidden' : ''}>${esc(t('Seguir'))}</button></div>
      <div class="lv-right"><span class="lv-viewers">${ICON.user}<i>${it.viewers ? fmt(it.viewers) : ''}</i></span><button class="lv-close" title="${esc(t('Cerrar'))}">${ICON.close}</button></div>
    </div>
    ${it.desc ? `<div class="lv-title">${esc(it.desc)}</div>` : ''}
    <div class="lv-chat"></div>
    <div class="lv-bottom"><form class="lv-form"><input class="lv-input" maxlength="150" autocomplete="off" placeholder="${esc(t('Escribe algo…'))}"><button type="button" class="emoji-btn" title="${esc(t('Emojis'))}">${ICON.smile}</button></form>
      <button class="lv-like" title="${esc(t('Me gusta'))}">${ICON.heart}</button>
      <button class="lv-share" title="${esc(t('Compartir'))}">${ICON.share}</button>
      <button class="livebtn" title="${esc(t('Ver en el navegador'))}">${ICON.globe}</button></div>
    <div class="live-end">${esc(t('La transmisión terminó'))}</div>`;
}

function wireLive(el, it) {
  if (el.liveWired) return;
  el.liveWired = true;
  const stop = (e) => e.stopPropagation();
  $('.lv-close', el).onclick = (e) => { stop(e); back(); };
  $('.lv-follow', el).onclick = async (e) => { stop(e); await follow(it, true); $('.lv-follow', el).hidden = true; };
  $('.lv-host img', el).onclick = (e) => { stop(e); openProfile(it); };
  $('.lv-share', el).onclick = (e) => { stop(e); openShare(it); };
  $('.lv-form', el).onclick = stop;
  $('.lv-form .emoji-btn', el).onclick = (e) => { stop(e); openEmojis(e.currentTarget, $('.lv-input', el)); };
  $('.lv-form', el).onsubmit = (e) => { e.preventDefault(); liveChat(it, el); };
  $('.lv-like', el).onclick = (e) => { stop(e); liveLike(it); };
}

async function startLive(el, it) {
  if (el.livePlayer || el.liveStarting) return;
  el.liveStarting = true;
  if ((!it.flv || !it.roomId) && it.author) {
    const r = await roomOf(it.author);
    if (r) { it.flv = it.flv || r.flv; it.flvLow = r.flvLow; it.roomId = it.roomId || r.roomId; it.viewers = r.viewers || it.viewers; }
  }
  el.liveStarting = false;
  if (!el.isConnected || currentItem() !== it) return;
  wireLive(el, it);
  if (!it.flv || !window.mpegts) { el.classList.remove('waiting'); el.classList.add('live-ended'); return; }
  const v = el.media;
  // Directo de baja latencia: sin búfer de acumulación, persiguiendo el borde en vivo y limpiando lo ya visto
  const url = it.lowQuality && it.flvLow ? it.flvLow : it.flv;
  const p = mpegts.createPlayer({ type: 'flv', isLive: true, url }, {
    enableWorker: true, enableStashBuffer: false, stashInitialSize: 128 * 1024, lazyLoad: false,
    liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 4, liveBufferLatencyMinRemain: 0.8,
    autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10,
  });
  p.on(mpegts.Events.ERROR, async (a, b) => {
    log('live: ' + a + ' ' + b);
    // La dirección del feed puede estar vencida: se pide la de la sala una vez y se reintenta
    stopLive(el);
    if (!it.retried && it.author) {
      it.retried = true;
      const r = await roomOf(it.author);
      if (r && r.flv && r.flv !== it.flv) { it.flv = r.flv; if (currentItem() === it) startLive(el, it); return; }
    }
    el.classList.add('live-ended');
  });
  p.attachMediaElement(v);
  p.load();
  el.livePlayer = p;
  v.muted = state.muted; v.volume = state.volume;
  v.addEventListener('playing', () => el.classList.remove('waiting', 'paused'), { once: true });
  v.play().catch(() => {});
  const gen = el.liveGen = (el.liveGen || 0) + 1;
  watchLive(el, it, p);
  if (it.roomId) { pollRoom(el, it, gen); pollChat(el, it, gen); }
  // Se deja el directo listo en la página oculta para que escribir y dar me gusta respondan enseguida
  if (state.me) setTimeout(() => { if (el.livePlayer && currentItem() === it) liveAct(it, "'ok'"); }, 1500);
}

// Si la imagen se queda quieta: primero se salta al borde en vivo; si sigue trabada, se recarga el reproductor
// (y si se traba seguido, se baja a la calidad estándar)
function watchLive(el, it, p) {
  const v = el.media;
  let last = -1, still = 0, reloads = 0;
  clearInterval(el.liveWatch);
  el.liveWatch = setInterval(() => {
    if (el.livePlayer !== p || !el.isConnected) { clearInterval(el.liveWatch); return; }
    if (v.paused || el.dataset.userPaused) { still = 0; return; }
    if (v.currentTime !== last) { last = v.currentTime; still = 0; return; }
    still++;
    const b = v.buffered, end = b.length ? b.end(b.length - 1) : 0;
    if (still === 2 && end - v.currentTime > 0.5) { v.currentTime = end - 0.3; v.play().catch(() => {}); return; }
    if (still >= 4) {
      clearInterval(el.liveWatch);
      reloads++;
      if (it.flvLow && (++it.stalls >= 2 || reloads > 1)) it.lowQuality = true;
      log('live: trabado, se recarga' + (it.lowQuality ? ' en calidad estándar' : ''));
      stopLive(el);
      if (currentItem() === it) startLive(el, it);
    }
  }, 1500);
  it.stalls = it.stalls || 0;
}

function stopLive(el) {
  clearInterval(el.liveWatch);
  if (el.liveSession) { el.liveSession = false; send({ t: 'liverelease' }); }
  if (!el.livePlayer) return;
  try { el.livePlayer.pause(); el.livePlayer.unload(); el.livePlayer.detachMediaElement(); el.livePlayer.destroy(); } catch { }
  el.livePlayer = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEBCAST = 'https://webcast.tiktok.com/webcast/';

// Me gusta y espectadores de la sala, cada 15 s mientras se mira
async function pollRoom(el, it, gen) {
  while (el.livePlayer && el.isConnected && el.liveGen === gen) {
    const r = await api('GET', WEBCAST + 'room/info/', { room_id: it.roomId });
    const d = r.data && r.data.data;
    if (d) {
      if (d.status === 4) { el.classList.add('live-ended'); stopLive(el); return; }
      it.likeCount = d.like_count || it.likeCount;
      it.viewers = d.user_count || (d.stats && d.stats.total_user) || it.viewers;
      $('.lv-likes i', el).textContent = it.likeCount ? fmt(it.likeCount) : '';
      $('.lv-viewers i', el).textContent = it.viewers ? fmt(it.viewers) : '';
      const ow = d.owner || {};
      if (ow.follow_info && ow.follow_info.follow_status) $('.lv-follow', el).hidden = true;
    }
    await sleep(15000);
  }
}

// ---------- Chat del directo (solo lectura): webcast/im/fetch responde en protobuf ----------
function pbFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => { let x = 0, m = 1, b; do { b = buf[i++]; x += (b & 127) * m; m *= 128; } while (b >= 128 && i < buf.length); return x; };
  try {
    while (i < buf.length) {
      const key = varint(), f = Math.floor(key / 8), w = key & 7;
      if (w === 0) out.push([f, varint()]);
      else if (w === 2) { const n = varint(); if (i + n > buf.length) break; out.push([f, buf.subarray(i, i + n)]); i += n; }
      else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else break;
    }
  } catch { }
  return out;
}
const pbGet = (fields, n) => (fields.find((x) => x[0] === n) || [])[1];
const pbText = (b) => (b && b.length != null ? new TextDecoder().decode(b) : '');
function pbUser(b) {
  if (!b || b.length == null) return {};
  const u = pbFields(b);
  const pic = pbGet(u, 9);
  return { nick: pbText(pbGet(u, 3)), uid: pbText(pbGet(u, 38)), avatar: pic ? pbText(pbGet(pbFields(pic), 1)) : '' };
}

async function pollChat(el, it, gen) {
  let cursor = '', ext = '';
  const seen = new Set();
  const box = $('.lv-chat', el);
  while (el.livePlayer && el.isConnected && el.liveGen === gen) {
    const r = await api('GET', WEBCAST + 'im/fetch/', { room_id: it.roomId, resp_content_type: 'protobuf', fetch_rule: 1, cursor, internal_ext: ext,
      last_rtt: 0, did_rule: 3, live_id: 12, version_code: 180800, __b64: 1 });
    let wait = 2000;
    if (r.data && r.data.b64) {
      const bin = Uint8Array.from(atob(r.data.b64), (c) => c.charCodeAt(0));
      const top = pbFields(bin);
      cursor = pbText(pbGet(top, 2)) || cursor;
      ext = pbText(pbGet(top, 5)) || ext;
      wait = Math.min(5000, Math.max(1000, pbGet(top, 3) || 1500));
      for (const [f, m] of top) {
        if (f !== 1) continue;
        const msg = pbFields(m);
        const id = pbGet(msg, 3);
        if (id) { if (seen.has(id)) continue; seen.add(id); if (seen.size > 2000) seen.clear(); }
        const method = pbText(pbGet(msg, 1)), pay = pbFields(pbGet(msg, 2) || new Uint8Array());
        if (method === 'WebcastChatMessage') addChat(box, pbUser(pbGet(pay, 2)), pbText(pbGet(pay, 3)));
        else if (method === 'WebcastMemberMessage') addChat(box, pbUser(pbGet(pay, 2)), t('se unió'), 'join');
        else if (method === 'WebcastLikeMessage') {
          const total = pbGet(pay, 3);
          if (total) { it.likeCount = total; $('.lv-likes i', el).textContent = fmt(total); }
        } else if (method === 'WebcastRoomUserSeqMessage') {
          const total = pbGet(pay, 3);
          if (total) { it.viewers = total; $('.lv-viewers i', el).textContent = fmt(total); }
        } else if (method === 'WebcastGiftMessage') addChat(box, pbUser(pbGet(pay, 7)), t('envió un regalo'), 'gift');
      }
    } else wait = 5000;
    await sleep(wait);
  }
}
function addChat(box, u, text, kind) {
  if (!text || !u.nick) return;
  const row = document.createElement('div');
  row.className = 'lv-msg' + (kind ? ' ' + kind : '');
  row.innerHTML = `${u.avatar ? `<img alt="" src="${esc(u.avatar)}">` : ''}<div><b>${esc(u.nick)}</b> <span>${esc(text)}</span></div>`;
  // Si estás leyendo más arriba, el chat no salta al final
  const atEnd = box.scrollTop + box.clientHeight > box.scrollHeight - 40;
  box.appendChild(row);
  if (atEnd) { while (box.children.length > 60) box.firstChild.remove(); box.scrollTop = box.scrollHeight; }
  else while (box.children.length > 200) box.firstChild.remove();
}

async function openLiveOf(uniqueId) {
  const r = await roomOf(uniqueId);
  if (!r) { toast(t('La transmisión terminó')); return; }
  const u = r.user;
  const it = { id: 'live' + u.roomId, roomId: u.roomId, live: true, src: null, photos: [], flv: r.flv, cover: r.cover || u.avatarLarger, ratio: 16 / 9,
    author: u.uniqueId, nick: u.nickname, avatar: u.avatarThumb, authorId: u.id, secUid: u.secUid, desc: r.title || '', music: '',
    likes: 0, comments: 0, saves: 0, shares: 0, plays: 0, viewers: r.viewers || 0, subtitles: [], liked: false, saved: false,
    followed: u.followStatus === 1, lang: '' };
  const f = feedFor('liveone:' + uniqueId);
  f.items = [it]; f.ids = new Set([it.id]);
  openSubFeed(f, 0);
}

// Botón LIVE arriba a la izquierda, como en la app
$('#btnLive').innerHTML = '<svg class="livetv" viewBox="0 0 28 24"><path d="M9 1.5l4 4M19 1.5l-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="1.5" y="5.5" width="25" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><text x="14" y="17.6" text-anchor="middle" font-size="8.5" font-weight="800" fill="currentColor" font-family="Arial, sans-serif">LIVE</text></svg>';
$('#btnLive').addEventListener('click', () => openSubFeed(feedFor('lives'), 0));

// Seguidos en vivo: fila arriba de «Siguiendo» y anillo en su foto en cualquier feed
const liveNow = new Map();   // usuario -> { at, live }
let followLive = [];
async function refreshFollowLive() {
  if (!state.me) return;
  feeds.delete('livefollow');
  const f = feedFor('livefollow');
  await loadLives(f, 81);
  followLive = f.items;
  for (const it of followLive) liveNow.set(it.author, { at: Date.now(), live: true });
  renderLiveRow();
  for (const el of state.slides.values()) if (!el.item.live && liveNow.get(el.item.author)?.live) markLiveAvatar(el);
}
function renderLiveRow() {
  const show = !!(state.feed && state.feed.key === 'following' && !state.stack.length && followLive.length);
  document.body.classList.toggle('liverow', show);
  if (!show) return;
  $('#liveRow').innerHTML = followLive.map((it, i) => `<button data-i="${i}"><span class="ring"><img alt="" src="${esc(it.avatar || '')}"></span>
    <span class="live-tag">LIVE</span><span class="nm">${esc(it.nick || it.author)}</span></button>`).join('');
  $$('#liveRow button').forEach((b) => b.onclick = () => openSubFeed(feedFor('livefollow'), +b.dataset.i));
}
$('#liveRow').addEventListener('wheel', (e) => { if (e.deltaY) { e.preventDefault(); e.currentTarget.scrollLeft += e.deltaY; } }, { passive: false });

function markLiveAvatar(el) { el.item.authorLive = true; $('.avatar', el).classList.add('living'); }
// Para autores que no sigues se pregunta por su sala: de a uno, con espera y solo para el video a la vista
let liveCheckAt = 0;
async function checkAuthorLive(it, el) {
  if (!it.author) return;
  const c = liveNow.get(it.author);
  if (c && Date.now() - c.at < 5 * 60e3) { if (c.live) markLiveAvatar(el); return; }
  await new Promise((r) => setTimeout(r, 1500));
  if (currentItem() !== it || Date.now() - liveCheckAt < 3000) return;
  liveCheckAt = Date.now();
  const r = await roomOf(it.author);
  liveNow.set(it.author, { at: Date.now(), live: !!r });
  if (r && el.isConnected) markLiveAvatar(el);
}
setTimeout(refreshFollowLive, 6000);
setInterval(refreshFollowLive, 3 * 60e3);

// ---------- Escribir en el chat y dar me gusta: los hace la web del directo en la página oculta ----------
let liveRid = 0;
const liveWait = new Map();
function liveAct(it, js) {
  if (!state.me) { askLogin(); return Promise.resolve(null); }
  const el = [...state.slides.values()].find((x) => x.item === it);
  if (el) el.liveSession = true;
  return new Promise((resolve) => {
    const rid = ++liveRid;
    liveWait.set(rid, resolve);
    send({ t: 'liveact', rid, url: 'https://www.tiktok.com/@' + it.author + '/live', js });
    setTimeout(() => { if (liveWait.delete(rid)) resolve(null); }, 40000);
  });
}
function onLiveAct(m) { const f = liveWait.get(m.rid); liveWait.delete(m.rid); if (f) f(m.r); }

async function liveChat(it, el) {
  const inp = $('.lv-input', el);
  const text = inp.value.trim();
  if (!text || el.chatSending) return;
  // Un solo envío: el campo queda bloqueado hasta saber qué pasó y no se reintenta nunca
  el.chatSending = true;
  inp.value = '';
  inp.disabled = true;
  const key = JSON.stringify(text), path = JSON.stringify('/@' + it.author + '/live');
  // 1) Escribir en el campo de la web (comprobando que tomó el texto) y tocar su Enviar, en el live correcto
  let r = await liveAct(it, `(() => {
    if (location.pathname !== ${path}) return 'err:otro live';
    const f = document.querySelector('[data-e2e="room-chat-input-field"]'), b = document.querySelector('[data-e2e="room-chat-send-btn"]');
    if (!f || !b) return null;
    if (window.__tdLast === ${key} && Date.now() - window.__tdLastAt < 5000) return 'dup';
    window.__tdLast = ${key}; window.__tdLastAt = Date.now();
    window.__tdAlerts = () => [...document.querySelectorAll('[role="alert"], [class*="toast" i]')].map((e) => (e.textContent || '').trim()).filter((x) => x && x.length < 160);
    window.__tdErr0 = new Set(window.__tdAlerts());
    f.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, ${key});
    if ((f.textContent || '').trim() !== ${key}) {
      f.textContent = ${key};
      f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${key} }));
    }
    if ((f.textContent || '').trim() !== ${key}) return 'err:el campo no aceptó el texto';
    setTimeout(() => b.click(), 120);
    return 'queued';
  })()`);
  // 2) Confirmar en la propia web: el mensaje aparece en su chat, o se lee el aviso de error que muestre
  if (r === 'queued') r = await liveAct(it, `(() => {
    const mine = [...document.querySelectorAll('[data-e2e="chat-message"]')].slice(-20).some((m) => (m.textContent || '').includes(${key}));
    if (mine) return 'ok';
    // Solo cuentan los avisos que aparecieron después de tocar Enviar
    const err = (window.__tdAlerts ? window.__tdAlerts() : []).filter((x) => !window.__tdErr0.has(x) && !x.includes(${key})).join(' | ');
    return err ? 'err:' + err.slice(0, 150) : null;
  })()`);
  el.chatSending = false;
  inp.disabled = false;
  inp.focus();
  log('live chat @' + it.author + ': ' + r);
  if (r === 'ok' || r === 'dup') { expectEcho(el, it, text); return; }
  inp.value = text;
  toast(r && r.startsWith('err:') ? t('TikTok no aceptó el mensaje: {0}', r.slice(4)) : t('No se pudo confirmar el envío del mensaje'));
}
// El mensaje propio aparece cuando llega por el chat en vivo (sin eco local); si el servidor no lo devuelve, se avisa
function expectEcho(el, it, text) {
  const box = $('.lv-chat', el);
  const has = () => $$('.lv-msg span', box).some((s) => s.textContent === text);
  setTimeout(() => { if (el.isConnected && el.liveGen && !has()) toast(t('Tu mensaje no aparece en el chat del directo: puede que el creador limite los comentarios')); }, 12000);
}

// Me gusta: se suman los toques y se mandan juntos (como la app, que agrupa los corazones)
function liveLike(it) {
  const el = [...state.slides.values()].find((x) => x.item === it);
  if (!el) return;
  it.likeCount = (it.likeCount || 0) + 1;
  $('.lv-likes i', el).textContent = fmt(it.likeCount);
  const h = $('.lv-like', el);
  h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop');
  el.likePending = (el.likePending || 0) + 1;
  clearTimeout(el.likeTimer);
  el.likeTimer = setTimeout(async () => {
    const n = el.likePending; el.likePending = 0;
    const r = await liveAct(it, `(() => { const b = document.querySelector('[data-e2e="room-chat-like-btn"]'); if (!b) return null; for (let i = 0; i < ${n}; i++) b.click(); return 'ok'; })()`);
    if (r !== 'ok') toast(t('No se pudo dar me gusta'));
  }, 700);
}
