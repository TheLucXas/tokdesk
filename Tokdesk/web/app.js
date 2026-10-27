'use strict';

const host = window.chrome && window.chrome.webview;
const send = (m) => host && host.postMessage(m);
const log = (m) => send({ t: 'log', m: String(m) });
window.addEventListener('error', (e) => log('JS: ' + e.message + ' @' + e.lineno));
// Imágenes del CDN que fallan la primera vez (descargas simultáneas con la página oculta): se reintenta
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const orig = img.dataset.orig || img.getAttribute('src') || '';
  if (!/^https?:/.test(orig) || orig.includes('app.tokdesk')) return;
  img.dataset.orig = orig;
  const n = +(img.dataset.retry || 0);
  if (n >= 2) return;
  img.dataset.retry = n + 1;
  setTimeout(() => { img.removeAttribute('src'); img.src = orig; }, 700 * (n + 1));
}, true);

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
  hideAds: true, hideLives: true, hideDisliked: true,
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
    busy(1);
    waiting.set(id, (v) => { busy(-1); resolve(v); });
    const qs = {};
    for (const k in q) if (q[k] != null) qs[k] = String(q[k]);
    send({ t: 'api', rid: id, m, path, q: qs });
    setTimeout(() => { if (waiting.delete(id)) { busy(-1); resolve({ status: 0, data: null }); } }, 25000);
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

// H.265 solo se reproduce si Windows tiene la extensión HEVC; TikTok suele dar el 1080p solo en ese formato
const HEVC_OK = !!document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"');

function pickSource(v) {
  const list = (v.bitrateInfo || []).filter((b) => b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length)
    .filter((b) => HEVC_OK || !/265|bytevc1|hvc/i.test(b.CodecType || ''));
  // Mayor resolución primero y, a igual resolución, mayor bitrate; con ahorro de datos, al revés
  list.sort((a, b) => ((b.PlayAddr.Height || 0) - (a.PlayAddr.Height || 0)) || ((b.Bitrate || 0) - (a.Bitrate || 0)));
  if (opt.dataSaver) list.reverse();
  if (list.length) return list[0].PlayAddr.UrlList[list[0].PlayAddr.UrlList.length - 1];
  return v.playAddr || v.downloadAddr || null;
}
function normalize(it) {
  if (!it) return null;
  if (it.liveRoomInfo && opt.hideLives) return null;
  if (it.isAd && opt.hideAds) return null;
  if (it.liveRoomInfo) return normalizeLive(it);
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
  if (state.pageKey === f.key) renderGrid($('#pgGrid'), $('#pgMore'), f);
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
    $('#emptyText').innerHTML = f.error ? esc(t('No se pudieron cargar los videos.')) + `<br><br><button id="feedRetry">${esc(t('Reintentar'))}</button>` : esc(t('No hay videos para mostrar.'));
    if (f.error) $('#feedRetry').onclick = () => { f.error = false; f.hasMore = true; f.cursor = 0; updateEmpty(); f.load(f); };
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
  // Si el feed se abrió desde un chat, un perfil o una página, se vuelve ahí (como en la app)
  const ret = state.returnTo && state.feed && state.returnTo.key === state.feed.key ? state.returnTo : null;
  setFeed(state.stack.pop());
  if (ret) { state.returnTo = null; ret.fn(); }
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
    ${it.live ? `<button class="livebtn">${esc(t('EN VIVO'))} · ${esc(t('Ver en el navegador'))}</button>` : ''}
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
  $('.follow', el).addEventListener('click', (e) => {
    e.stopPropagation();
    const av = $('.avatar', el);
    av.classList.add('follow-anim');
    setTimeout(() => av.classList.remove('follow-anim'), 1100);
    follow(it, true);
  });
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
  if (ok && on) notice('✓ ' + t('Guardado'), t('Colecciones') + ' ›', () => openCollectionPicker(it));
  else if (ok) toast(t('Quitado de Favoritos'));
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

// Denunciar: el formulario oficial corre oculto y se muestra en una hoja propia (sin abrir la web)
let reportOpen = false;
function report(it, commentText) {
  const keep = !!commentText && $('#sheet').classList.contains('open');
  if (!keep) closePanels();
  reportOpen = true;
  $('#optsBody').innerHTML = `<div class="cp-title">${esc(t('Denunciar'))}</div><div class="sheet-msg"><div class="spinner"></div><div>${esc(t('Abriendo formulario de denuncia…'))}</div></div>`;
  openPanel('opts', true);
  busy(1);
  send({ t: 'reportopen', url: linkOf(it), comment: commentText || '' });
}

function onReportState(m) {
  busy(-1);
  if (!reportOpen) return;
  let s = null;
  try { s = m.s ? JSON.parse(m.s) : null; } catch { }
  const body = $('#optsBody');
  if (!s) {
    body.innerHTML = `<div class="cp-title">${esc(t('Denunciar'))}</div><div class="sheet-msg">${esc(t('No se pudo abrir la denuncia.'))}</div>`;
    reportOpen = false;
    send({ t: 'reportclose' });
    return;
  }
  if (s.closed) {
    // El formulario se cerró solo: la denuncia se envió
    body.innerHTML = `<div class="rp-done">${ICON.check}<div>${esc(t('Gracias por denunciar'))}</div></div>`;
    reportOpen = false;
    send({ t: 'reportclose' });
    setTimeout(() => closePanel('opts'), 1600);
    return;
  }
  const back = s.buttons.find((b) => !b.text && b.e2e !== 'report-card-cancel');
  const actions = s.buttons.filter((b) => b.text && b.e2e !== 'report-card-cancel');
  body.innerHTML = `<div class="rp-head">${back ? `<button class="rp-back" data-b="${back.i}">${ICON.back}</button>` : ''}<span>${esc(s.title || t('Denunciar'))}</span></div>
    ${s.text ? `<div class="rp-text">${esc(s.text)}</div>` : ''}
    <div class="og">${s.reasons.map((r, i) => `<button class="oi rp-reason" data-r="${i}"><span>${esc(r)}</span><span class="chev">›</span></button>`).join('')}</div>
    ${actions.map((b) => `<button class="pill rp-act" data-b="${b.i}" ${b.off ? 'disabled' : ''}>${esc(b.text)}</button>`).join('')}`;
  $$('.rp-reason', body).forEach((b) => b.onclick = () => reportAct('reason', +b.dataset.r));
  $$('.rp-act, .rp-back', body).forEach((b) => b.onclick = () => reportAct('button', +b.dataset.b));
}

function reportAct(kind, i) {
  $('#optsBody').insertAdjacentHTML('beforeend', '<div class="sheet-msg"><div class="spinner"></div></div>');
  busy(1);
  send({ t: 'reportact', kind, i });
}

// Si se cierra la hoja a mitad de camino, se cancela el formulario oficial
new MutationObserver(() => {
  if (reportOpen && !$('#opts').classList.contains('open')) { reportOpen = false; send({ t: 'reportclose' }); }
}).observe($('#opts'), { attributes: true, attributeFilter: ['class'] });

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

// ---------- Vista previa de imágenes (comentarios, chats) ----------
function openViewer(src) {
  const v = $('#viewer');
  $('img', v).src = src;
  v.classList.add('show');
}
function closeViewer() { $('#viewer').classList.remove('show'); }
$('#viewer .vdl').innerHTML = ICON.download;
$('#viewer .vdl').addEventListener('click', (e) => {
  e.stopPropagation();
  const src = $('#viewer img').src;
  if (src) startDownload(src, 'tokdesk_' + Date.now(), 'jpg');
});
$('#pager').addEventListener('click', (e) => {
  const lb = e.target.closest('.livebtn');
  if (!lb) return;
  e.stopPropagation();
  const it = currentItem();
  if (it) send({ t: 'open', url: 'https://www.tiktok.com/@' + it.author + '/live' });
}, true);
$('#viewer').addEventListener('click', closeViewer);
$('#chatList').addEventListener('click', (e) => { const p = e.target.closest('img.pic'); if (p) openViewer(p.src); });

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
function openTag(name) { openTagPage(name); }

function openMusic(it) {
  if (it.musicId) return openSoundPage(it);
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
// Paneles que se apilan encima de lo que esté abierto (como en la app: perfil desde comentarios, etc.)
const STACKED = ['profile', 'page', 'opts', 'activity'];
let panelZ = 60;
function openPanel(id, keep) {
  keep = keep || STACKED.includes(id);
  if (!keep) $$('.panel.open').forEach((p) => { if (p.id !== id) { p.classList.remove('open'); p.style.zIndex = ''; } });
  const el = $('#' + id);
  el.classList.add('open');
  el.style.zIndex = keep && anyOtherOpen(id) ? ++panelZ : '';
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
  state.pageKey = null;
  document.body.classList.remove('cmt-open');
  setReply(null);
  hideCtx();
  if (chatConv) closeChat();
  else if (wasInbox) send({ t: 'chatvis', on: false });
}
function anyPanelOpen() { return !!$('.panel.open'); }
function anyOtherOpen(id) { return $$('.panel.open').some((p) => p.id !== id); }

// Cierra solo un panel; si no queda ninguno abierto, hace la limpieza completa
function closePanel(id) {
  const el = $('#' + id);
  if (!el) return;
  if (!$$('.panel.open').some((p) => p !== el)) { closePanels(); return; }
  el.classList.remove('open');
  el.style.zIndex = '';
  if (id === 'sheet') { state.sheetFor = null; document.body.classList.remove('cmt-open'); setReply(null); }
  if (id === 'profile') state.profileKey = null;
  if (id === 'page') state.pageKey = null;
  if (id === 'search') state.searchKey = null;
  if (id === 'chat' && chatConv) closeChat();
}

// El panel de más arriba (el que tapa a los demás)
function topPanel() {
  return $$('.panel.open').sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0] || null;
}
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel(b.dataset.close)));
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
  if (e.key === 'Escape' && $('#viewer').classList.contains('show')) { closeViewer(); e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if ($('#ctx').classList.contains('show')) hideCtx();
    else if (anyPanelOpen()) closePanel(topPanel().id);
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
function openOptions(groups, keep) {
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
        b.onclick = () => { if (keep) $('#opts').classList.remove('open'); else closePanels(); x.fn(); };
      }
      box.appendChild(b);
    }
    body.appendChild(box);
  }
  openPanel('opts', keep);
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
    b.innerHTML = `<img alt="" src="${esc(avatarOf(c))}"><span class="lbl">${esc(c.name)}</span>`;
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
function sendDm(id, text, cb, replyTo) {
  dmQueue.push({ id, text, cb, replyTo });
  if (dmQueue.length === 1) sendNextDm();
}
function sendNextDm() {
  const j = dmQueue[0];
  if (j.replyTo != null) send({ t: 'dmreply', id: j.id, i: j.replyTo, text: j.text });
  else send({ t: 'dm', id: j.id, text: j.text });
}
function onDm(m) {
  const job = dmQueue.shift();
  if (job) job.cb(m.ok);
  if (dmQueue.length) sendNextDm();
}

// ---------- Bandeja y chats ----------
let inboxData = null;
function loadInbox() {
  if (!state.me) return;
  if (state.chats !== 'loading') { state.chats = 'loading'; busy(1); send({ t: 'inbox' }); }
  renderFriends();
}

function onInbox(m) {
  if (m.more || state.chats === 'loading') busy(-1);
  const before = inboxData ? inboxData.convs.length : 0;
  if (m.more) {
    inboxMoreBusy = false;
    const sp = $('#ibMore'); if (sp) sp.remove();
    if (!m.data) { inboxNoMore = true; return; }
  }
  if (!m.data && !m.more) {
    // La página oficial no respondió: se ofrece reintentar en vez de mostrar una bandeja vacía
    state.chats = [];
    renderFriends();
    if ($('#inbox').classList.contains('open')) {
      $('#ibBody').innerHTML = `<div class="sheet-msg">${esc(t('No se pudieron cargar los mensajes.'))}<br><br><button class="pill" id="ibRetry">${esc(t('Reintentar'))}</button></div>`;
      $('#ibRetry').onclick = () => { inboxData = null; renderInbox(); loadInbox(); };
    }
    return;
  }
  try { inboxData = m.data ? JSON.parse(m.data) : { convs: [], activity: [] }; } catch { inboxData = { convs: [], activity: [] }; }
  state.chats = inboxData.convs || [];
  rememberAvatars(state.chats);
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
      <img class="av" alt="" src="${esc(avatarOf(c))}">
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
  busy(1);
  l.insertAdjacentHTML('beforeend', '<div class="sheet-msg" id="ibMore"><div class="spinner"></div></div>');
  send({ t: 'inboxmore' });
});
$('#ibRefresh').addEventListener('click', () => { inboxData = null; renderInbox(); loadInbox(); });

let chatConv = null, chatTimer = null, chatCount = -1;
function openChat(c) {
  chatConv = c; chatCount = -1; olderLoading = false; noOlder = false; olderMisses = 0;
  $('#chatName').textContent = c.name;
  $('#chatUid').textContent = t('');
  $('#chatAvatar').src = avatarOf(c);
  $('#chatList').innerHTML = '<div class="sheet-msg"><div class="spinner"></div></div>';
  $('#inbox').classList.remove('open');
  $('#chat').classList.add('open');
  send({ t: 'chatvis', on: true });
  busy(1); state.convBusy = true;
  send({ t: 'conv', id: c.id });
  clearInterval(chatTimer);
  chatTimer = setInterval(() => { if (chatConv && !dmQueue.length && !state.openingShared) send({ t: 'conv', id: chatConv.id }); }, 6000);
  setTimeout(() => $('#chatInput').focus(), 300);
}
function closeChat() {
  clearInterval(chatTimer); chatTimer = null; chatConv = null;
  send({ t: 'chatvis', on: false });
  $('#chat').classList.remove('open');
}
$('#chatBack').addEventListener('click', () => { closeChat(); openInbox(); });

function onConv(m) {
  if (state.convBusy) { state.convBusy = false; busy(-1); }
  if (!chatConv || m.id !== chatConv.id) return;
  let d = null;
  try { d = m.data ? JSON.parse(m.data) : null; } catch { }
  const list = $('#chatList');
  if (!d) { if (chatCount < 0) list.innerHTML = `<div class="sheet-msg">${t('No se pudo abrir la conversación.')}</div>`; return; }
  if (d.uid) $('#chatUid').textContent = d.uid;
  if (d.avatar) $('#chatAvatar').src = d.avatar;
  if (m.older) {
    olderLoading = false;
    if (d.messages.length <= chatCount) {
      // La página puede tardar: se reintenta y recién después de 3 intentos se deja un botón
      olderMisses++;
      if (olderMisses >= 3) noOlder = true;
      const o = $('#chatOlder');
      if (o) o.innerHTML = noOlder ? `<button class="pill" id="olderBtn">${esc(t('Cargar mensajes anteriores'))}</button>` : `<div class="spinner"></div>`;
      if (noOlder) $('#olderBtn').onclick = () => { noOlder = false; olderMisses = 0; requestOlder(); };
      else setTimeout(requestOlder, 800);
      return;
    }
    olderMisses = 0;
  }
  if (d.messages.length === chatCount) return;
  const prevHeight = list.scrollHeight;
  const atBottom = !m.older && (chatCount < 0 || list.scrollTop + list.clientHeight > list.scrollHeight - 60);
  chatCount = d.messages.length;
  list.innerHTML = d.messages.map((x) => {
    if (x.sep != null) return `<div class="sep">${esc(x.sep)}</div>`;
    let inner = '';
    if (x.ref) inner += `<div class="ref" data-ref="${esc(x.ref.slice(0, 60))}" title="${esc(t('Ir al mensaje'))}">${esc(x.ref)}</div>`;
    if (x.text) inner += esc(x.text);
    // Video compartido: tarjeta con portada como en la app
    if (x.shared >= 0) inner += `<div class="vthumb" data-n="${x.shared}" data-id="${esc(x.itemId || '')}">${x.image ? `<img alt="" src="${esc(x.image)}">` : '<div style="aspect-ratio:3/4"></div>'}<span class="pl">${ICON.play}</span><div class="ft">${esc(x.sharedBy || 'Video')}</div></div>`;
    else if (x.video) inner += `<div class="vthumb" data-url="${esc(x.video)}">${x.image ? `<img alt="" src="${esc(x.image)}">` : '<div style="aspect-ratio:3/4"></div>'}<span class="pl">${ICON.play}</span><div class="ft">Video</div></div>`;
    else if (x.image) inner += `<img class="pic" alt="" src="${esc(x.image)}">`;
    if (!inner && x.other) inner = esc(x.other);
    if (!inner) inner = `<i>${t('Mensaje no compatible')}</i>`;
    const bubble = (x.video || x.shared >= 0 || x.image) && !x.text ? inner : `<div class="bub">${inner}</div>`;
    return `<div class="msg ${x.mine ? 'mine' : ''}${x.reaction ? ' reacted' : ''}" data-idx="${x.idx}" data-text="${esc((x.text || x.ref || x.sharedBy || '').slice(0, 120))}">${x.mine ? '' : `<img class="av" alt="" src="${esc(x.avatar || d.avatar || avatarOf(chatConv))}">`}<div class="mwrap">${bubble}${x.reaction ? `<span class="react">${esc(x.reaction)}</span>` : ''}</div></div>`;
  }).join('');
  // Portadas de videos compartidos: se piden por id (la página oficial no las trae en el mensaje)
  $$('.vthumb[data-id]', list).forEach((v) => {
    if ($('img', v)) return;
    fetchItem(v.dataset.id).then((it) => {
      const c = it && it.video && (it.video.cover || it.video.originCover);
      const ph = v.firstElementChild;
      if (c && ph && ph.tagName !== 'IMG') ph.outerHTML = '<img alt="" src="' + esc(c) + '">';
    });
  });
  $$('.vthumb', list).forEach((v) => v.onclick = () => {
    if (v._t) { clearTimeout(v._t); v._t = null; return; }
    v._t = setTimeout(() => { v._t = null; openCard(v); }, 280);
  });
  function openCard(v) {
    if (v.dataset.id) openChatVideos(v.dataset.id);
    else if (v.dataset.url) openVideoLink(v.dataset.url);
    else if (!state.openingShared) { state.openingShared = true; toast(t('Abriendo video…')); send({ t: 'openshared', id: chatConv.id, n: +v.dataset.n }); }
  }
  list.insertAdjacentHTML('afterbegin', `<div class="sheet-msg" id="chatOlder">${noOlder ? `<button class="pill" id="olderBtn">${esc(t('Cargar mensajes anteriores'))}</button>` : esc(t('Sube para ver mensajes anteriores'))}</div>`);
  if (noOlder) $('#olderBtn').onclick = () => { noOlder = false; olderMisses = 0; requestOlder(); };
  if (state.chatRestoreScroll != null) { list.scrollTop = state.chatRestoreScroll; state.chatRestoreScroll = null; }
  else if (atBottom) list.scrollTop = list.scrollHeight;
  else if (m.older) list.scrollTop = list.scrollHeight - prevHeight;
}

// Al llegar arriba del chat se piden los mensajes anteriores
let olderLoading = false, noOlder = false, olderMisses = 0;
function requestOlder() {
  if (olderLoading || !chatConv) return;
  olderLoading = true;
  const o = $('#chatOlder'); if (o) o.innerHTML = `<div class="spinner"></div><div>${esc(t('Cargando mensajes anteriores…'))}</div>`;
  send({ t: 'convold', id: chatConv.id });
}
$('#chatList').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  if (l.scrollTop > 40 || olderLoading || noOlder || !chatConv || chatCount <= 0) return;
  requestOlder();
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
  const replyTo = state.chatReply ? state.chatReply.idx : null;
  setChatReply(null);
  sendDm(conv.id, text, (ok) => {
    if (!ok) toast(t('No se pudo enviar el mensaje'));
    chatCount = -2;
    if (chatConv === conv) send({ t: 'conv', id: conv.id });
  }, replyTo);
});

// Datos completos de un video por id (con caché; los usan los chats)
const itemCache = new Map();
function fetchItem(id) {
  if (!itemCache.has(id)) {
    itemCache.set(id, api('GET', '/api/item/detail/', { itemId: id })
      .then((r) => (r.data && r.data.itemInfo && r.data.itemInfo.itemStruct) || null));
  }
  return itemCache.get(id);
}

// Videos compartidos en un chat: se abren todos como feed deslizable y al volver se regresa al chat
async function openChatVideos(startId) {
  const conv = chatConv; if (!conv) return;
  const ids = $$('#chatList .vthumb[data-id]').map((v) => v.dataset.id).filter(Boolean);
  if (!ids.length) return;
  toast(t('Abriendo video…'));
  const details = new Map();
  const queue = [startId, ...ids.filter((x) => x !== startId)];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      if (details.has(id)) continue;
      details.set(id, null);
      details.set(id, await fetchItem(id));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const key = 'chat:' + conv.id;
  feeds.delete(key);
  const f = makeFeed(key, { title: conv.name, hasMore: false, load() { } });
  addItems(f, ids.map((id) => details.get(id)).filter(Boolean));
  const idx = Math.max(0, f.items.findIndex((x) => x.id === startId));
  if (!f.items.length) { toast(t('No se pudo abrir el video')); return; }
  const scroll = $('#chatList').scrollTop;
  state.returnTo = { key, fn: () => { state.chatRestoreScroll = scroll; openInbox(); openChat(conv); } };
  openSubFeed(f, idx);
}
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
  setProfileTabs(isMine(it), false);
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
  // Favoritos ajenos: solo si tiene colecciones públicas (es lo único que la web muestra de otros)
  setProfileTabs(isMine(it), false);
  if (!isMine(it) && u.openFavorite) {
    api('GET', '/api/user/collection_list/', { secUid: it.secUid, count: 1, cursor: 0 }).then((cr) => {
      const has = !!(cr.data && (cr.data.collectionList || []).length);
      if (state.profileFor === it) setProfileTabs(false, has);
    });
  }
  if (u.relation != null) { setFollowed(it.authorId, u.relation === 1 || u.relation === 2); updateProfileFollow(it); }
}

$$('#pfTabs button').forEach((b) => {
  b.innerHTML = ICON[b.dataset.ic];
  b.addEventListener('click', () => showProfileList(b.dataset.list));
});

function showProfileList(list) {
  const it = state.profileFor; if (!it) return;
  $$('#pfTabs button').forEach((x) => x.classList.toggle('on', x.dataset.list === list));
  // En perfiles ajenos, Favoritos son solo sus colecciones públicas (la web no expone sus videos guardados)
  if (list === 'favorites' && !isMine(it)) {
    $$('#pfTabs button').forEach((x) => x.classList.toggle('on', x.dataset.list === list));
    $('#pfSub').classList.remove('show');
    loadCollections();
    return;
  }
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
    box.innerHTML = `<div class="sheet-msg coll-back">${r.data ? (isMine(it) ? t('No hay colecciones.') : t('Este usuario no tiene colecciones públicas.')) : t('No se pudieron cargar las colecciones.')}</div>`;
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
    t.onclick = () => {
      if (grid.id === 'pgGrid') { const info = state.pageInfo; state.returnTo = { key: f.key, fn: () => showPage(f, info) }; }
      else if (grid.id === 'pfGrid') { const p = state.profileFor, k = state.profileKey; state.returnTo = { key: f.key, fn: () => reopenProfile(p, k) }; }
      openSubFeed(f, i);
    };
    grid.appendChild(t);
  }
  more.innerHTML = f.loading || (f.hasMore && !f.items.length) ? '<div class="spinner"></div>'
    : f.error ? t('No se pudieron cargar los videos (puede ser una lista privada).') + `<br><br><button class="pill" data-retry>${esc(t('Reintentar'))}</button>` : !f.items.length ? t('Sin videos.') : '';
  const rb = more.querySelector('[data-retry]');
  if (rb) rb.onclick = () => { f.error = false; f.hasMore = true; f.cursor = 0; renderGrid(grid, more, f); f.load(f); };
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
    // Un fallo pasajero es común: se reintenta una vez antes de mostrar el error
    if (!c.retried && (!d || d.status_code !== 0)) { c.retried = true; setTimeout(() => fetchComments(id, more), 1200); return; }
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
  // Como en la app: con «no me gusta» se ocultan el texto y la imagen, y queda el pulgar para deshacerlo
  if (disliked && opt.hideDisliked) {
    return `<div class="cmt hidden-cmt ${reply ? 'reply' : ''}" data-cid="${esc(cm.cid)}" data-parent="${esc(parentCid || '')}">
      <img class="cav" alt="" src="${esc(av)}">
      <div class="body">
        <div class="name"><span class="uname" data-u="${esc(u.unique_id || '')}">${esc(u.nickname || u.unique_id)}</span></div>
        <div class="sub"><span class="gone">${esc(t('Este comentario ya no se te mostrará'))}</span>
          <span class="right"><span class="dislike on" data-cid="${esc(cm.cid)}" title="${esc(t('Quitar no me gusta'))}">${ICON.thumbdownfill}</span></span></div>
      </div>
    </div>`;
  }
  return `<div class="cmt ${reply ? 'reply' : ''}" data-cid="${esc(cm.cid)}" data-parent="${esc(parentCid || '')}">
    <img class="cav" alt="" src="${esc(av)}" data-full="${esc((u.avatar_medium && u.avatar_medium.url_list && u.avatar_medium.url_list[0]) || av)}" title="${esc(t('Ver foto'))}">
    <div class="body">
      <div class="name"><span class="uname" data-u="${esc(u.unique_id || '')}">${esc(u.nickname || u.unique_id)}</span></div>
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
      : { ic: 'flag', label: t('Denunciar'), danger: true, fn: () => { const it = currentItem(); if (it) report(it, cm.text); } },
  ]], true);
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
    list.innerHTML = `<div class="sheet-msg">${c.error ? t('No se pudieron cargar los comentarios.') + `<br><br><button class="pill" id="cmtRetry">${esc(t('Reintentar'))}</button>` : t('Todavía no hay comentarios.')}</div>`;
    if (c.error) $('#cmtRetry').onclick = () => { state.comments.delete(state.sheetFor); fetchComments(state.sheetFor); renderComments(); };
    return;
  }
  const keepScroll = list.scrollTop;
  list.innerHTML = c.list.map((cm) => {
    const r = c.replies.get(cm.cid);
    let html = cmtHtml(cm, false);
    if (r && r.list.length && !r.collapsed) html += `<div class="replies">${r.list.map((x) => cmtHtml(x, true, cm.cid)).join('')}</div>`;
    const left = (cm.reply_comment_total || 0) - (r ? r.list.length : 0);
    if (r && r.collapsed) {
      html += `<button class="morereplies" data-cid="${esc(cm.cid)}">${(cm.reply_comment_total > 1 ? t('Ver {0} respuestas', cm.reply_comment_total) : t('Ver 1 respuesta')) + ' ▾'}</button>`;
      return html;
    }
    if (r && r.list.length) html += `<button class="lessreplies" data-cid="${esc(cm.cid)}">${esc(t('Ocultar respuestas'))} ▴</button>`;
    if (left > 0 && (!r || r.hasMore)) {
      html += `<button class="morereplies" data-cid="${esc(cm.cid)}">${r && r.loading ? t('Cargando…') : r && r.error ? t('No se pudieron cargar las respuestas') + ' · ' + t('Reintentar') : (left > 1 ? t('Ver {0} respuestas', left) : t('Ver 1 respuesta')) + ' ▾'}</button>`;
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
  if (im) { openViewer(im.src); return; }
  const rb = e.target.closest('.reply-btn');
  if (rb) { setReply({ cid: rb.dataset.cid, name: rb.dataset.name }); $('#cmtInput').focus(); return; }

  const ln = e.target.closest('.uname[data-u]');
  if (ln) { openUserByName(ln.dataset.u); return; }
  const av = e.target.closest('img.cav');
  if (av) { openViewer(av.dataset.full || av.src); return; }
  const less = e.target.closest('.lessreplies');
  if (less) { const rr = c.replies.get(less.dataset.cid); if (rr) { rr.collapsed = true; renderComments(); } return; }
  const b = e.target.closest('.morereplies');
  if (!b) return;
  const rc = c.replies.get(b.dataset.cid);
  if (rc && rc.collapsed) { rc.collapsed = false; if (rc.list.length) { renderComments(); return; } }
  const cid = b.dataset.cid;
  let r = c.replies.get(cid);
  if (!r) { r = { list: [], cursor: 0, hasMore: true, loading: false }; c.replies.set(cid, r); }
  if (r.loading) return;
  r.loading = true;
  r.error = false;
  renderComments();
  const res = await api('GET', '/api/comment/list/reply/', { item_id: id, comment_id: cid, count: 10, cursor: r.cursor });
  r.loading = false;
  const d = res.data;
  if (d && Array.isArray(d.comments)) {
    r.list.push(...d.comments); r.cursor = d.cursor || r.cursor + d.comments.length; r.hasMore = !!d.has_more;
  } else { r.error = true; toast(t('No se pudieron cargar las respuestas')); }
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
    case 'logo': break;
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
    case 'reportstate': onReportState(m); break;
    case 'dmreact': if (!m.ok) toast(t('No se pudo reaccionar')); break;
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

// ---------- Páginas de sonido y hashtag (como en la app) ----------
async function openSoundPage(it) {
  const f = feedFor('music:' + it.musicId);
  f.title = '♫ ' + (it.musicTitle || t('Sonido'));
  showPage(f, { title: t('Sonido'), name: it.musicTitle || t('Sonido'), sub: it.music, cover: it.musicCover });
  const r = await api('GET', '/api/music/detail/', { musicId: it.musicId });
  const mi = r.data && r.data.musicInfo;
  if (!mi || state.pageKey !== f.key) return;
  const m = mi.music || {}, st = mi.stats || {};
  fillPage({ name: m.title, sub: m.authorName, cover: m.coverLarge || m.coverMedium || m.coverThumb, count: st.videoCount });
}

async function openTagPage(name) {
  const f = feedFor('tag:' + name);
  showPage(f, { title: t('Hashtag'), name: '#' + name, letter: '#' });
  const r = await api('GET', '/api/challenge/detail/', { challengeName: name });
  const ci = r.data && r.data.challengeInfo;
  if (!ci || state.pageKey !== f.key) return;
  const st = ci.statsV2 || ci.stats || {};
  fillPage({ sub: (ci.challenge && ci.challenge.desc) || '', count: st.videoCount, views: st.viewCount });
}

function showPage(f, info) {
  state.pageKey = f.key;
  state.pageInfo = info;
  $('#pgTitle').textContent = info.title;
  $('#pgName').textContent = ''; $('#pgSub').textContent = ''; $('#pgCount').textContent = '';
  fillPage(info);
  renderGrid($('#pgGrid'), $('#pgMore'), f);
  openPanel('page');
  $('#pgBody').scrollTop = 0;
  if (!f.items.length) f.load(f);
}

function fillPage(i) {
  if (i.name != null) $('#pgName').textContent = i.name;
  if (i.sub != null) $('#pgSub').textContent = i.sub;
  const c = $('#pgCover');
  if (i.cover) { c.style.backgroundImage = 'url("' + i.cover + '")'; c.textContent = ''; }
  else if (i.letter) { c.style.backgroundImage = ''; c.textContent = i.letter; }
  if (i.count != null) $('#pgCount').textContent = t('{0} videos', fmt(i.count)) + (i.views ? ' · ' + t('{0} visualizaciones', fmt(i.views)) : '');
  Object.assign(state.pageInfo || {}, i);
}

$('#pgBack').innerHTML = ICON.back;
$('#pgBody').addEventListener('scroll', (e) => {
  const l = e.currentTarget;
  const f = state.pageKey && feeds.get(state.pageKey);
  if (f && l.scrollTop + l.clientHeight > l.scrollHeight - 400) f.load(f);
});

// ---------- Privacidad de las pestañas del perfil ----------
const isMine = (it) => !!(state.me && it && (state.me.secUid === it.secUid || state.me.uniqueId === it.author));
function setProfileTabs(mine, openFavorite) {
  $('#pfTabs [data-list="favorites"]').style.display = mine || openFavorite ? '' : 'none';
  $('#pfTabs [data-list="liked"]').style.display = mine ? '' : 'none';
}
function reopenProfile(p, key) {
  if (!p) return;
  openProfile(p);
  const list = key && key.split(':')[0];
  if (list && list !== 'user' && list !== 'coll') showProfileList(list);
}
// ---------- Interacciones con mensajes del chat (como en la app) ----------
function setChatReply(r) {
  state.chatReply = r;
  const bar = $('#chatReplyBar');
  bar.classList.toggle('show', !!r);
  $('span', bar).textContent = r ? t('Respondiendo a: {0}', r.text || t('Mensaje')) : '';
  if (r) $('#chatInput').focus();
}
$('#chatReplyX').addEventListener('click', () => setChatReply(null));

function reactToMessage(row) {
  if (!chatConv || !row) return;
  const idx = +row.dataset.idx;
  const wrap = row.querySelector('.mwrap') || row;
  if (!row.querySelector('.react')) { wrap.insertAdjacentHTML('beforeend', '<span class="react">❤️</span>'); row.classList.add('reacted'); }
  send({ t: 'dmreact', id: chatConv.id, i: idx, emoji: '❤️' });
}

$('#chatList').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.msg');
  if (!row || e.target.closest('.ft')) return;
  e.preventDefault();
  reactToMessage(row);
});

$('#chatList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.msg');
  if (!row) return;
  e.preventDefault();
  const card = row.querySelector('.vthumb');
  const text = row.dataset.text || '';
  openOptions([[
    { ic: 'heartline', label: t('Reaccionar con ❤️'), fn: () => reactToMessage(row) },
    { ic: 'comment', label: t('Responder'), fn: () => setChatReply({ idx: +row.dataset.idx, text }) },
    text && { ic: 'link', label: t('Copiar'), fn: () => navigator.clipboard.writeText(text).then(() => toast(t('Copiado'))) },
    card && card.dataset.id && { ic: 'play', label: t('Abrir video'), fn: () => openChatVideos(card.dataset.id) },
    card && card.dataset.id && { ic: 'user', label: t('Ver perfil del creador'), fn: () => openCreatorOf(card.dataset.id) },
  ].filter(Boolean)], true);
});

// Nombre del creador debajo de un video compartido: abre su perfil
$('#chatList').addEventListener('click', (e) => {
  const ft = e.target.closest('.vthumb .ft');
  if (!ft) return;
  e.stopPropagation();
  const card = ft.closest('.vthumb');
  if (card && card.dataset.id) openCreatorOf(card.dataset.id);
}, true);

async function openCreatorOf(itemId) {
  const it = await fetchItem(itemId);
  const a = it && it.author;
  if (!a) { toast(t('No se pudo abrir el perfil')); return; }
  openProfile({ secUid: a.secUid, author: a.uniqueId, nick: a.nickname, avatar: a.avatarThumb, authorId: a.id, signature: a.signature });
}
// ---------- Fotos de perfil de los chats: se recuerdan para no depender de la página oculta ----------
const avatarStore = new Map(Object.entries(pref.get('avatars', {})));
function rememberAvatars(convs) {
  let changed = false;
  for (const c of convs) if (c.avatar && avatarStore.get(c.id) !== c.avatar) { avatarStore.set(c.id, c.avatar); changed = true; }
  if (changed) pref.set('avatars', Object.fromEntries([...avatarStore].slice(-300)));
}
const avatarOf = (c) => (c && (c.avatar || avatarStore.get(c.id))) || '';

// ---------- Ir al mensaje citado ----------
let jumpTries = 0;
function jumpToMessage(ref) {
  const key = ref.replace(/\s+/g, ' ').trim().slice(0, 40);
  const target = $$('#chatList .msg').find((m) => (m.dataset.text || '').replace(/\s+/g, ' ').trim().startsWith(key));
  if (target) {
    jumpTries = 0;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1600);
    return;
  }
  // No está cargado todavía: se piden mensajes anteriores y se vuelve a buscar
  if (jumpTries++ >= 6 || noOlder) { jumpTries = 0; toast(t('No se encontró el mensaje original')); return; }
  toast(t('Buscando el mensaje…'));
  requestOlder();
  setTimeout(() => jumpToMessage(ref), 2500);
}
$('#chatList').addEventListener('click', (e) => {
  const r = e.target.closest('.ref[data-ref]');
  if (r) { e.stopPropagation(); jumpTries = 0; jumpToMessage(r.dataset.ref); }
});

// ---------- Indicador de carga (barra fina arriba) ----------
let busyCount = 0, busyTimer;
function busy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  clearTimeout(busyTimer);
  if (busyCount > 0) busyTimer = setTimeout(() => $('#busy').classList.add('show'), 250);
  else $('#busy').classList.remove('show');
}
// ---------- Directos (si no están ocultos): portada con botón para verlos en el navegador ----------
function normalizeLive(it) {
  const a = it.author || {};
  const room = it.liveRoomInfo || {};
  return {
    id: it.id || ('live' + a.id), src: null, photos: [], live: true,
    cover: room.coverUrl || (it.video && it.video.cover) || a.avatarLarger || a.avatarThumb,
    author: a.uniqueId, nick: a.nickname, avatar: a.avatarThumb, authorId: a.id, secUid: a.secUid,
    desc: room.title || it.desc || '', music: '', likes: 0, comments: 0, saves: 0, shares: 0, plays: 0,
    subtitles: [], liked: false, saved: false, followed: false,
  };
}

// ---------- Botón del centro: el logo gira y Ctrl/Shift+clic abre el proyecto en GitHub ----------
(() => {
  const b = $('.nav[data-nav="logo"]');
  if (!b) return;
  b.addEventListener('click', (e) => {
    const img = $('img', b);
    img.classList.remove('spin'); void img.offsetWidth; img.classList.add('spin');
    if (e.ctrlKey || e.shiftKey) setTimeout(() => send({ t: 'open', url: 'https://github.com/TheLucXas/tokdesk' }), 450);
  });
})();

// ---------- Clic afuera de un menú lo cierra (regla común a todos los menús) ----------
document.addEventListener('pointerdown', (e) => {
  const opts = $('#opts');
  if (opts.classList.contains('open') && !opts.contains(e.target)) {
    e.preventDefault(); e.stopPropagation();
    closePanel('opts');
  }
}, true);

// Foto del perfil ampliable
$('#pfAvatar').addEventListener('click', () => { const s = $('#pfAvatar').src; if (s) openViewer(s); });
// ---------- Selector de colecciones (como «Guárdalo en la colección» de la app) ----------
let myCollections = null;
async function openCollectionPicker(it) {
  if (!state.me) return askLogin();
  const body = $('#optsBody');
  body.innerHTML = `<div class="cp-title">${esc(t('Guárdalo en la colección'))}</div><div class="sheet-msg"><div class="spinner"></div></div>`;
  openPanel('opts', true);
  if (!myCollections) {
    const r = await api('GET', '/api/user/collection_list/', { secUid: state.me.secUid, count: 30, cursor: 0 });
    myCollections = (r.data && (r.data.collectionList || r.data.collection_list)) || [];
  }
  renderCollectionPicker(it);
}

function renderCollectionPicker(it) {
  const body = $('#optsBody');
  const rows = myCollections.map((c, i) => {
    const cover = (c.cover && c.cover.urlList && c.cover.urlList[0]) || '';
    const priv = +c.status !== 3;
    return `<div class="cp-row" data-i="${i}">
      <div class="cp-cover">${cover ? `<img alt="" src="${esc(cover)}">` : ICON.folder}</div>
      <div class="cp-tx"><div class="cp-name">${esc(c.name)}${priv ? ' 🔒' : ''}</div><div class="cp-sub">${esc(t('{0} publicaciones', fmt(c.total)))}</div></div>
      <button class="cp-add" title="${esc(t('Agregar'))}">＋</button></div>`;
  }).join('');
  body.innerHTML = `<div class="cp-title">${esc(t('Guárdalo en la colección'))}</div><div class="cp-list">${rows}
    <div class="cp-row cp-new"><div class="cp-cover">${ICON.grid}</div><div class="cp-tx"><div class="cp-name">${esc(t('Crear una nueva colección'))}</div>
    <div class="cp-sub">${esc(t('Organiza las publicaciones para revisarlas rápidamente'))}</div></div><button class="cp-add">＋</button></div></div>`;
  $$('.cp-row[data-i]', body).forEach((r) => r.onclick = () => addToCollection(it, myCollections[+r.dataset.i]));
  $('.cp-new', body).onclick = () => newCollectionForm(it);
}

async function addToCollection(it, c) {
  closePanel('opts');
  if (!it.saved) await favorite(it);
  const ok = await act('/api/collection/modify_items/', { collectionId: c.collectionId, commitIds: it.id });
  if (ok) { toast(t('Guardado en {0}', c.name)); c.total = String((+c.total || 0) + 1); }
}

function newCollectionForm(it) {
  const body = $('#optsBody');
  body.innerHTML = `<div class="cp-title">${esc(t('Crear una nueva colección'))}</div>
    <div class="cp-form"><input id="cpName" maxlength="30" placeholder="${esc(t('Nombre de la colección'))}">
    <label class="cp-pub"><input type="checkbox" id="cpPublic"> ${esc(t('Hacer pública'))}</label>
    <button class="pill" id="cpCreate">${esc(t('Crear'))}</button></div>`;
  $('#cpName').focus();
  $('#cpCreate').onclick = async () => {
    const name = $('#cpName').value.trim();
    if (!name) return;
    const status = $('#cpPublic').checked ? 3 : 1;
    const d = await act('/api/collection/create/', { name, status, collectionName: name, collectionStatus: status });
    if (!d) return;
    const c = { collectionId: d.collectionIdString || String(d.collectionId), name, status, total: '0' };
    myCollections.unshift(c);
    addToCollection(it, c);
  };
}