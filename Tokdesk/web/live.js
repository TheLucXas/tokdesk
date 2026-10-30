'use strict';
// ---------- LIVE dentro de la app ----------
// Los directos llegan en FLV (el HLS nativo de Chromium no los decodifica): los reproduce mpegts.js.
// Fuentes medidas desde la web: webcast/feed canal 87 = recomendados, canal 81 = seguidos en vivo ahora,
// /api-live/user/room/ = la sala de un usuario.

function flvOf(streamData) {
  try {
    const sd = JSON.parse(streamData).data;
    return ['hd', 'sd', 'ld', 'origin'].map((q) => sd[q] && sd[q].main && sd[q].main.flv).find(Boolean) || null;
  } catch { return null; }
}

function liveItem(room) {
  const ow = room.owner || {};
  const su = room.stream_url || {};
  const fp = su.flv_pull_url || {};
  const flv = flvOf(su.live_core_sdk_data && su.live_core_sdk_data.pull_data && su.live_core_sdk_data.pull_data.stream_data)
    || fp.HD1 || fp.SD1 || fp.FULL_HD1 || fp.SD2 || null;
  return {
    id: 'live' + (room.id_str || room.id), live: true, src: null, photos: [], flv,
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
  return { flv: flvOf(lr.streamData && lr.streamData.pull_data && lr.streamData.pull_data.stream_data), title: lr.title,
    viewers: lr.liveRoomStats && lr.liveRoomStats.userCount, cover: lr.coverUrl, user: d.user || {} };
}

async function startLive(el, it) {
  if (el.livePlayer || el.liveStarting) return;
  el.liveStarting = true;
  if (!it.flv && it.author) { const r = await roomOf(it.author); if (r) { it.flv = r.flv; it.viewers = r.viewers || it.viewers; } }
  el.liveStarting = false;
  if (!el.isConnected || currentItem() !== it) return;
  if (!it.flv || !window.mpegts) { el.classList.remove('waiting'); el.classList.add('live-ended'); return; }
  const v = el.media;
  const p = mpegts.createPlayer({ type: 'flv', isLive: true, url: it.flv }, { enableWorker: false, liveBufferLatencyChasing: true });
  p.on(mpegts.Events.ERROR, (a, b) => { log('live: ' + a + ' ' + b); el.classList.add('live-ended'); });
  p.attachMediaElement(v);
  p.load();
  el.livePlayer = p;
  v.muted = state.muted; v.volume = state.volume;
  v.addEventListener('playing', () => el.classList.remove('waiting', 'paused'), { once: true });
  v.play().catch(() => {});
}

function stopLive(el) {
  if (!el.livePlayer) return;
  try { el.livePlayer.pause(); el.livePlayer.unload(); el.livePlayer.detachMediaElement(); el.livePlayer.destroy(); } catch { }
  el.livePlayer = null;
}

async function openLiveOf(uniqueId) {
  const r = await roomOf(uniqueId);
  if (!r) { toast(t('La transmisión terminó')); return; }
  const u = r.user;
  const it = { id: 'live' + u.roomId, live: true, src: null, photos: [], flv: r.flv, cover: r.cover || u.avatarLarger, ratio: 16 / 9,
    author: u.uniqueId, nick: u.nickname, avatar: u.avatarThumb, authorId: u.id, secUid: u.secUid, desc: r.title || '', music: '',
    likes: 0, comments: 0, saves: 0, shares: 0, plays: 0, viewers: r.viewers || 0, subtitles: [], liked: false, saved: false,
    followed: u.followStatus === 1, lang: '' };
  const f = feedFor('liveone:' + uniqueId);
  f.items = [it]; f.ids = new Set([it.id]);
  openSubFeed(f, 0);
}

// Botón LIVE arriba a la izquierda, como en la app
$('#btnLive').innerHTML = '<span class="livetv">LIVE</span>';
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
