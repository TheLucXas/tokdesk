'use strict';

const host = window.chrome && window.chrome.webview;
const send = (m) => host && host.postMessage(m);
const log = (m) => send({ t: 'log', m: String(m) });
window.addEventListener('error', (e) => log('JS: ' + e.message + ' @' + e.lineno));

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pager = $('#pager');
const KEEP_BEHIND = 1, KEEP_AHEAD = 3, MORE_WHEN_LEFT = 5;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Preferencias locales (si el almacenamiento falla, se usan los valores por defecto)
const pref = {
  get(k, d) { try { const v = localStorage.getItem('tp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tp.' + k, JSON.stringify(v)); } catch { } },
};

// Preferencias de la interfaz (se editan desde Configuración, en settings.js)
const opt = Object.assign({
  theme: 'dark', accent: '#fe2c55', fit: 'contain', dataSaver: false, preload: 2, dblLike: true,
  showCounts: true, showDisc: true, progressAlways: false, reduceMotion: false, wheel: 40,
  startMuted: false, bgPlay: true, hotkeys: {}, themes: [], activeTheme: '', lang: 'auto',
}, pref.get('opt', {}));
function saveOpt() { pref.set('opt', opt); }
const state = {
  feed: null,                  // feed actual
  stack: [],                   // feeds anteriores (al entrar a un perfil o búsqueda)
  slides: new Map(),           // índice -> elemento
  muted: opt.startMuted || pref.get('muted', false),
  volume: pref.get('volume', 1),
  speed: pref.get('speed', 1),
  auto: pref.get('auto', false),
  cc: pref.get('cc', false),
  bgAudio: pref.get('bgAudio', false),
  cmtDislikes: new Set(pref.get('cmtDislikes', [])),
  me: null,
  comments: new Map(),         // id -> { list, cursor, hasMore, total, loading, replies }
  sheetFor: null,
  replyTo: null,
  chats: null,                 // null = sin cargar, [] = vacío
  profileKey: null,
};

// ---------- Formato ----------
// Formato de la app en español: 2909, 23,1 mil, 1,2 M
function fmt(n) {
  n = Number(n) || 0;
  const d = (x) => x.toFixed(1).replace('.0', '').replace('.', ',');
  if (n >= 1e9) return d(n / 1e9) + ' mil M';
  if (n >= 1e6) return d(n / 1e6) + ' mill.';
  if (n >= 1e4) return d(n / 1e3) + ' mil';
  return String(n);
}
function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d';
  const d = new Date(ts * 1000);
  return d.getDate() + '-' + (d.getMonth() + 1) + (d.getFullYear() !== new Date().getFullYear() ? '-' + d.getFullYear() : '');
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Hashtags y menciones quedan como enlaces internos
const richText = (s) => esc(s).replace(/([#@])([\p{L}\p{N}_.]+)/gu,
  (_, p, w) => `<b class="${p === '#' ? 'tag' : 'mention'}" data-v="${w}">${p}${w}</b>`);
const linkOf = (it) => `https://www.tiktok.com/@${it.author}/video/${it.id}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

// ---------- Pedidos a la API (los hace la página oficial oculta) ----------
let rid = 0;
const waiting = new Map();
function api(m, path, q = {}) {
  return new Promise((resolve) => {
    const id = ++rid;
    waiting.set(id, resolve);
    const qs = {};
    for (const k in q) if (q[k] != null) qs[k] = String(q[k]);
    send({ t: 'api', rid: id, m, path, q: qs });
    setTimeout(() => { if (waiting.delete(id)) resolve({ status: 0, data: null }); }, 25000);
  });
}
function onApi(msg) {
  const resolve = waiting.get(msg.rid);
  if (!resolve) return;
  waiting.delete(msg.rid);
  let data = null;
  try { data = msg.body ? JSON.parse(msg.body) : null; } catch { }
  resolve({ status: msg.status, data });
}

function askLogin() {
  toast(t('Inicia sesión para usar esta función'));
  setTimeout(() => send({ t: 'login' }), 700);
}

// Acción con sesión: devuelve la respuesta si status_code es 0, o null
async function act(path, q) {
  if (!state.me) { askLogin(); return null; }
  const r = await api('POST', path, q);
  const d = r.data;
  const code = d && (d.status_code ?? d.statusCode);
  if (code !== 0) {
    log(`${path} -> ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
    toast((d && (d.status_msg || d.statusMsg)) || t('No se pudo completar'));
    return null;
  }
  return d;
}

// ---------- Feeds ----------
const feeds = new Map();

function makeFeed(key, opts) {
  const f = { key, items: [], ids: new Set(), idx: 0, cursor: 0, hasMore: true, loading: false, error: false, ...opts };
  feeds.set(key, f);
  return f;
}

async function loadPaged(f, path, q, cursorKey = 'cursor') {
  if (f.loading || !f.hasMore) return;
  f.loading = true;
  const r = await api('GET', path, { ...q, [cursorKey]: f.cursor });
  f.loading = false;
  const d = r.data;
  if (!d) { f.hasMore = false; f.error = true; feedChanged(f); return; }
  const list = d.itemList || d.item_list || (Array.isArray(d.data) ? d.data.map((x) => x.item).filter(Boolean) : []);
  addItems(f, list);
  f.cursor = d.cursor ?? (f.cursor + list.length);
  if (d.level != null) f.level = d.level;
  f.hasMore = !!(d.hasMore ?? d.has_more) && list.length > 0;
  feedChanged(f);
}

function feedFor(key) {
  if (feeds.has(key)) return feeds.get(key);
  const [kind, arg] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
  switch (kind) {
    case 'foryou': return makeFeed(key, { title: t('Para ti'), load(f) { if (!f.loading) { f.loading = true; send({ t: 'more' }); setTimeout(() => { f.loading = false; }, 8000); } } });
    case 'explore': return makeFeed(key, { title: t('Explorar'), load: (f) => loadPaged(f, '/api/explore/item_list/', { categoryType: 120, count: 16 }) });
    case 'following': return makeFeed(key, { title: t('Siguiendo'), needsLogin: true, load: (f) => loadPaged(f, '/api/following/item_list/', { count: 8, pullType: 1, level: f.level || 1, isResetCounterUsed: true }) });
    case 'friends': return makeFeed(key, { title: t('Amigos'), needsLogin: true, async load(f) {
      // Amigos pagina con dos cursores (vistos y no vistos) en lugar de uno
      if (f.loading || !f.hasMore) return;
      f.loading = true;
      const r = await api('GET', '/api/friends/item_list/', { count: 8, pullType: 1, level: f.level || 1, isResetCounterUsed: true,
        unviewedCursor: f.unviewed || 0, viewedCursor: f.viewed || 0, coverFormat: 2 });
      f.loading = false;
      const d = r.data;
      if (!d || !Array.isArray(d.itemList)) { f.hasMore = false; f.error = !d || (d.status_code ?? d.statusCode) !== 0; feedChanged(f); return; }
      addItems(f, d.itemList);
      f.unviewed = d.unviewedCursor ?? f.unviewed; f.viewed = d.viewedCursor ?? f.viewed;
      if (d.level != null) f.level = d.level;
      f.hasMore = !!d.hasMore && d.itemList.length > 0;
      feedChanged(f);
    } });
    case 'user': return makeFeed(key, { title: '', load: (f) => loadPaged(f, '/api/post/item_list/', { secUid: arg, count: 16, coverFormat: 2 }) });
    case 'reposts': return makeFeed(key, { title: t('Republicados'), load: (f) => loadPaged(f, '/api/repost/item_list/', { secUid: arg, count: 16, coverFormat: 2 }) });
    case 'favorites': return makeFeed(key, { title: t('Favoritos'), load: (f) => loadPaged(f, '/api/user/collect/item_list/', { secUid: arg, count: 16, coverFormat: 2 }) });
    case 'liked': return makeFeed(key, { title: t('Me gusta'), load: (f) => loadPaged(f, '/api/favorite/item_list/', { secUid: arg, count: 16, coverFormat: 2 }) });
    case 'single': return makeFeed(key, { title: t('Video'), hasMore: false, load() { } });
    case 'coll': return makeFeed(key, { title: t('Colección'), load: (f) => loadPaged(f, '/api/collection/item_list/', { collectionId: arg, count: 16, sourceType: 113 }) });
    case 'music': return makeFeed(key, { title: t('Sonido'), load: (f) => loadPaged(f, '/api/music/item_list/', { musicID: arg, count: 16, coverFormat: 2 }) });
    case 'tag': return makeFeed(key, {
      title: '#' + arg,
      async load(f) {
        // Primero se resuelve el id del hashtag a partir del nombre
        if (!f.tagId) {
          if (f.loading) return;
          f.loading = true;
          const r = await api('GET', '/api/challenge/detail/', { challengeName: arg });
          f.loading = false;
          const ch = r.data && r.data.challengeInfo && r.data.challengeInfo.challenge;
          if (!ch) { f.hasMore = false; f.error = true; feedChanged(f); return; }
          f.tagId = ch.id;
        }
        return loadPaged(f, '/api/challenge/item_list/', { challengeID: f.tagId, count: 16, coverFormat: 2 });
      },
    });
    case 'search': return makeFeed(key, { title: arg, load: (f) => loadPaged(f, '/api/search/item/full/', { keyword: arg, count: 12 }, 'offset') });
  }
}

function bestSource(v) {
  const list = (v.bitrateInfo || []).filter((b) => b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length)
    .sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
  return list.length ? list[0].PlayAddr.UrlList[list[0].PlayAddr.UrlList.length - 1] : null;
}

function pickSource(v) {
  const list = (v.bitrateInfo || []).filter((b) => b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length);
  // Preferimos H.264 hasta 1080p: decodificación por GPU garantizada en Chromium
  const h264 = list.filter((b) => !/265|bytevc1/i.test(b.CodecType || '') && (b.PlayAddr.Height || 0) <= 1920);
  h264.sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
  // Ahorro de datos: la versión H.264 más liviana
  if (opt.dataSaver) h264.reverse();
  if (h264.length) return h264[0].PlayAddr.UrlList[h264[0].PlayAddr.UrlList.length - 1];
  return v.playAddr || v.downloadAddr || (list[0] && list[0].PlayAddr.UrlList[0]) || null;
}

function normalize(it) {
  if (!it || it.liveRoomInfo) return null;
  const v = it.video || {};
  const photos = ((it.imagePost && it.imagePost.images) || [])
    .map((im) => im.imageURL && im.imageURL.urlList && im.imageURL.urlList[0]).filter(Boolean);
  const src = photos.length ? null : pickSource(v);
  if (!src && !photos.length) return null;
  const st = it.statsV2 || it.stats || {};
  const a = it.author || {};
  const mu = it.music || {};
  return {
    id: it.id, src, photos,
    cover: v.cover || v.originCover || v.dynamicCover || photos[0],
    author: a.uniqueId, nick: a.nickname, avatar: a.avatarThumb || a.avatarMedium, authorId: a.id, secUid: a.secUid,
    signature: a.signature, authorStats: it.authorStats || null,
    desc: it.desc || '',
    music: [mu.title, mu.authorName].filter(Boolean).join(' · '), musicCover: mu.coverThumb || a.avatarThumb, musicUrl: mu.playUrl,
    musicId: mu.id, musicTitle: mu.title,
    // Para descargar: con marca de agua (la de TikTok) y la de mayor calidad (cualquier códec)
    watermarkSrc: v.downloadAddr || null,
    bestSrc: bestSource(v),
    subtitles: (v.subtitleInfos || []).filter((s) => s.Url && /vtt/i.test(s.Format || 'webvtt'))
      .map((s) => ({ url: s.Url, lang: (s.LanguageCodeName || '').toLowerCase() })),
    reposted: !!it.reposted, reposts: +st.repostCount || 0,
    likes: +st.diggCount || 0, comments: +st.commentCount || 0, saves: +st.collectCount || 0, shares: +st.shareCount || 0,
    plays: +st.playCount || 0, pinned: !!it.isPinnedItem, created: +it.createTime || 0,
    ad: !!it.isAd, liked: !!it.digged, saved: !!it.collected,
    followed: a.relation === 1 || a.relation === 2 || !!it.authorFollowing,
  };
}

function addItems(f, list) {
  let added = 0;
  for (const raw of list || []) {
    const it = normalize(raw);
    if (!it || f.ids.has(it.id)) continue;
    f.ids.add(it.id); f.items.push(it); added++;
  }
  return added;
}

function feedChanged(f) {
  if (f === state.feed) { updateEmpty(); render(); }
  if (state.profileKey === f.key) renderGrid($('#pfGrid'), $('#pfMore'), f);
  if (state.searchKey === f.key) renderGrid($('#searchGrid'), $('#searchMore'), f);
}

function updateEmpty() {
  const f = state.feed;
  const empty = $('#empty');
  if (f.items.length) { empty.classList.add('hidden'); return; }
  empty.classList.remove('hidden');
  if (f.needsLogin && !state.me) {
    $('#emptyText').innerHTML = `${t('Inicia sesión para ver {0}.', esc(f.title))}<br><br><button id="emptyLogin">${t('Iniciar sesión')}</button>`;
    $('#emptyLogin').onclick = () => send({ t: 'login' });
  } else if (!f.hasMore || f.error) {
    $('#emptyText').textContent = f.error ? t('No se pudieron cargar los videos.') : t('No hay videos para mostrar.');
  } else {
    $('#emptyText').textContent = t('Cargando videos…');
  }
  $('.spinner', empty).style.display = f.hasMore && !f.error && !(f.needsLogin && !state.me) ? '' : 'none';
}

function requestMore() {
  const f = state.feed;
  if (f.needsLogin && !state.me) return;
  if (f.hasMore) f.load(f);
}

function teardown() {
  for (const el of state.slides.values()) {
    const m = el.media; m.pause(); m.removeAttribute('src'); m.load();
    clearInterval(el.photoTimer); el.remove();
  }
  state.slides.clear();
}

function setFeed(f, idx) {
  if (state.feed === f && idx == null) return;
  teardown();
  state.feed = f;
  if (idx != null) f.idx = idx;
  const sub = state.stack.length > 0;
  document.body.classList.toggle('sub', sub);
  $('#backTitle').textContent = f.title;
  $$('.tab').forEach((t) => t.classList.toggle('active', !sub && t.dataset.feed === f.key));
  closePanels();
  updateEmpty();
  if (!f.items.length) requestMore();
  render();
}

function switchTab(key) {
  state.stack = [];
  setFeed(feedFor(key));
}

function openSubFeed(f, idx) {
  if (state.feed !== f) state.stack.push(state.feed);
  setFeed(f, idx);
}

function back() {
  if (!state.stack.length) return;
  setFeed(state.stack.pop());
}

// ---------- Slides ----------
function buildSlide(it) {
  const el = document.createElement('div');
  el.className = 'slide paused waiting';
  const photoHtml = it.photos.length
    ? `<div class="photos">${it.photos.map((p, i) => `<img alt="" class="${i ? '' : 'on'}" src="${esc(p)}">`).join('')}</div>
       ${it.photos.length > 1 ? `<button class="photonav prev">‹</button><button class="photonav next">›</button>
       <div class="dots">${it.photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
       <audio loop preload="none"></audio>`
    : `<video playsinline loop preload="none" ${it.cover ? `poster="${esc(it.cover)}"` : ''}></video>`;
  el.innerHTML = `
    <img class="poster" alt="" src="${esc(it.cover)}">
    ${photoHtml}
    <div class="playicon">${ICON.play}</div>
    <div class="loading spinner"></div>
    <div class="shade"></div>
    <div class="rail">
      <div class="avatar ${it.followed ? 'followed' : ''}" title="${t('Ver perfil')}"><img alt="" src="${esc(it.avatar)}"><div class="follow" title="${t('Seguir')}">+</div></div>
      <button class="act like ${it.liked ? 'liked' : ''}" title="${t('Me gusta')}"><span class="ico">${ICON.heart}</span><span class="n">${fmt(it.likes)}</span></button>
      <button class="act cmts" title="${t('Comentarios')}"><span class="ico">${ICON.comment}</span><span>${fmt(it.comments)}</span></button>
      <button class="act save ${it.saved ? 'saved' : ''}" title="${t('Favoritos')}"><span class="ico">${ICON.save}</span><span class="n">${fmt(it.saves)}</span></button>
      <button class="act share ${it.reposted ? 'reposted' : ''}" title="${t('Compartir')}"><span class="ico">${it.reposted ? ICON.repost : ICON.share}</span><span>${fmt(it.shares)}</span></button>
      <div class="disc"><img alt="" src="${esc(it.musicCover)}"></div>
    </div>
    <div class="meta">
      <div class="user">${esc(it.nick || it.author)}${it.created ? `<span class="when"> · ${/\d-/.test(ago(it.created)) ? ago(it.created) : t('hace {0}', ago(it.created))}</span>` : ''}${it.ad ? '<span class="badge">Publicidad</span>' : ''}</div>
      <div class="desc">${richText(it.desc)}</div>
      ${it.music ? `<div class="musicline">${ICON.music}<span>${esc(it.music)}</span></div>` : ''}
    </div>
    <div class="cc"></div>
    <div class="progress"><div class="track"><div class="fill"></div></div></div>`;

  const media = $('video, audio', el);
  el.media = media;
  el.item = it;
  media.muted = state.muted;
  media.volume = state.volume;
  media.loop = !state.auto;
  media.addEventListener('waiting', () => el.classList.add('waiting'));
  media.addEventListener('playing', () => el.classList.remove('waiting', 'paused'));
  media.addEventListener('canplay', () => el.classList.remove('waiting'));
  media.addEventListener('pause', () => el.classList.add('paused'));
  media.addEventListener('loadedmetadata', () => { media.playbackRate = state.speed; });
  media.addEventListener('ended', () => { if (state.auto && el === current()) go(1); });
  media.addEventListener('error', () => {
    if (!media.getAttribute('src')) return;
    const err = media.error;
    log(`media ${it.id} error ${err && err.code}`);
    if (!it.photos.length && el === current()) setTimeout(() => go(1), 300);
  });
  const fill = $('.fill', el);
  const cc = $('.cc', el);
  media.addEventListener('timeupdate', () => {
    if (media.duration) fill.style.width = (media.currentTime / media.duration * 100) + '%';
    if (el.cues && state.cc) {
      const t = media.currentTime;
      const cue = el.cues.find((c) => t >= c.a && t <= c.b);
      const txt = cue ? cue.text : '';
      if (cc.textContent !== txt) { cc.textContent = txt; cc.classList.toggle('show', !!txt); }
    }
  });

  if (it.photos.length) {
    el.classList.remove('waiting');
    el.photo = 0;
    const show = (n) => {
      el.photo = (n + it.photos.length) % it.photos.length;
      $$('.photos img', el).forEach((im, i) => im.classList.toggle('on', i === el.photo));
      $$('.dots i', el).forEach((d, i) => d.classList.toggle('on', i === el.photo));
    };
    el.showPhoto = show;
    $$('.photonav', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); show(el.photo + (b.classList.contains('next') ? 1 : -1));
    }));
  }

  $('.avatar img', el).addEventListener('click', (e) => { e.stopPropagation(); openProfile(it); });
  $('.follow', el).addEventListener('click', (e) => { e.stopPropagation(); follow(it, true); });
  $('.like', el).addEventListener('click', (e) => { e.stopPropagation(); like(it); });
  $('.cmts', el).addEventListener('click', (e) => { e.stopPropagation(); openComments(it); });
  $('.save', el).addEventListener('click', (e) => { e.stopPropagation(); favorite(it); });
  $('.share', el).addEventListener('click', (e) => { e.stopPropagation(); openShare(it); });
  $('.user', el).addEventListener('click', (e) => { e.stopPropagation(); openProfile(it); });
  const desc = $('.desc', el);
  desc.addEventListener('click', (e) => {
    e.stopPropagation();
    const tag = e.target.closest('.tag, .mention');
    if (tag) { tag.classList.contains('tag') ? openTag(tag.dataset.v) : openUserByName(tag.dataset.v); return; }
    desc.classList.toggle('open');
  });
  const ml = $('.musicline', el);
  if (ml) ml.addEventListener('click', (e) => { e.stopPropagation(); openMusic(it); });
  $('.disc', el).addEventListener('click', (e) => { e.stopPropagation(); openMusic(it); });

  const prog = $('.progress', el);
  const seek = (e) => {
    const r = prog.getBoundingClientRect();
    if (media.duration) media.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * media.duration;
  };
  prog.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); prog.setPointerCapture(e.pointerId); seek(e);
    prog.onpointermove = seek;
    prog.onpointerup = () => { prog.onpointermove = null; };
  });
  return el;
}

function place(el, i, dy = 0) {
  el.style.transform = `translateY(calc(${(i - state.feed.idx) * 100}% + ${dy}px))`;
}

// Refresca los contadores y estados de un video en su slide (si está visible)
function refreshSlide(it) {
  for (const el of state.slides.values()) {
    if (el.item !== it && el.item.authorId !== it.authorId) continue;
    const x = el.item;
    $('.like', el).classList.toggle('liked', x.liked);
    $('.like .n', el).textContent = fmt(x.likes);
    $('.save', el).classList.toggle('saved', x.saved);
    $('.save .n', el).textContent = fmt(x.saves);
    $('.avatar', el).classList.toggle('followed', x.followed);
    const sh = $('.share', el);
    sh.classList.toggle('reposted', !!x.reposted);
    $('.ico', sh).innerHTML = x.reposted ? ICON.repost : ICON.share;
  }
}

function render() {
  const f = state.feed;
  if (!f) return;
  const lo = Math.max(0, f.idx - KEEP_BEHIND);
  const hi = Math.min(f.items.length - 1, f.idx + KEEP_AHEAD);

  for (const [i, el] of state.slides) {
    if (i < lo || i > hi || el.item !== f.items[i]) {
      const m = el.media; m.pause(); m.removeAttribute('src'); m.load();
      clearInterval(el.photoTimer);
      el.remove(); state.slides.delete(i);
    }
  }
  for (let i = lo; i <= hi; i++) {
    let el = state.slides.get(i);
    const it = f.items[i];
    if (!el) {
      el = buildSlide(it);
      el.classList.add('dragging'); place(el, i); pager.appendChild(el);
      void el.offsetHeight; el.classList.remove('dragging');
      state.slides.set(i, el);
    }
    place(el, i);
    const m = el.media;
    // Precarga del actual y los siguientes; el resto queda sin fuente para no gastar decodificadores
    const src = it.photos.length ? it.musicUrl : it.src;
    if (src && i >= f.idx && i <= f.idx + opt.preload && !m.getAttribute('src')) { m.preload = 'auto'; m.src = src; }
    if (i === f.idx) {
      m.muted = state.muted; m.volume = state.volume;
      if (state.cc) loadCaptions(el);
      if (m.paused && !el.dataset.userPaused && m.getAttribute('src')) m.play().catch((e) => log('play: ' + e.message));
      if (it.photos.length > 1 && !el.photoTimer) {
        el.photoTimer = setInterval(() => { if (!el.dataset.userPaused) el.showPhoto(el.photo + 1); }, 3500);
      }
      if (it.photos.length && !src) el.classList.remove('paused');
    } else {
      if (!m.paused) m.pause();
      clearInterval(el.photoTimer); el.photoTimer = null;
      delete el.dataset.userPaused;
      if (m.currentTime > 0) m.currentTime = 0;
    }
  }

  if (f.items.length - f.idx <= MORE_WHEN_LEFT) requestMore();
  schedulePrefetchComments();
}

function go(step) {
  const f = state.feed;
  const next = f.idx + step;
  if (next < 0) return;
  if (next >= f.items.length) {
    if (f.hasMore) { requestMore(); toast(t('Cargando más videos…')); } else toast(t('No hay más videos'));
    return;
  }
  f.idx = next;
  closePanels();
  render();
}

function current() { return state.slides.get(state.feed.idx); }
function currentItem() { return state.feed && state.feed.items[state.feed.idx]; }

function togglePause() {
  const el = current(); if (!el) return;
  const m = el.media;
  if (el.dataset.userPaused || m.paused) {
    delete el.dataset.userPaused; el.classList.remove('paused');
    if (m.getAttribute('src')) m.play();
  } else {
    el.dataset.userPaused = '1'; m.pause(); el.classList.add('paused');
  }
}

// ---------- Acciones de cuenta ----------
async function like(it, force) {
  const on = force ?? !it.liked;
  if (on === it.liked) return;
  if (!state.me) return askLogin();
  it.liked = on; it.likes += on ? 1 : -1; refreshSlide(it);
  const ok = await act('/api/commit/item/digg/', { aweme_id: it.id, type: on ? 1 : 0 });
  if (!ok) { it.liked = !on; it.likes += on ? -1 : 1; refreshSlide(it); }
}

async function favorite(it) {
  if (!state.me) return askLogin();
  const on = !it.saved;
  it.saved = on; it.saves += on ? 1 : -1; refreshSlide(it);
  const ok = await act('/api/item/collect/', { aid: 1988, itemId: it.id, action: on ? 1 : 2, secUid: it.secUid });
  if (ok) toast(on ? t('Añadido a Favoritos') : t('Quitado de Favoritos'));
  else { it.saved = !on; it.saves += on ? -1 : 1; refreshSlide(it); }
}

function setFollowed(authorId, on) {
  for (const f of feeds.values()) for (const x of f.items) if (x.authorId === authorId) x.followed = on;
}

async function follow(it, on) {
  if (!state.me) return askLogin();
  setFollowed(it.authorId, on); refreshSlide(it); updateProfileFollow(it);
  const ok = await act('/api/commit/follow/user/', {
    type: on ? 1 : 0, action_type: on ? 1 : 0, user_id: it.authorId, sec_user_id: it.secUid,
    from: 18, channel_id: 3, from_pre: 0, fromWeb: 1,
  });
  if (ok) toast(on ? t('Siguiendo a {0}', it.nick || it.author) : t('Dejaste de seguir'));
  else { setFollowed(it.authorId, !on); refreshSlide(it); updateProfileFollow(it); }
}

async function notInterested(it) {
  if (!state.me) return askLogin();
  closePanels();
  const ok = await act('/api/dislike/item/', { item_id: it.id, item_author_id: it.authorId });
  if (!ok) return;
  toast(t('Verás menos videos como este'));
  const f = state.feed;
  const i = f.items.indexOf(it);
  if (i < 0) return;
  teardown();
  f.items.splice(i, 1);
  if (f.idx >= f.items.length) f.idx = Math.max(0, f.items.length - 1);
  render();
}

function download(it) { openDownloadMenu(it); }

function copyLink(it) {
  navigator.clipboard.writeText(linkOf(it)).then(() => toast(t('Enlace copiado')), () => toast(t('No se pudo copiar')));
}

function report(it) { closePanels(); send({ t: 'report', url: linkOf(it) }); }

function setSpeed(s) {
  state.speed = s; pref.set('speed', s);
  for (const el of state.slides.values()) { el.media.playbackRate = s; el.media.defaultPlaybackRate = s; }
  const b = $('#speedBadge');
  b.textContent = s + 'x'; b.classList.toggle('show', s !== 1);
  toast(t('Velocidad') + ' ' + s + '×');
}
function stepSpeed(d) {
  const i = SPEEDS.indexOf(state.speed);
  setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + d))]);
}

function setAuto(on) {
  state.auto = on; pref.set('auto', on);
  for (const el of state.slides.values()) el.media.loop = !on;
  toast(on ? t('Desplazamiento automático activado') : t('Desplazamiento automático desactivado'));
}

function toggleClean() {
  document.body.classList.toggle('clean');
  closePanels();
}

function setMuted(m) {
  state.muted = m; pref.set('muted', m);
  for (const el of state.slides.values()) el.media.muted = m;
  $('#btnMute').innerHTML = m || state.volume === 0 ? ICON.muted : ICON.sound;
}

function setVolume(v) {
  state.volume = v; pref.set('volume', v);
  for (const el of state.slides.values()) el.media.volume = v;
  $('#vol').value = Math.round(v * 100);
  if (v > 0 && state.muted) setMuted(false); else setMuted(state.muted);
}

// ---------- Subtítulos ----------
let textRid = 0;
const textWaiting = new Map();
function fetchText(url) {
  return new Promise((resolve) => {
    const id = ++textRid;
    textWaiting.set(id, resolve);
    send({ t: 'text', rid: id, url });
    setTimeout(() => { if (textWaiting.delete(id)) resolve(null); }, 15000);
  });
}

function parseVtt(src) {
  const toSec = (s) => s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p.replace(',', '.')), 0);
  const cues = [];
  for (const block of src.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((x) => toSec(x.trim().split(' ')[0]));
    const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ a, b, text });
  }
  return cues;
}

async function loadCaptions(el) {
  const it = el.item;
  if (el.cues || el.cuesLoading || !it.subtitles.length) return;
  el.cuesLoading = true;
  const lang = (navigator.language || 'es').slice(0, 2);
  const sub = it.subtitles.find((s) => s.lang.startsWith(lang)) || it.subtitles[0];
  const body = await fetchText(sub.url);
  el.cues = body ? parseVtt(body) : [];
}

function setCaptions(on) {
  state.cc = on; pref.set('cc', on);
  if (!on) $$('.slide .cc').forEach((c) => { c.textContent = t(''); c.classList.remove('show'); });
  else { const el = current(); if (el) loadCaptions(el); }
  const it = currentItem();
  toast(on ? (it && !it.subtitles.length ? t('Subtítulos activados (este video no tiene)') : t('Subtítulos activados')) : t('Subtítulos desactivados'));
}

// ---------- Hashtags, sonidos y perfiles por nombre ----------
function openTag(name) { closePanels(); openSubFeed(feedFor('tag:' + name), 0); }

function openMusic(it) {
  if (!it.musicId) return;
  closePanels();
  const f = feedFor('music:' + it.musicId);
  f.title = '♫ ' + (it.musicTitle || t('Sonido'));
  openSubFeed(f, 0);
}

async function openUserByName(name) {
  const r = await api('GET', '/api/user/detail/', { uniqueId: name });
  const u = r.data && r.data.userInfo && r.data.userInfo.user;
  if (!u) { toast(t('No se encontró @{0}', name)); return; }
  const st = (r.data.userInfo.stats) || {};
  openProfile({ secUid: u.secUid, author: u.uniqueId, nick: u.nickname, avatar: u.avatarThumb, authorId: u.id,
    signature: u.signature, authorStats: st, followed: u.relation === 1 || u.relation === 2 });
}

// ---------- Republicar ----------
async function repost(it) {
  if (!state.me) return askLogin();
  const on = !it.reposted;
  // Respuesta inmediata como en la app; se revierte si TikTok rechaza el pedido
  it.reposted = on; it.reposts += on ? 1 : -1; refreshSlide(it);
  notice(on ? t('Republicaste este video') : t('Se quitó la republicación'), on ? t('Deshacer') : null, on ? () => repost(it) : null);
  const ok = await act(on ? '/tiktok/v1/upvote/publish' : '/tiktok/v1/upvote/delete', { item_id: it.id });
  if (!ok) { it.reposted = !on; it.reposts += on ? -1 : 1; refreshSlide(it); }
}
// ---------- Ayuda ----------
function openHelp() {
  const keys = [
    [t('↑ / ↓, rueda, arrastrar'), t('Video anterior / siguiente')], [t('Espacio, clic'), t('Pausar')], [t('Doble clic, L'), t('Me gusta')],
    ['C', t('Comentarios')], ['S', t('Compartir')], ['P', t('Perfil del autor')], ['M', t('Silenciar')], ['← / →', t('Retroceder / adelantar 5 s')],
    ['< / >', t('Velocidad')], ['T', t('Subtítulos')], ['H', t('Pantalla limpia')], ['/', t('Buscar')], ['F', t('Maximizar')],
    [t('Esc, Retroceso'), t('Volver / cerrar')], [t('Clic derecho'), t('Más opciones')], ['?', t('Esta ayuda')],
  ];
  $('#helpList').innerHTML = keys.map(([k, d]) => `<div class="hk"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('');
  openPanel('help');
}

// ---------- Paneles ----------
function openPanel(id) {
  $$('.panel.open').forEach((p) => { if (p.id !== id) p.classList.remove('open'); });
  $('#' + id).classList.add('open');
  $('#scrim').classList.toggle('show', id !== 'search');
  hideCtx();
}
function closePanels() {
  const wasInbox = $('#inbox').classList.contains('open');
  $$('.panel.open').forEach((p) => p.classList.remove('open'));
  $('#scrim').classList.remove('show');
  state.sheetFor = null;
  state.profileKey = null;
  state.searchKey = null;
  document.body.classList.remove('cmt-open');
  setReply(null);
  hideCtx();
  if (chatConv) closeChat();
  else if (wasInbox) send({ t: 'chatvis', on: false });
}
function anyPanelOpen() { return !!$('.panel.open'); }
$$('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
// En las filas horizontales de compartir, la rueda desplaza hacia los lados
$$('.row.scroll').forEach((r) => r.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { r.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false }));
$('#scrim').addEventListener('click', closePanels);

// ---------- Entrada: rueda, teclado, arrastre, clic ----------
let wheelLock = 0, wheelAcc = 0, wheelIdle;
window.addEventListener('wheel', (e) => {
  if (anyPanelOpen() || e.target.closest('.desc.open, #ctx, #volwrap')) return;
  e.preventDefault();
  clearTimeout(wheelIdle);
  wheelIdle = setTimeout(() => { wheelAcc = 0; }, 160);
  const now = performance.now();
  if (now < wheelLock) return;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= opt.wheel) {
    go(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0; wheelLock = now + 380;
  }
}, { passive: false });

// Las acciones y sus teclas (personalizables) están en settings.js
window.addEventListener('keydown', (e) => {
  if (captureHotkey(e)) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') { e.target.blur(); closePanels(); }
    return;
  }
  if (e.key === 'Escape') {
    if (anyPanelOpen() || $('#ctx').classList.contains('show')) closePanels();
    else if (document.body.classList.contains('clean')) toggleClean();
    else back();
    e.preventDefault();
    return;
  }
  if (e.key === 'Backspace') { back(); e.preventDefault(); return; }
  const action = hotkeyAction(e);
  if (!action) return;
  runAction(action);
  e.preventDefault();
});
let drag = null, clickTimer = null;
pager.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.rail, .meta, .progress, .photonav')) return;
  hideCtx();
  drag = { y: e.clientY, x: e.clientX, dy: 0, dx: 0, moved: false, id: e.pointerId };
  // Mantener presionado abre las opciones, como en la app
  const d = drag;
  d.hold = setTimeout(() => { if (drag === d && !d.moved) { d.long = true; openVideoOptions(currentItem()); } }, 550);
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.dy = e.clientY - drag.y;
  drag.dx = e.clientX - drag.x;
  if (Math.abs(drag.dx) > 12) clearTimeout(drag.hold);
  if (!drag.moved && Math.abs(drag.dy) > 8) {
    clearTimeout(drag.hold);
    drag.moved = true; pager.setPointerCapture(drag.id);
    for (const el of state.slides.values()) el.classList.add('dragging');
  }
  if (drag.moved) for (const [i, el] of state.slides) place(el, i, drag.dy);
});
window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  clearTimeout(d.hold);
  if (d.long) return;
  // Deslizar hacia la izquierda abre el perfil del autor, como en la app
  if (!d.moved && d.dx < -80 && Math.abs(d.dx) > Math.abs(d.dy) * 1.5) { const it = currentItem(); if (it) openProfile(it); return; }
  if (!d.moved && Math.abs(d.dx) > 12) return;
  if (d.moved) {
    for (const el of state.slides.values()) el.classList.remove('dragging');
    const h = pager.clientHeight;
    if (d.dy < -h * 0.15) go(1); else if (d.dy > h * 0.15) go(-1); else render();
    return;
  }
  // Clic simple = pausa; doble clic = me gusta (se espera un poco para distinguirlos)
  if (clickTimer || !opt.dblLike) {
    if (!clickTimer) { togglePause(); return; }
    clearTimeout(clickTimer); clickTimer = null;
    const el = current(); if (!el) return;
    like(el.item, true);
    const b = document.createElement('div');
    b.className = 'burst'; b.innerHTML = ICON.heart;
    b.style.left = e.clientX + 'px'; b.style.top = e.clientY + 'px';
    el.appendChild(b); setTimeout(() => b.remove(), 800);
  } else {
    clickTimer = setTimeout(() => { clickTimer = null; togglePause(); }, 230);
  }
});

// ---------- Hoja de opciones (mantener presionado o clic derecho), como en la app ----------
function hideCtx() { $('#ctx').classList.remove('show'); }

// groups: [[{ ic, label, fn, toggle?, on?, danger?, seg? }]]
function openOptions(groups) {
  const body = $('#optsBody');
  body.innerHTML = '';
  for (const g of groups) {
    const box = document.createElement('div');
    box.className = 'og';
    for (const x of g.filter(Boolean)) {
      const b = document.createElement('button');
      b.className = 'oi' + (x.danger ? ' danger' : '');
      b.innerHTML = `${ICON[x.ic] || ''}<span>${esc(x.label)}</span>`;
      if (x.toggle) {
        const sw = document.createElement('span');
        sw.className = 'sw' + (x.on ? ' on' : '');
        b.appendChild(sw);
        b.onclick = () => { const on = !sw.classList.contains('on'); sw.classList.toggle('on', on); x.fn(on); };
      } else if (x.seg) {
        const seg = document.createElement('span');
        seg.className = 'seg';
        for (const [v, l] of x.seg) {
          const sb = document.createElement('button');
          sb.textContent = l;
          sb.classList.toggle('on', v === x.value);
          sb.onclick = (e) => {
            e.stopPropagation();
            $$('button', seg).forEach((o) => o.classList.toggle('on', o === sb));
            x.fn(v);
          };
          seg.appendChild(sb);
        }
        b.appendChild(seg);
      } else {
        b.onclick = () => { closePanels(); x.fn(); };
      }
      box.appendChild(b);
    }
    body.appendChild(box);
  }
  openPanel('opts');
}

function openVideoOptions(it) {
  if (!it) return;
  openOptions([
    [
      { ic: 'broken', label: t('No me interesa'), fn: () => notInterested(it) },
      { ic: 'flag', label: t('Denunciar'), fn: () => report(it) },
    ],
    [
      { ic: 'speed', label: t('Velocidad'), seg: [[0.5, '0.5×'], [1, '1.0×'], [1.5, '1.5×'], [2, '2.0×']], value: state.speed, fn: setSpeed },
      { ic: 'eyeoff', label: t('Despejar pantalla'), fn: toggleClean },
      { ic: 'autoscroll', label: t('Pasar automáticamente'), toggle: true, on: state.auto, fn: setAuto },
      { ic: 'cc', label: t('Subtítulos'), toggle: true, on: state.cc, fn: setCaptions },
      it.src && { ic: 'pip', label: t('Imagen en imagen'), fn: () => pictureInPicture() },
      { ic: 'pip', label: t('Reproducción en segundo plano'), toggle: true, on: opt.bgPlay, fn: (v) => { opt.bgPlay = v; saveOpt(); applyWinState(); toast(v ? t('Sigue reproduciendo sin foco') : t('Se pausa al usar otra ventana')); } },
      { ic: 'headphones', label: t('Audio de fondo'), toggle: true, on: state.bgAudio, fn: (v) => { setBgAudio(v); applyWinState(); } },
    ], [
      { ic: 'gear', label: t('Configuración'), fn: () => openSettings() },
    ],
    [
      { ic: 'download', label: t('Descargar'), fn: () => download(it) },
      { ic: 'link', label: t('Copiar enlace'), fn: () => copyLink(it) },
      { ic: 'bookmark', label: it.saved ? t('Quitar de Favoritos') : t('Agregar a Favoritos'), fn: () => favorite(it) },
      { ic: 'repost', label: it.reposted ? t('Quitar republicación') : t('Republicar'), fn: () => repost(it) },
      { ic: 'user', label: t('Ver perfil de {0}', it.nick || it.author), fn: () => openProfile(it) },
      { ic: 'globe', label: t('Abrir en el navegador'), fn: () => send({ t: 'open', url: linkOf(it) }) },
      { ic: 'keyboard', label: t('Atajos de teclado'), fn: openHelp },
    ],
  ]);
}

pager.addEventListener('contextmenu', (e) => { e.preventDefault(); openVideoOptions(currentItem()); });
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) hideCtx(); }, true);

async function pictureInPicture() {
  const el = current();
  const v = el && el.media;
  if (!v || v.tagName !== 'VIDEO') return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch (err) { log('PiP: ' + err.message); toast(t('Imagen en imagen no disponible')); }
}

function setBgAudio(on) {
  state.bgAudio = on; pref.set('bgAudio', on);
  toast(on ? t('Audio de fondo activado') : t('Audio de fondo desactivado'));
}

// ---------- Compartir ----------
function openShare(it) {
  state.shareFor = it;
  const link = linkOf(it);
  const enc = encodeURIComponent(link);
  const app = (ic, label, color, fn) => {
    const b = document.createElement('button');
    b.className = 'chip';
    // Las apps externas se muestran con iniciales (sin sus logos, que son marcas registradas)
    const glyph = ic.startsWith('txt:') ? `<b class="ini">${ic.slice(4)}</b>` : ICON[ic];
    b.innerHTML = `<span class="circle ${color === 'gray' ? 'gray' : ''}" style="${color !== 'gray' ? 'background:' + color : ''}">${glyph}</span><span class="lbl">${esc(label)}</span>`;
    b.onclick = fn;
    return b;
  };
  const apps = $('#shareApps'); apps.innerHTML = '';
  apps.append(
    app('repost', it.reposted ? t('Quitar') : t('Compartir'), '#f9b91f', () => { repost(it); closePanels(); }),
    app('txt:WA', 'WhatsApp', '#25d366', () => send({ t: 'open', url: 'https://wa.me/?text=' + enc })),
    app('link', t('Copiar enlace'), '#2b8cff', () => { copyLink(it); closePanels(); }),
    app('txt:TG', 'Telegram', '#2aabee', () => send({ t: 'open', url: 'https://t.me/share/url?url=' + enc })),
    app('txt:FB', 'Facebook', '#1877f2', () => send({ t: 'open', url: 'https://www.facebook.com/sharer/sharer.php?u=' + enc })),
    app('txt:X', 'X', '#000', () => send({ t: 'open', url: 'https://twitter.com/intent/tweet?url=' + enc })),
    app('mail', t('Correo'), '#7a7a7a', () => send({ t: 'open', url: 'mailto:?body=' + enc })),
    app('globe', t('Navegador'), '#555', () => send({ t: 'open', url: link })),
  );
  const acts = $('#shareActs'); acts.innerHTML = '';
  acts.append(
    app('flag', t('Denunciar'), 'gray', () => report(it)),
    app('broken', t('No me interesa'), 'gray', () => notInterested(it)),
    app('download', t('Descargar'), 'gray', () => { download(it); closePanels(); }),
    app('bookmark', it.saved ? t('Quitar de Favoritos') : t('Agregar a Favoritos'), 'gray', () => { favorite(it); closePanels(); }),
    app('speed', t('Velocidad') + ' ' + state.speed + '×', 'gray', (e) => {
      const i = SPEEDS.indexOf(state.speed);
      setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
      $('.lbl', e.currentTarget).textContent = t('Velocidad') + ' ' + state.speed + '×';
    }),
    app('eyeoff', t('Despejar pantalla'), 'gray', toggleClean),
    app('cc', t('Subtítulos'), 'gray', () => setCaptions(!state.cc)),
    app('pip', t('Imagen en imagen'), 'gray', () => { closePanels(); pictureInPicture(); }),
  );
  $('#friendFilter').value = '';
  $('#friendFilter').classList.remove('show');
  renderFriends();
  if (state.me && (state.chats == null || !state.chats.length)) loadInbox();
  openPanel('share');
}
$('#friendSearch').addEventListener('click', () => {
  const f = $('#friendFilter');
  f.classList.toggle('show');
  if (f.classList.contains('show')) f.focus(); else { f.value = ''; renderFriends(); }
});
$('#friendFilter').addEventListener('input', () => renderFriends());

function renderFriends() {
  const box = $('#friends');
  if (!state.me) {
    box.innerHTML = `<div class="friends-msg">${t('Para enviar a tus amigos,')} <button id="frLogin">${t('inicia sesión')}</button>.</div>`;
    $('#frLogin').onclick = () => send({ t: 'login' });
    return;
  }
  if (state.chats === 'loading' || state.chats == null) {
    box.innerHTML = '<div class="friends-msg"><div class="spinner"></div></div>';
    return;
  }
  if (!state.chats.length) {
    box.innerHTML = `<div class="friends-msg">${t('No se encontraron chats.')} <button id="frRetry">${t('Reintentar')}</button></div>`;
    $('#frRetry').onclick = () => loadInbox();
    return;
  }
  box.innerHTML = '';
  const q = $('#friendFilter').value.trim().toLowerCase();
  for (const c of state.chats.filter((x) => !q || x.name.toLowerCase().includes(q))) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = `<img alt="" src="${esc(c.avatar)}"><span class="lbl">${esc(c.name)}</span>`;
    b.onclick = () => {
      if (b.classList.contains('sent') || !state.shareFor) return;
      $('.lbl', b).textContent = t('Enviando…');
      sendDm(c.id, linkOf(state.shareFor), (ok) => {
        if (ok) { b.classList.add('sent'); $('.lbl', b).textContent = t('Enviado'); }
        else { $('.lbl', b).textContent = c.name; toast(t('No se pudo enviar')); }
      });
    };
    box.appendChild(b);
  }
}

// Envío de mensajes: uno a la vez, porque los hace la misma página oficial oculta
const dmQueue = [];
function sendDm(id, text, cb) {
  dmQueue.push({ id, text, cb });
  if (dmQueue.length === 1) send({ t: 'dm', id, text });
}
function onDm(m) {
  const job = dmQueue.shift();
  if (job) job.cb(m.ok);
  if (dmQueue.length) send({ t: 'dm', id: dmQueue[0].id, text: dmQueue[0].text });
}

// ---------- Bandeja y chats ----------
let inboxData = null;
function loadInbox() {
  if (!state.me) return;
  if (state.chats !== 'loading') { state.chats = 'loading'; send({ t: 'inbox' }); }
  renderFriends();
}

function onInbox(m) {
  const before = inboxData ? inboxData.convs.length : 0;
  if (m.more) {
    inboxMoreBusy = false;
    const sp = $('#ibMore'); if (sp) sp.remove();
    if (!m.data) { inboxNoMore = true; return; }
  }
  try { inboxData = m.data ? JSON.parse(m.data) : { convs: [], activity: [] }; } catch { inboxData = { convs: [], activity: [] }; }
  state.chats = inboxData.convs || [];
  if (m.more && state.chats.length <= before) inboxNoMore = true;
  renderFriends();
  renderInbox();
  const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
  const badge = $('#inboxBadge');
  badge.textContent = unread > 99 ? '99+' : unread || '';
  badge.classList.toggle('show', unread > 0);
}

// Revisa la bandeja cada minuto para mostrar los mensajes sin leer
setInterval(() => {
  if (state.me && !dmQueue.length && !chatConv && state.chats !== 'loading') loadInbox();
}, 60000);

function openInbox() {
  if (!state.me) return askLogin();
  openPanel('inbox');
  send({ t: 'chatvis', on: true });
  renderInbox();
  loadInbox();
}

function renderInbox() {
  const body = $('#ibBody');
  if (!$('#inbox').classList.contains('open')) return;
  if (!inboxData) { body.innerHTML = '<div class="sheet-msg"><div class="spinner"></div></div>'; return; }
  const acts = inboxData.activity || [];
  const q = $('#ibFilter').value.trim().toLowerCase();
  const convs = (inboxData.convs || []).filter((c) => !q || c.name.toLowerCase().includes(q));
  const follows = acts.filter(isFollowActivity);
  const others = acts.filter((a) => !isFollowActivity(a));
  let html = '';
  if (!q) {
    // Filas fijas como en la app: Nuevos seguidores y Actividad
    html += `<button class="ib-item ib-fixed" data-act="follows"><span class="ic blue">${ICON.friends}</span>
      <div class="tx"><div class="nm">${t('Nuevos seguidores')}</div><div class="ls">${esc(follows[0] ? actLine(follows[0]) : t('Consulta tus nuevos seguidores aquí.'))}</div></div></button>`;
    html += `<button class="ib-item ib-fixed" data-act="all"><span class="ic red">${ICON.heart}</span>
      <div class="tx"><div class="nm">${t('Actividad')}</div><div class="ls">${esc(others[0] ? actLine(others[0]) : t('Me gusta, comentarios y menciones'))}</div></div></button>`;
  }
  html += convs.length ? convs.map((c) => `<button class="ib-item ${c.unread ? 'unread' : ''}" data-id="${esc(c.id)}">
      <img class="av" alt="" src="${esc(c.avatar)}">
      <div class="tx"><div class="nm">${esc(c.name)}</div><div class="ls">${esc(c.last)}${c.time ? ' · ' + esc(c.time) : ''}</div></div>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</button>`).join('')
    : `<div class="sheet-msg">${q ? t('Sin resultados.') : t('No hay conversaciones.')}</div>`;
  const keep = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = keep;
  $$('button.ib-item[data-id]', body).forEach((b) => b.onclick = () => openChat(convs.find((c) => c.id === b.dataset.id)));
  $$('button.ib-fixed', body).forEach((b) => b.onclick = () => openActivity(b.dataset.act));
}

const isFollowActivity = (a) => /seguir|seguidor|follow/i.test(a.title + ' ' + a.content);
const actLine = (a) => [a.title, a.content].filter(Boolean).join(' ');

$('#ibSearchBtn').addEventListener('click', () => {
  const f = $('#ibFilter');
  f.classList.toggle('show');
  if (f.classList.contains('show')) f.focus(); else { f.value = ''; renderInbox(); }
});
$('#ibFilter').addEventListener('input', renderInbox);

function openActivity(kind) {
  const acts = (inboxData && inboxData.activity) || [];
  const list = kind === 'follows' ? acts.filter(isFollowActivity) : acts;
  $('#actTitle').textContent = kind === 'follows' ? t('Nuevos seguidores') : t('Actividad');
  $('#actBody').innerHTML = list.length ? list.map((a) => {
    // El contenido suele terminar con la fecha ("... 16 oct"); se separa para mostrarla en gris
    const m = /^(.*?)(\s*(?:\d{1,2}[-/ ]\w+|\d+\s*(?:min|h|d|sem)\.?|hace .+))$/i.exec(a.content || '');
    const text = m ? m[1] : a.content;
    const date = m ? m[2].trim() : '';
    return `<div class="act-row"><img class="av" alt="" src="${esc(a.avatar)}">
      <div class="tx"><b>${esc(a.title)}</b> ${esc(text)} ${date ? `<span class="dt">${esc(date)}</span>` : ''}</div>
      ${a.thumb && a.thumb !== a.avatar ? `<img class="th" alt="" src="${esc(a.thumb)}">` : ''}</div>`;
  }).join('') : `<div class="sheet-msg">${t('No hay actividad reciente.')}</div>`;
  $('#activity').classList.add('open');
}
$('#actBack').addEventListener('click', () => $('#activity').classList.remove('open'));

// Al llegar al final de la lista se piden conversaciones más antiguas
let inboxMoreBusy = false, inboxNoMore = false;
$('#ibBody').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  if (inboxMoreBusy || inboxNoMore || !inboxData || l.scrollTop + l.clientHeight < l.scrollHeight - 200) return;
  inboxMoreBusy = true;
  l.insertAdjacentHTML('beforeend', '<div class="sheet-msg" id="ibMore"><div class="spinner"></div></div>');
  send({ t: 'inboxmore' });
});
$('#ibRefresh').addEventListener('click', () => { inboxData = null; renderInbox(); loadInbox(); });

let chatConv = null, chatTimer = null, chatCount = -1;
function openChat(c) {
  chatConv = c; chatCount = -1; olderLoading = false; noOlder = false;
  $('#chatName').textContent = c.name;
  $('#chatUid').textContent = t('');
  $('#chatAvatar').src = c.avatar || '';
  $('#chatList').innerHTML = '<div class="sheet-msg"><div class="spinner"></div></div>';
  $('#inbox').classList.remove('open');
  $('#chat').classList.add('open');
  send({ t: 'chatvis', on: true });
  send({ t: 'conv', id: c.id });
  clearInterval(chatTimer);
  chatTimer = setInterval(() => { if (chatConv && !dmQueue.length && !state.openingShared) send({ t: 'conv', id: chatConv.id }); }, 4000);
  setTimeout(() => $('#chatInput').focus(), 300);
}
function closeChat() {
  clearInterval(chatTimer); chatTimer = null; chatConv = null;
  send({ t: 'chatvis', on: false });
  $('#chat').classList.remove('open');
}
$('#chatBack').addEventListener('click', () => { closeChat(); openInbox(); });

function onConv(m) {
  if (!chatConv || m.id !== chatConv.id) return;
  let d = null;
  try { d = m.data ? JSON.parse(m.data) : null; } catch { }
  const list = $('#chatList');
  if (!d) { if (chatCount < 0) list.innerHTML = `<div class="sheet-msg">${t('No se pudo abrir la conversación.')}</div>`; return; }
  if (d.uid) $('#chatUid').textContent = d.uid;
  if (d.avatar) $('#chatAvatar').src = d.avatar;
  if (m.older) {
    olderLoading = false;
    if (d.messages.length <= chatCount) { noOlder = true; $('#chatOlder') && $('#chatOlder').remove(); return; }
  }
  if (d.messages.length === chatCount) return;
  const prevHeight = list.scrollHeight;
  const atBottom = !m.older && (chatCount < 0 || list.scrollTop + list.clientHeight > list.scrollHeight - 60);
  chatCount = d.messages.length;
  list.innerHTML = d.messages.map((x) => {
    if (x.sep != null) return `<div class="sep">${esc(x.sep)}</div>`;
    let inner = '';
    if (x.ref) inner += `<div class="ref">${esc(x.ref)}</div>`;
    if (x.text) inner += esc(x.text);
    // Video compartido: tarjeta con portada como en la app
    if (x.shared >= 0) inner += `<div class="vthumb" data-n="${x.shared}">${x.image ? `<img alt="" src="${esc(x.image)}">` : '<div style="aspect-ratio:3/4"></div>'}<span class="pl">${ICON.play}</span><div class="ft">${esc(x.sharedBy || 'Video')}</div></div>`;
    else if (x.video) inner += `<div class="vthumb" data-url="${esc(x.video)}">${x.image ? `<img alt="" src="${esc(x.image)}">` : '<div style="aspect-ratio:3/4"></div>'}<span class="pl">${ICON.play}</span><div class="ft">Video</div></div>`;
    else if (x.image) inner += `<img class="pic" alt="" src="${esc(x.image)}">`;
    if (!inner && x.other) inner = esc(x.other);
    if (!inner) inner = `<i>${t('Mensaje no compatible')}</i>`;
    const bubble = (x.video || x.shared >= 0 || x.image) && !x.text ? inner : `<div class="bub">${inner}</div>`;
    return `<div class="msg ${x.mine ? 'mine' : ''}">${x.mine ? '' : `<img class="av" alt="" src="${esc(x.avatar)}">`}${bubble}</div>`;
  }).join('');
  $$('.vthumb', list).forEach((v) => v.onclick = () => {
    if (v.dataset.url) openVideoLink(v.dataset.url);
    else if (!state.openingShared) { state.openingShared = true; toast(t('Abriendo video…')); send({ t: 'openshared', id: chatConv.id, n: +v.dataset.n }); }
  });
  if (!noOlder) list.insertAdjacentHTML('afterbegin', `<div class="sheet-msg" id="chatOlder">${t('Sube para ver mensajes anteriores')}</div>`);
  if (atBottom) list.scrollTop = list.scrollHeight;
  else if (m.older) list.scrollTop = list.scrollHeight - prevHeight;
}

// Al llegar arriba del chat se piden los mensajes anteriores
let olderLoading = false, noOlder = false;
$('#chatList').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  if (l.scrollTop > 40 || olderLoading || noOlder || !chatConv || chatCount <= 0) return;
  olderLoading = true;
  const o = $('#chatOlder'); if (o) o.innerHTML = '<div class="spinner"></div>';
  send({ t: 'convold', id: chatConv.id });
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text || !chatConv) return;
  $('#chatInput').value = '';
  const list = $('#chatList');
  list.insertAdjacentHTML('beforeend', `<div class="msg mine" style="opacity:.6"><div class="bub">${esc(text)}</div></div>`);
  list.scrollTop = list.scrollHeight;
  const conv = chatConv;
  sendDm(conv.id, text, (ok) => {
    if (!ok) toast(t('No se pudo enviar el mensaje'));
    chatCount = -2;
    if (chatConv === conv) send({ t: 'conv', id: conv.id });
  });
});

// Abre en la app un video a partir de su enlace (p. ej. compartido en un chat)
async function openVideoLink(url) {
  const m = /\/video\/(\d+)/.exec(url || '');
  if (!m) { send({ t: 'open', url }); return; }
  toast(t('Abriendo video…'));
  const r = await api('GET', '/api/item/detail/', { itemId: m[1] });
  const raw = r.data && r.data.itemInfo && r.data.itemInfo.itemStruct;
  const f = feedFor('single:' + m[1]);
  if (!f.items.length && raw) addItems(f, [raw]);
  if (!f.items.length) { send({ t: 'open', url }); return; }
  closeChat();
  openSubFeed(f, 0);
}

// ---------- Perfil ----------
function updateProfileFollow(it) {
  if (!state.profileFor || state.profileFor.authorId !== it.authorId) return;
  const b = $('#pfFollow');
  const mine = state.me && state.me.uid === it.authorId;
  b.style.display = mine ? 'none' : '';
  $('#pfEdit').style.display = 'none';
  $('#pfPen').classList.toggle('show', !!mine);
  $('#pfMsg').style.display = mine ? 'none' : '';
  b.innerHTML = it.followed ? ICON.usercheck : t('Seguir');
  b.title = it.followed ? t('Dejar de seguir') : '';
  b.classList.toggle('following', !!it.followed);
}

async function openProfile(it) {
  if (!it.secUid) return;
  state.profileFor = it;
  const f = feedFor('user:' + it.secUid);
  f.title = '@' + it.author;
  state.profileKey = f.key;
  $$('#pfTabs button').forEach((b) => b.classList.toggle('on', b.dataset.list === 'user'));
  $('#pfSub').classList.remove('show');
  showCollections(false);
  $('#pfTitle').textContent = it.nick || it.author;
  $('#pfName').textContent = it.nick || it.author;
  $('#pfAvatar').src = it.avatar || '';
  $('#pfHandle').textContent = t('@') + it.author;
  $('#pfBio').textContent = it.signature || '';
  const s = it.authorStats || {};
  $('#pfFollowing').textContent = s.followingCount != null ? fmt(s.followingCount) : '–';
  $('#pfFollowers').textContent = s.followerCount != null ? fmt(s.followerCount) : '–';
  $('#pfLikes').textContent = s.heartCount != null || s.heart != null ? fmt(s.heartCount ?? s.heart) : '–';
  updateProfileFollow(it);
  $('#pfBody').scrollTop = 0;
  renderGrid($('#pfGrid'), $('#pfMore'), f);
  openPanel('profile');
  if (!f.items.length) f.load(f);

  // Datos completos del perfil
  const r = await api('GET', '/api/user/detail/', { uniqueId: it.author, secUid: it.secUid });
  const info = r.data && r.data.userInfo;
  if (!info || state.profileFor !== it) return;
  const u = info.user || {}, st = info.stats || {};
  $('#pfAvatar').src = u.avatarMedium || u.avatarThumb || it.avatar || '';
  $('#pfBio').textContent = u.signature || '';
  $('#pfFollowing').textContent = fmt(st.followingCount);
  $('#pfFollowers').textContent = fmt(st.followerCount);
  $('#pfLikes').textContent = fmt(st.heartCount ?? st.heart);
  if (u.relation != null) { setFollowed(it.authorId, u.relation === 1 || u.relation === 2); updateProfileFollow(it); }
}

$$('#pfTabs button').forEach((b) => {
  b.innerHTML = ICON[b.dataset.ic];
  b.addEventListener('click', () => showProfileList(b.dataset.list));
});

function showProfileList(list) {
  const it = state.profileFor; if (!it) return;
  $$('#pfTabs button').forEach((x) => x.classList.toggle('on', x.dataset.list === list));
  $('#pfSub').classList.toggle('show', list === 'favorites');
  $$('#pfSub button').forEach((x) => x.classList.toggle('on', x.dataset.sub === 'posts'));
  showCollections(false);
  const f = feedFor(list + ':' + it.secUid);
  f.title = list === 'user' ? '@' + it.author : $(`#pfTabs [data-list="${list}"]`).title + ' · @' + it.author;
  state.profileKey = f.key;
  renderGrid($('#pfGrid'), $('#pfMore'), f);
  if (!f.items.length) f.load(f);
}

// ---------- Colecciones (dentro de Favoritos) ----------
function showCollections(on) {
  $('#pfColl').classList.toggle('show', on);
  $('#pfGrid').style.display = on ? 'none' : '';
  $('#pfMore').style.display = on ? 'none' : '';
}

$$('#pfSub button').forEach((b) => b.addEventListener('click', () => {
  $$('#pfSub button').forEach((x) => x.classList.toggle('on', x === b));
  if (b.dataset.sub === 'collections') loadCollections();
  else showProfileList('favorites');
}));

async function loadCollections() {
  const it = state.profileFor; if (!it) return;
  showCollections(true);
  const box = $('#pfColl');
  box.innerHTML = '<div class="sheet-msg coll-back"><div class="spinner"></div></div>';
  const r = await api('GET', '/api/user/collection_list/', { secUid: it.secUid, count: 30, cursor: 0 });
  if (state.profileFor !== it) return;
  const d = r.data || {};
  const list = d.collectionList || d.collection_list || [];
  if (!list.length) {
    box.innerHTML = `<div class="sheet-msg coll-back">${r.data ? t('No hay colecciones.') : t('No se pudieron cargar las colecciones.')}</div>`;
    if (r.data) log('colecciones: ' + JSON.stringify(d).slice(0, 300));
    return;
  }
  box.innerHTML = '';
  for (const c of list) {
    const id = c.collectionId || c.collection_id || c.id;
    const cover = (c.cover && c.cover.urlList && c.cover.urlList[0]) || (typeof c.cover === 'string' ? c.cover : '');
    const b = document.createElement('button');
    b.className = 'coll';
    b.innerHTML = `<div class="cv">${cover ? `<img alt="" src="${esc(cover)}">` : ICON.folder}</div>
      <div class="nm">${esc(c.name)}</div><div class="ct">${t('{0} publicaciones', fmt(c.total))}</div>`;
    b.onclick = () => openCollection(id, c.name);
    box.appendChild(b);
  }
}

function openCollection(id, name) {
  const f = feedFor('coll:' + id);
  f.title = name;
  state.profileKey = f.key;
  showCollections(false);
  renderGrid($('#pfGrid'), $('#pfMore'), f);
  if (!f.items.length) f.load(f);
}

$('#pfFollow').addEventListener('click', () => { const it = state.profileFor; if (it) follow(it, !it.followed); });
$('#pfBack').innerHTML = ICON.back;
$('#pfPen').innerHTML = ICON.pencil;
$('#pfMsg').innerHTML = ICON.plane + `<span>${t('Mensajes')}</span>`;
$('#pfPen').addEventListener('click', () => $('#pfEdit').click());
// Mensaje: abre el chat si ya existe una conversación con esa persona
$('#pfMsg').addEventListener('click', async () => {
  const it = state.profileFor; if (!it) return;
  if (!state.me) return askLogin();
  if (!Array.isArray(state.chats)) { loadInbox(); toast(t('Buscando el chat…')); return; }
  const c = state.chats.find((x) => x.name === it.nick || x.name === it.author);
  if (c) { closePanels(); openChat(c); }
  else { closePanels(); send({ t: 'web', url: 'https://www.tiktok.com/messages' }); toast(t('Inicia el chat desde Mensajes')); }
});
$('#pfEdit').addEventListener('click', () => {
  const it = state.profileFor; if (!it) return;
  closePanels();
  send({ t: 'web', url: 'https://www.tiktok.com/@' + it.author });
  toast(t('Usa «Editar perfil» en la página oficial'));
});
$('#pfOpen').addEventListener('click', () => { const it = state.profileFor; if (it) send({ t: 'open', url: 'https://www.tiktok.com/@' + it.author }); });
$('#pfBody').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  const f = state.profileKey && feeds.get(state.profileKey);
  if (f && l.scrollTop + l.clientHeight > l.scrollHeight - 400) f.load(f);
});

function renderGrid(grid, more, f) {
  const have = grid.children.length;
  if (grid.dataset.key !== f.key || have > f.items.length) { grid.innerHTML = ''; grid.dataset.key = f.key; }
  for (let i = grid.children.length; i < f.items.length; i++) {
    const it = f.items[i];
    const t = document.createElement('div');
    t.className = 'tile';
    t.innerHTML = `<img alt="" loading="lazy" src="${esc(it.cover)}">${it.pinned ? '<span class="pin">Fijado</span>' : ''}
      <span class="views">${ICON.views}${fmt(it.plays)}</span>`;
    t.onclick = () => openSubFeed(f, i);
    grid.appendChild(t);
  }
  more.innerHTML = f.loading || (f.hasMore && !f.items.length) ? '<div class="spinner"></div>'
    : f.error ? t('No se pudieron cargar los videos (puede ser una lista privada).') : !f.items.length ? t('Sin videos.') : '';
}

// ---------- Búsqueda ----------
function openSearch() {
  openPanel('search');
  $('#search').classList.remove('searching');
  $('#searchInput').value = '';
  $('#searchHome').dataset.all = '';
  renderSearchHome();
  setTimeout(() => $('#searchInput').focus(), 250);
}
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const kw = $('#searchInput').value.trim();
  if (!kw) return;
  $('#searchInput').blur();
  addSearchHistory(kw);
  $('#search').classList.add('searching');
  const key = 'search:' + kw;
  feeds.delete(key);
  const f = feedFor(key);
  state.searchKey = key;
  state.searchKw = kw;
  renderGrid($('#searchGrid'), $('#searchMore'), f);
  f.load(f);
  searchUsers(kw);
});

$$('#searchTabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#searchTabs button').forEach((x) => x.classList.toggle('on', x === b));
  const users = b.dataset.st === 'users';
  $('#searchGrid').style.display = users ? 'none' : '';
  $('#searchMore').style.display = users ? 'none' : '';
  $('#searchUsers').style.display = users ? '' : 'none';
}));
$('#searchUsers').style.display = 'none';

async function searchUsers(kw) {
  const box = $('#searchUsers');
  box.innerHTML = '<div class="sheet-msg"><div class="spinner"></div></div>';
  const r = await api('GET', '/api/search/user/full/', { keyword: kw, cursor: 0 });
  if (state.searchKw !== kw) return;
  const list = (r.data && r.data.user_list) || [];
  if (!list.length) { box.innerHTML = `<div class="sheet-msg">${t('No se encontraron usuarios.')}</div>`; return; }
  const users = list.map((x) => x.user_info || {}).filter((u) => u.sec_uid);
  box.innerHTML = users.map((u, i) => `<button class="ib-item" data-i="${i}">
      <img class="av" alt="" src="${esc(u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0])}">
      <div class="tx"><div class="nm">${esc(u.nickname || u.unique_id)}</div>
      <div class="ls">@${esc(u.unique_id)} · ${t('{0} seguidores', fmt(u.follower_count))}</div></div></button>`).join('');
  $$('button.ib-item', box).forEach((b) => b.onclick = () => {
    const u = users[+b.dataset.i];
    openProfile({ secUid: u.sec_uid, author: u.unique_id, nick: u.nickname, authorId: u.uid,
      avatar: u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0], signature: u.signature,
      followed: u.follow_status === 1 || u.follow_status === 2 });
  });
}
$('#search').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  const f = state.searchKey && feeds.get(state.searchKey);
  if (f && l.scrollTop + l.clientHeight > l.scrollHeight - 400) f.load(f);
});

// ---------- Comentarios ----------
let prefetchTimer;
function schedulePrefetchComments() {
  clearTimeout(prefetchTimer);
  const it = currentItem();
  if (!it) return;
  prefetchTimer = setTimeout(() => fetchComments(it.id), 700);
}

async function fetchComments(id, more = false) {
  let c = state.comments.get(id);
  if (!c) { c = { list: [], cursor: 0, hasMore: true, total: null, loading: false, replies: new Map() }; state.comments.set(id, c); }
  if (c.loading || (!more && c.list.length) || !c.hasMore) return;
  c.loading = true;
  const r = await api('GET', '/api/comment/list/', { aweme_id: id, count: 20, cursor: c.cursor });
  c.loading = false;
  const d = r.data;
  if (!d || !Array.isArray(d.comments)) {
    c.hasMore = false; c.error = !d || d.status_code !== 0;
  } else {
    c.error = false;
    c.list.push(...d.comments);
    c.cursor = d.cursor || c.cursor + d.comments.length;
    c.hasMore = !!d.has_more;
    c.total = d.total ?? c.total;
  }
  if (state.sheetFor === id) renderComments();
}

function cmtHtml(cm, reply, parentCid) {
  const u = cm.user || {};
  const av = (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) || '';
  // Imagen adjunta (se prefiere jpeg, como la web)
  const urls = (cm.image_list && cm.image_list[0] && cm.image_list[0].origin_url && cm.image_list[0].origin_url.url_list) || [];
  const img = urls.find((x) => /jpe?g/.test(x)) || urls[0];
  const disliked = state.cmtDislikes.has(cm.cid);
  const it = currentItem();
  const authorAv = it && it.avatar;
  return `<div class="cmt ${reply ? 'reply' : ''}" data-cid="${esc(cm.cid)}" data-parent="${esc(parentCid || '')}">
    <img alt="" src="${esc(av)}">
    <div class="body">
      <div class="name">${esc(u.nickname || u.unique_id)}</div>
      <div class="text">${richText(cm.text)}</div>
      ${img ? `<img class="cimg" alt="" src="${esc(img)}">` : ''}
      <div class="sub"><span>${ago(cm.create_time)}</span>
        <span class="reply-btn" data-cid="${esc(parentCid || cm.cid)}" data-name="${esc(u.nickname || u.unique_id)}">${t('Responder')}</span>
        ${cm.is_author_digged ? `<span class="authliked" title="Le gustó al creador">${authorAv ? `<img alt="" src="${esc(authorAv)}">` : ''}${ICON.heart}</span>` : ''}
        <span class="right">
          <span class="likes ${cm.user_digged ? 'on' : ''}" data-cid="${esc(cm.cid)}">${cm.user_digged ? ICON.heart : ICON.heartline}<span>${fmt(cm.digg_count)}</span></span>
          <span class="dislike ${disliked ? 'on' : ''}" data-cid="${esc(cm.cid)}" title="${t('No me gusta (solo lo ves tú)')}">${disliked ? ICON.thumbdownfill : ICON.thumbdown}</span>
        </span></div>
    </div>
  </div>`;
}

// Me gusta en comentarios: la web usa digg_type 1 para dar y 2 para quitar
async function cmtLike(id, cm, on) {
  if (!state.me) return askLogin();
  if (!!cm.user_digged === on) return;
  if (on) state.cmtDislikes.delete(cm.cid);
  cm.user_digged = on ? 1 : 0; cm.digg_count = (cm.digg_count || 0) + (on ? 1 : -1); renderComments();
  const ok = await act('/api/comment/digg/', { aweme_id: id, cid: cm.cid, digg_type: on ? 1 : 2, channel_id: 0 });
  if (!ok) { cm.user_digged = on ? 0 : 1; cm.digg_count += on ? -1 : 1; renderComments(); }
}

// "No me gusta" es privado en la app y la web no lo envía: se guarda solo en este equipo
function cmtDislike(id, cm) {
  const on = !state.cmtDislikes.has(cm.cid);
  if (on) { state.cmtDislikes.add(cm.cid); if (cm.user_digged) cmtLike(id, cm, false); }
  else state.cmtDislikes.delete(cm.cid);
  pref.set('cmtDislikes', [...state.cmtDislikes].slice(-500));
  renderComments();
}

function openCommentOptions(id, cm, parentCid) {
  const u = cm.user || {};
  const mine = state.me && (u.uid === state.me.uid || u.unique_id === state.me.uniqueId);
  // Las opciones cierran el panel de comentarios; se vuelve a abrir antes de cada acción
  const back = () => { state.sheetFor = id; openPanel('sheet'); document.body.classList.add('cmt-open'); renderComments(); };
  openOptions([[
    { ic: 'comment', label: t('Responder'), fn: () => { back(); setReply({ cid: parentCid || cm.cid, name: u.nickname || u.unique_id }); $('#cmtInput').focus(); } },
    { ic: 'link', label: t('Copiar'), fn: () => navigator.clipboard.writeText(cm.text || '').then(() => toast(t('Copiado'))) },
    { ic: 'heartline', label: cm.user_digged ? t('Quitar me gusta') : t('Me gusta'), fn: () => { back(); cmtLike(id, cm, !cm.user_digged); } },
    { ic: 'thumbdown', label: state.cmtDislikes.has(cm.cid) ? t('Quitar no me gusta') : t('No me gusta'), fn: () => { back(); cmtDislike(id, cm); } },
    { ic: 'user', label: t('Ver perfil de {0}', u.nickname || u.unique_id), fn: () => openUserByName(u.unique_id) },
  ], [
    mine ? { ic: 'broken', label: t('Eliminar'), danger: true, fn: () => { back(); deleteComment(id, cm, parentCid); } }
      : { ic: 'flag', label: t('Denunciar'), danger: true, fn: () => { const it = currentItem(); if (it) report(it); } },
  ]]);
  $('#scrim').classList.add('show');
}

async function deleteComment(id, cm, parentCid) {
  const ok = await act('/api/comment/delete/', { aweme_id: id, cid: cm.cid });
  if (!ok) return;
  const c = state.comments.get(id);
  if (c) {
    if (parentCid) { const r = c.replies.get(parentCid); if (r) r.list = r.list.filter((x) => x.cid !== cm.cid); }
    else { c.list = c.list.filter((x) => x.cid !== cm.cid); c.total = Math.max(0, (c.total || 1) - 1); }
  }
  toast(t('Comentario eliminado'));
  renderComments();
}

$('#sheetList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.cmt'); if (!row) return;
  e.preventDefault();
  const id = state.sheetFor, c = state.comments.get(id);
  const cm = c && findComment(c, row.dataset.cid);
  if (cm) openCommentOptions(id, cm, row.dataset.parent || null);
});

function findComment(c, cid) {
  for (const cm of c.list) {
    if (cm.cid === cid) return cm;
    const r = c.replies.get(cm.cid);
    if (r) for (const x of r.list) if (x.cid === cid) return x;
  }
  return null;
}

function renderComments() {
  const it = currentItem();
  const c = state.comments.get(state.sheetFor);
  const list = $('#sheetList');
  $('#sheetTitle').textContent = `${t('{0} comentarios', fmt(c && c.total != null ? c.total : it ? it.comments : 0))}`;
  if (!c || (!c.list.length && (c.loading || (c.hasMore && !c.error)))) {
    list.innerHTML = '<div class="sheet-msg"><div class="spinner"></div></div>';
    return;
  }
  if (!c.list.length) {
    list.innerHTML = `<div class="sheet-msg">${c.error ? t('No se pudieron cargar los comentarios.') : t('Todavía no hay comentarios.')}</div>`;
    return;
  }
  const keepScroll = list.scrollTop;
  list.innerHTML = c.list.map((cm) => {
    const r = c.replies.get(cm.cid);
    let html = cmtHtml(cm, false);
    if (r && r.list.length) html += `<div class="replies">${r.list.map((x) => cmtHtml(x, true, cm.cid)).join('')}</div>`;
    const left = (cm.reply_comment_total || 0) - (r ? r.list.length : 0);
    if (left > 0 && (!r || r.hasMore)) {
      html += `<button class="morereplies" data-cid="${esc(cm.cid)}">${r && r.loading ? t('Cargando…') : (left > 1 ? t('Ver {0} respuestas', left) : t('Ver 1 respuesta')) + ' ▾'}</button>`;
    }
    return html;
  }).join('') + (c.hasMore ? '<div class="sheet-msg"><div class="spinner"></div></div>' : '');
  list.scrollTop = keepScroll;
}

$('#sheetList').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  if (l.scrollTop + l.clientHeight > l.scrollHeight - 300 && state.sheetFor) fetchComments(state.sheetFor, true);
});
$('#sheetList').addEventListener('click', async (e) => {
  const id = state.sheetFor;
  const c = state.comments.get(id);
  if (!c) return;

  const lk = e.target.closest('.likes');
  if (lk) { const cm = findComment(c, lk.dataset.cid); if (cm) cmtLike(id, cm, !cm.user_digged); return; }
  const dl = e.target.closest('.dislike');
  if (dl) { const cm = findComment(c, dl.dataset.cid); if (cm) cmtDislike(id, cm); return; }
  const im = e.target.closest('.cimg');
  if (im) { send({ t: 'open', url: im.src }); return; }
  const rb = e.target.closest('.reply-btn');
  if (rb) { setReply({ cid: rb.dataset.cid, name: rb.dataset.name }); $('#cmtInput').focus(); return; }

  const b = e.target.closest('.morereplies');
  if (!b) return;
  const cid = b.dataset.cid;
  let r = c.replies.get(cid);
  if (!r) { r = { list: [], cursor: 0, hasMore: true, loading: false }; c.replies.set(cid, r); }
  if (r.loading) return;
  r.loading = true;
  renderComments();
  const res = await api('GET', '/api/comment/list/reply/', { item_id: id, comment_id: cid, count: 10, cursor: r.cursor });
  r.loading = false;
  const d = res.data;
  if (d && Array.isArray(d.comments)) {
    r.list.push(...d.comments); r.cursor = d.cursor || r.cursor + d.comments.length; r.hasMore = !!d.has_more;
  } else { r.hasMore = false; toast(t('No se pudieron cargar las respuestas')); }
  if (state.sheetFor === id) renderComments();
});

function setReply(r) {
  state.replyTo = r;
  $('#cmtInput').placeholder = r ? t('Responder a {0}…', r.name) : t('Agregar comentario…');
}

$('#cmtForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#cmtInput').value.trim();
  const id = state.sheetFor;
  if (!text || !id) return;
  if (!state.me) return askLogin();
  $('#cmtSend').disabled = true;
  const q = { aweme_id: id, text, text_extra: '[]' };
  if (state.replyTo) { q.reply_id = state.replyTo.cid; q.reply_to_reply_id = 0; }
  const d = await act('/api/comment/publish/', q);
  $('#cmtSend').disabled = false;
  if (!d) return;
  $('#cmtInput').value = '';
  const c = state.comments.get(id);
  const cm = d.comment || { cid: String(Date.now()), text, create_time: Date.now() / 1000, digg_count: 0, user: { nickname: state.me.nickName || state.me.uniqueId } };
  if (c) {
    if (state.replyTo) {
      let r = c.replies.get(state.replyTo.cid);
      if (!r) { r = { list: [], cursor: 0, hasMore: false, loading: false }; c.replies.set(state.replyTo.cid, r); }
      r.list.unshift(cm);
    } else { c.list.unshift(cm); c.total = (c.total || 0) + 1; }
  }
  setReply(null);
  renderComments();
  toast(t('Comentario publicado'));
});

function openComments(it) {
  if (!it) return;
  state.sheetFor = it.id;
  fetchComments(it.id);
  renderComments();
  openPanel('sheet');
  document.body.classList.add('cmt-open');
  const me = state.me && state.me.avatarUri;
  $('#cmtMe').src = Array.isArray(me) ? me[0] : (me || '');
}

// ---------- Ventana y navegación ----------
$$('.ic[data-ic]').forEach((s) => { s.innerHTML = ICON[s.dataset.ic] || ''; });
$('#btnSearch').innerHTML = ICON.search;
$('#btnBack').innerHTML = ICON.back;
$('#chatBack').innerHTML = ICON.back;
$('#ibClose').innerHTML = ICON.back;
$('#ibSearchBtn').innerHTML = ICON.search;
$('#actBack').innerHTML = ICON.back;
$('#searchBack').innerHTML = ICON.back;
$('#sIcon').innerHTML = ICON.search;
$('#btnTop').innerHTML = ICON.pin;
$('#btnMin').innerHTML = ICON.min;
$('#btnMax').innerHTML = ICON.max;
$('#btnClose').innerHTML = ICON.close;
$('#btnMute').addEventListener('click', () => setMuted(!state.muted));
$('#vol').addEventListener('input', (e) => setVolume(e.target.value / 100));
$('#btnTop').addEventListener('click', () => send({ t: 'top' }));
$('#btnMin').addEventListener('click', () => send({ t: 'min' }));
$('#btnMax').addEventListener('click', () => send({ t: 'max' }));
$('#btnClose').addEventListener('click', () => send({ t: 'close' }));
$('#btnSearch').addEventListener('click', openSearch);
$('#btnBack').addEventListener('click', back);
$('#cleanExit').addEventListener('click', toggleClean);
$('#top').addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button, input')) send({ t: 'drag' }); });
$('#top').addEventListener('dblclick', (e) => { if (!e.target.closest('button, input')) send({ t: 'max' }); });
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.feed)));
$$('.nav').forEach((n) => n.addEventListener('click', () => {
  switch (n.dataset.nav) {
    case 'home': switchTab('foryou'); break;
    case 'friends': switchTab('friends'); break;
    case 'upload': send({ t: 'web', url: 'https://www.tiktok.com/tiktokstudio/upload' }); break;
    case 'inbox': openInbox(); break;
    case 'me':
      if (!state.me) { send({ t: 'login' }); break; }
      openProfile({ secUid: state.me.secUid, author: state.me.uniqueId, nick: state.me.nickName, authorId: state.me.uid,
        avatar: Array.isArray(state.me.avatarUri) ? state.me.avatarUri[0] : state.me.avatarUri });
      break;
  }
  if (n.dataset.nav === 'home' || n.dataset.nav === 'friends') {
    $$('.nav').forEach((x) => x.classList.toggle('active', x === n));
  }
}));

// ---------- Búsqueda: historial y sugerencias, como en la app ----------
function searchHistory() { return pref.get('searchHistory', []); }
function addSearchHistory(kw) {
  pref.set('searchHistory', [kw, ...searchHistory().filter((x) => x !== kw)].slice(0, 30));
}

function renderSearchHome(sugs) {
  const box = $('#searchHome');
  const hist = searchHistory();
  const showAll = box.dataset.all === '1';
  let html = (showAll ? hist : hist.slice(0, 6)).map((h) => `<button class="sh-row" data-q="${esc(h)}">${ICON.clock}<span>${esc(h)}</span><span class="del" data-del="${esc(h)}">✕</span></button>`).join('');
  if (hist.length > 6 && !showAll) html += '<button class="sh-row" id="shMore" style="justify-content:center;font-weight:400;color:rgba(255,255,255,.6)">' + t('Ver más') + ' ▾</button>';
  if (sugs && sugs.length) {
    html += '<div class="sh-title">' + t('Podría interesarte') + '</div>' + sugs.map((s) => `<button class="sh-row sh-sug" data-q="${esc(s)}"><span>${esc(s)}</span></button>`).join('');
  }
  box.innerHTML = html || '<div class="sheet-msg">' + t('Busca videos y usuarios.') + '</div>';
  $$('[data-q]', box).forEach((b) => b.onclick = (e) => {
    if (e.target.dataset.del) {
      e.stopPropagation();
      pref.set('searchHistory', searchHistory().filter((x) => x !== e.target.dataset.del));
      renderSearchHome(sugs);
      return;
    }
    $('#searchInput').value = b.dataset.q;
    $('#searchForm').requestSubmit();
  });
  const more = $('#shMore');
  if (more) more.onclick = () => { box.dataset.all = '1'; renderSearchHome(sugs); };
}

// Sugerencias mientras se escribe (las da la misma API de la web)
let sugTimer;
$('#searchInput').addEventListener('input', () => {
  $('#search').classList.remove('searching');
  clearTimeout(sugTimer);
  const kw = $('#searchInput').value.trim();
  if (!kw) { renderSearchHome(); return; }
  sugTimer = setTimeout(async () => {
    const r = await api('GET', '/api/search/general/preview/', { keyword: kw });
    if ($('#searchInput').value.trim() !== kw) return;
    const list = ((r.data && (r.data.sug_list || r.data.data)) || []).map((x) => x.content || x.word || '').filter(Boolean);
    renderSearchHome(list.slice(0, 10));
  }, 250);
});

// ---------- Reacciones rápidas en el chat ----------
for (const emo of ['❤️', '😂', '👍', '😮', '😢', '🔥']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emo;
  b.onclick = () => { $('#chatInput').value = emo; $('#chatForm').requestSubmit(); };
  $('#chatQuick').appendChild(b);
}

// ---------- Mensajes del programa ----------
host && host.addEventListener('message', (e) => {
  const m = e.data;
  switch (m.t) {
    case 'feed': {
      const f = feedFor(m.kind || 'foryou');
      let data; try { data = JSON.parse(m.body); } catch { return; }
      f.loading = false;
      addItems(f, data.itemList);
      feedChanged(f);
      break;
    }
    case 'api': onApi(m); break;
    case 'me': {
      const was = !!state.me;
      try { state.me = m.user ? JSON.parse(m.user) : null; } catch { state.me = null; }
      if (m.lang && m.lang !== tiktokLang) { tiktokLang = m.lang; if (opt.lang === 'auto' && resolveLang() !== uiLang) applyLang(); }
      if (!!state.me !== was && state.feed) updateEmpty();
      break;
    }
    case 'inbox': onInbox(m); break;
    case 'text': { const r = textWaiting.get(m.rid); if (r) { textWaiting.delete(m.rid); r(m.body); } break; }
    case 'conv': onConv(m); break;
    case 'dm': onDm(m); break;
    case 'sharedurl': state.openingShared = false; if (m.url) openVideoLink(m.url); else toast(t('No se pudo abrir el video')); break;
    case 'toast': toast(m.m); break;
    case 'winstate': $('#btnMax').innerHTML = m.max ? ICON.restore : ICON.max; $('#btnMax').title = m.max ? 'Restaurar (F)' : 'Maximizar (F)'; break;
    case 'topmost': $('#btnTop').classList.toggle('on', m.on); toast(m.on ? t('Siempre visible') : t('Ventana normal')); break;
    case 'captcha':
      toast(t('TikTok pide una verificación'));
      if (state.feed && !state.feed.items.length) {
        $('#emptyText').innerHTML = t('TikTok pide una verificación.') + '<br><br><button id="verifyBtn">' + t('Resolver') + '</button>';
        $('#verifyBtn').onclick = () => send({ t: 'verify' });
      }
      break;
    default: onHostMessage(m); break;
    case 'reset':
      teardown();
      feeds.clear(); state.stack = []; state.comments.clear(); state.chats = null;
      setFeed(feedFor('foryou'));
      break;
  }
});

// Estado inicial
setVolume(state.volume);
setMuted(state.muted);
if (state.speed !== 1) { $('#speedBadge').textContent = state.speed + 'x'; $('#speedBadge').classList.add('show'); }
setFeed(feedFor('foryou'));
send({ t: 'ready' });
