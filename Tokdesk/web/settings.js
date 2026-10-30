'use strict';
// Configuración de la app: atajos, apariencia, temas, descargas, actualizaciones y ventana.
// Usa las funciones y el estado globales de app.js.

// ---------- Acciones con atajo de teclado (personalizables) ----------
const ACTIONS = [
  { id: 'next', label: t('Video siguiente'), key: 'ArrowDown', fn: () => go(1) },
  { id: 'prev', label: t('Video anterior'), key: 'ArrowUp', fn: () => go(-1) },
  { id: 'pause', label: t('Pausar / reproducir'), key: ' ', fn: () => togglePause() },
  { id: 'like', label: t('Me gusta'), key: 'L', fn: (it) => it && like(it) },
  { id: 'comments', label: t('Comentarios'), key: 'C', fn: (it) => ($('#sheet').classList.contains('open') ? closePanels() : it && openComments(it)) },
  { id: 'share', label: t('Compartir'), key: 'S', fn: (it) => it && openShare(it) },
  { id: 'save', label: t('Favoritos'), key: 'B', fn: (it) => it && favorite(it) },
  { id: 'download', label: t('Descargar'), key: 'D', fn: (it) => it && openDownloadMenu(it) },
  { id: 'options', label: t('Más opciones'), key: 'O', fn: (it) => openVideoOptions(it) },
  { id: 'profile', label: t('Perfil del autor'), key: 'P', fn: (it) => it && openProfile(it) },
  { id: 'mute', label: t('Silenciar'), key: 'M', fn: () => { setMuted(!state.muted); toast(state.muted ? t('Silenciado') : t('Sonido activado')); } },
  { id: 'volup', label: t('Subir volumen'), key: '+', fn: () => { setVolume(Math.min(1, state.volume + 0.1)); toast(t('Volumen') + ' ' + Math.round(state.volume * 100) + '%'); } },
  { id: 'voldown', label: t('Bajar volumen'), key: '-', fn: () => { setVolume(Math.max(0, state.volume - 0.1)); toast(t('Volumen') + ' ' + Math.round(state.volume * 100) + '%'); } },
  { id: 'seekfwd', label: t('Adelantar 5 s / foto siguiente'), key: 'ArrowRight', fn: (it) => seek(it, 1) },
  { id: 'seekback', label: t('Retroceder 5 s / foto anterior'), key: 'ArrowLeft', fn: (it) => seek(it, -1) },
  { id: 'faster', label: t('Más velocidad'), key: '>', fn: () => stepSpeed(1) },
  { id: 'slower', label: t('Menos velocidad'), key: '<', fn: () => stepSpeed(-1) },
  { id: 'captions', label: t('Subtítulos'), key: 'T', fn: () => setCaptions(!state.cc) },
  { id: 'clean', label: t('Despejar pantalla'), key: 'H', fn: () => toggleClean() },
  { id: 'search', label: t('Buscar'), key: '/', fn: () => openSearch() },
  { id: 'inbox', label: t('Mensajes'), key: 'I', fn: () => openInbox() },
  { id: 'max', label: t('Maximizar ventana'), key: 'F', fn: () => send({ t: 'max' }) },
  { id: 'pip', label: t('Imagen en imagen'), key: 'Shift+P', fn: () => pictureInPicture() },
  { id: 'settings', label: t('Configuración'), key: 'Ctrl+,', fn: () => openSettings() },
  { id: 'help', label: t('Ayuda de atajos'), key: '?', fn: () => openHelp() },
];

function seek(it, dir) {
  const el = current(); if (!el || !it) return;
  if (it.photos.length > 1) el.showPhoto(el.photo + dir);
  else el.media.currentTime += 5 * dir;
}

// Texto de una combinación: "Ctrl+Shift+K", "ArrowDown", "?"
function comboOf(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Shift solo cuenta en teclas que no cambian de símbolo con él
  if (e.shiftKey && (e.key.length > 1 || /[A-Z]/i.test(e.key))) mods.push('Shift');
  return [...mods, key].join('+');
}
const keyOf = (a) => opt.hotkeys[a.id] ?? a.key;
const keyLabel = (k) => ({ ' ': t('Espacio'), ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→' }[k] || k.replace(/^ $/, t('Espacio'))) || '—';

function hotkeyAction(e) {
  const c = comboOf(e);
  return ACTIONS.find((a) => keyOf(a) && keyOf(a).toUpperCase() === c.toUpperCase()) || null;
}
function runAction(a) { a.fn(currentItem()); }

// Captura de una tecla nueva desde Configuración
let capturing = null;
function captureHotkey(e) {
  if (!capturing) return false;
  e.preventDefault();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return true;
  const a = capturing; capturing = null;
  if (e.key === 'Escape') { renderSettings(); return true; }
  const combo = e.key === 'Backspace' || e.key === 'Delete' ? '' : comboOf(e);
  const clash = combo && ACTIONS.find((x) => x !== a && keyOf(x).toUpperCase() === combo.toUpperCase());
  if (clash) { opt.hotkeys[clash.id] = ''; toast(t('Se quitó «{0}» de {1}', keyLabel(combo), clash.label)); }
  opt.hotkeys[a.id] = combo;
  saveOpt();
  renderSettings();
  return true;
}

// ---------- Apariencia ----------
const ACCENTS = ['#fe2c55', '#25f4ee', '#2a72f5', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#ffffff'];
const sysDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyLook() {
  const light = opt.theme === 'light' || (opt.theme === 'system' && !sysDark.matches);
  document.body.classList.toggle('light', light);
  document.documentElement.style.setProperty('--red', opt.accent);
  document.body.classList.toggle('fit-cover', opt.fit === 'cover');
  document.body.classList.toggle('no-counts', !opt.showCounts);
  document.body.classList.toggle('no-disc', !opt.showDisc);
  document.body.classList.toggle('progress-always', opt.progressAlways);
  document.body.classList.toggle('reduce-motion', opt.reduceMotion);
  // En una hoja propia antes del tema del usuario, para que su CSS pueda sobrescribirlas
  $('#uiVars').textContent = `:root { --text-scale: ${opt.textScale / 100}; --chat-font: ${opt.chatFont}px; --live-chat-font: ${opt.liveChatFont}px;
    --live-chat-opacity: ${opt.liveChatOpacity / 100}; --live-chat-width: ${opt.liveChatWidth}px; --panel-width: ${opt.panelWidth}px; }`;
  const th = opt.themes.find((x) => x.name === opt.activeTheme);
  $('#userTheme').textContent = th ? th.css : '';
}
sysDark.addEventListener('change', applyLook);

// ---------- Panel de configuración ----------
let native = null;      // ajustes nativos que manda el programa
let updateState = null; // estado del actualizador
let settingsTab = 'main';

function openSettings(tab = 'main') {
  settingsTab = tab;
  openPanel('settings');
  send({ t: 'getsettings' });
  renderSettings();
}

const row = (o) => o; // marcador de filas, solo por legibilidad
function renderSettings() {
  const body = $('#setBody');
  if (!$('#settings').classList.contains('open')) return;
  const N = native ? native.s : {};
  const sections = {
    main: [
      [t('Cuenta'), [
        row({ type: 'link', ic: 'user', label: state.me ? t('Cuenta: @{0}', state.me.uniqueId) : t('Iniciar sesión'), fn: () => (state.me ? send({ t: 'web', url: 'https://www.tiktok.com/setting' }) : send({ t: 'login' })) }),
        state.me && row({ type: 'link', ic: 'broken', label: t('Cerrar sesión'), danger: true, fn: () => { if (confirm(t('¿Cerrar sesión de TikTok en esta app?'))) send({ t: 'logout' }); } }),
      ]],
      [t('Apariencia'), [
        row({ type: 'select', label: t('Idioma'), value: opt.lang, options: [['auto', t('Automático (idioma de TikTok)')], ...LANGS], fn: (v) => { opt.lang = v; saveOpt(); applyLang(); if (v !== 'auto') send({ t: 'tiktoklang', code: TIKTOK_LANG[v] || v }); } }),
        row({ type: 'seg', label: t('Tema'), value: opt.theme, options: [['dark', t('Oscuro')], ['light', t('Claro')], ['system', t('Sistema')]], fn: (v) => { opt.theme = v; } }),
        row({ type: 'colors', label: t('Color de acento') }),
        row({ type: 'link', ic: 'pencil', label: t('Temas personalizados (CSS)'), fn: () => { settingsTab = 'themes'; renderSettings(); } }),
        row({ type: 'range', label: t('Tamaño de la interfaz'), min: 70, max: 150, step: 5, value: Math.round((N.Zoom || 1) * 100), unit: '%', fn: (v) => send({ t: 'setsetting', k: 'Zoom', v: v / 100 }) }),
        row({ type: 'range', label: t('Tamaño del texto'), hint: t('Solo el texto, sin cambiar el resto de la interfaz'), min: 80, max: 150, step: 5, value: opt.textScale, unit: '%', fn: (v) => { opt.textScale = v; } }),
        row({ type: 'range', label: t('Texto de los mensajes'), min: 11, max: 22, step: 1, value: opt.chatFont, unit: ' px', fn: (v) => { opt.chatFont = v; } }),
        row({ type: 'range', label: t('Texto del chat del LIVE'), min: 10, max: 22, step: 1, value: opt.liveChatFont, unit: ' px', fn: (v) => { opt.liveChatFont = v; } }),
        row({ type: 'range', label: t('Opacidad del chat del LIVE'), min: 30, max: 100, step: 5, value: opt.liveChatOpacity, unit: '%', fn: (v) => { opt.liveChatOpacity = v; } }),
        row({ type: 'range', label: t('Ancho del chat del LIVE'), min: 240, max: 640, step: 20, value: opt.liveChatWidth, unit: ' px', fn: (v) => { opt.liveChatWidth = v; } }),
        row({ type: 'range', label: t('Ancho de los paneles'), hint: t('Comentarios, perfil, búsqueda y mensajes en ventanas anchas'), min: 480, max: 1000, step: 20, value: opt.panelWidth, unit: ' px', fn: (v) => { opt.panelWidth = v; } }),
        row({ type: 'seg', label: t('Ajuste del video'), value: opt.fit, options: [['contain', t('Completo')], ['cover', t('Llenar')]], fn: (v) => { opt.fit = v; } }),
        row({ type: 'toggle', label: t('Mostrar contadores (me gusta, comentarios…)'), value: opt.showCounts, fn: (v) => { opt.showCounts = v; } }),
        row({ type: 'toggle', label: t('Mostrar disco de música'), value: opt.showDisc, fn: (v) => { opt.showDisc = v; } }),
        row({ type: 'toggle', label: t('Barra de progreso siempre gruesa'), value: opt.progressAlways, fn: (v) => { opt.progressAlways = v; } }),
        row({ type: 'toggle', label: t('Reducir animaciones'), value: opt.reduceMotion, fn: (v) => { opt.reduceMotion = v; } }),
      ]],
      [t('Reproducción'), [
        row({ type: 'seg', label: t('Velocidad predeterminada'), value: state.speed, options: SPEEDS.map((s) => [s, s + '×']), fn: (v) => setSpeed(v) }),
        row({ type: 'range', label: t('Volumen'), min: 0, max: 100, step: 1, value: Math.round(state.volume * 100), unit: '%', fn: (v) => setVolume(v / 100) }),
        row({ type: 'toggle', label: t('Empezar silenciado'), value: opt.startMuted, fn: (v) => { opt.startMuted = v; } }),
        row({ type: 'toggle', label: t('Pasar automáticamente'), value: state.auto, fn: (v) => setAuto(v) }),
        row({ type: 'toggle', label: t('Subtítulos'), value: state.cc, fn: (v) => setCaptions(v) }),
        row({ type: 'toggle', label: t('Reproducción en segundo plano'), hint: t('Sigue reproduciendo cuando usas otra ventana'), value: opt.bgPlay, fn: (v) => { opt.bgPlay = v; applyWinState(); } }),
        row({ type: 'toggle', label: t('Silenciar al perder el foco'), hint: t('No se escucha mientras usas otra ventana, con la app minimizada o en la bandeja'), value: !state.bgAudio, fn: (v) => { setBgAudio(!v); applyWinState(); } }),
        row({ type: 'link', ic: 'speed', noChev: !HEVC_OK, label: HEVC_OK ? t('Videos en 1080p (H.265) activados') : t('Ver videos en 1080p: instalar gratis la extensión HEVC'),
          sub: hevcText || (HEVC_OK ? t('Extensión HEVC de Microsoft instalada') : t('Descarga el paquete oficial y gratuito de Microsoft y lo instala. Sin él, TikTok suele mandar los videos en 540–720p.') + ' ' + t('La app se reinicia al terminar.')),
          fn: () => { if (hevcBusy) return; if (HEVC_OK) hevcOptions(); else hevcRun('hevcinstall'); } }),
        row({ type: 'seg', label: t('Calidad de video'), hint: t('Automática usa la mejor disponible'), value: opt.quality, options: [['auto', t('Automática')], ['1080', '1080p'], ['720', '720p'], ['540', '540p']], fn: (v) => { opt.quality = v; } }),
        row({ type: 'toggle', label: t('Ahorro de datos'), hint: t('Usa la versión más liviana de cada video'), value: opt.dataSaver, fn: (v) => { opt.dataSaver = v; } }),
        row({ type: 'seg', label: t('Videos precargados'), value: opt.preload, options: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], fn: (v) => { opt.preload = v; } }),
        row({ type: 'seg', label: t('Búfer en disco'), hint: t('Descarga por adelantado los próximos videos para que arranquen al instante'), value: opt.buffer, options: [[0, '0'], [3, '3'], [5, '5'], [10, '10']], fn: (v) => { opt.buffer = v; } }),
        row({ type: 'toggle', label: t('Ocultar publicidad'), value: opt.hideAds, fn: (v) => { opt.hideAds = v; } }),
        row({ type: 'toggle', label: t('Ocultar directos (LIVE)'), value: opt.hideLives, fn: (v) => { opt.hideLives = v; } }),
        row({ type: 'toggle', label: t('Ocultar comentarios al marcar «no me gusta»'), value: opt.hideDisliked, fn: (v) => { opt.hideDisliked = v; } }),
        row({ type: 'toggle', label: t('Doble clic para dar me gusta'), value: opt.dblLike, fn: (v) => { opt.dblLike = v; } }),
        row({ type: 'range', label: t('Sensibilidad de la rueda'), min: 10, max: 120, step: 5, value: 130 - opt.wheel, fn: (v) => { opt.wheel = 130 - v; } }),
      ]],
      [t('Videos sin conexión'), [
        row({ type: 'seg', label: t('Espacio para videos sin conexión'), hint: t('Mira videos guardados cuando no tengas internet'), value: opt.offlineSize, options: [[0, t('No')], [100, '100 MB'], [1024, '1 GB'], [2048, '2 GB']], fn: (v) => { opt.offlineSize = v; } }),
        row({ type: 'link', ic: 'download', label: offline.busy ? t('Descargando…') : t('Descargar ahora'), sub: offStatus(), fn: () => offlineDownload(false) }),
        row({ type: 'link', ic: 'repost', label: t('Renovar'), sub: t('Borra los guardados y descarga videos nuevos'), fn: () => offlineDownload(true) }),
        row({ type: 'link', ic: 'close', label: t('Borrar videos sin conexión'), fn: () => offList('saved', true) }),
        row({ type: 'link', ic: 'play', label: t('Ver videos sin conexión'), fn: () => openOffline() }),
      ]],
      [t('Descargas'), [
        row({ type: 'toggle', label: t('Preguntar dónde guardar cada archivo'), value: !!N.AskDownloadFolder, fn: (v) => send({ t: 'setsetting', k: 'AskDownloadFolder', v }) }),
        !N.AskDownloadFolder && row({ type: 'link', ic: 'folder', label: t('Carpeta de descargas'), sub: native ? native.downloads : '', fn: () => send({ t: 'pickfolder' }) }),
        row({ type: 'link', ic: 'globe', label: t('Abrir carpeta de descargas'), fn: () => send({ t: 'showfile', file: '' }) }),
      ]],
      [t('Ventana'), [
        row({ type: 'toggle', label: t('Acceso directo en el menú Inicio'), value: !!N.StartMenuShortcut, fn: (v) => send({ t: 'setsetting', k: 'StartMenuShortcut', v }) }),
        row({ type: 'toggle', label: t('Acceso directo en el escritorio'), value: !!N.DesktopShortcut, fn: (v) => send({ t: 'setsetting', k: 'DesktopShortcut', v }) }),
        row({ type: 'toggle', label: t('Iniciar con Windows'), value: !!N.StartWithWindows, fn: (v) => send({ t: 'setsetting', k: 'StartWithWindows', v }) }),
        row({ type: 'toggle', label: t('Iniciar minimizado'), value: !!N.StartMinimized, fn: (v) => send({ t: 'setsetting', k: 'StartMinimized', v }) }),
        row({ type: 'toggle', label: t('Minimizar a la bandeja del sistema'), value: !!N.MinimizeToTray, fn: (v) => send({ t: 'setsetting', k: 'MinimizeToTray', v }) }),
        row({ type: 'toggle', label: t('El botón cerrar minimiza'), value: !!N.CloseToTray, fn: (v) => send({ t: 'setsetting', k: 'CloseToTray', v }) }),
        row({ type: 'toggle', label: t('Siempre visible'), value: !!N.AlwaysOnTop, fn: (v) => send({ t: 'setsetting', k: 'AlwaysOnTop', v }) }),
        row({ type: 'toggle', label: t('Recordar tamaño y posición'), value: N.RememberWindow !== false, fn: (v) => send({ t: 'setsetting', k: 'RememberWindow', v }) }),
        row({ type: 'toggle', label: t('Teclas multimedia del teclado (global)'), hint: t('Reproducir/pausa, siguiente y anterior aunque la app no tenga el foco'), value: !!N.GlobalMediaKeys, fn: (v) => send({ t: 'setsetting', k: 'GlobalMediaKeys', v }) }),
        row({ type: 'toggle', label: t('Aceleración por hardware'), hint: t('Requiere reiniciar la app'), value: N.HardwareAcceleration !== false, fn: (v) => send({ t: 'setsetting', k: 'HardwareAcceleration', v }) }),
      ]],
      [t('Teclado'), [
        row({ type: 'link', ic: 'keyboard', label: t('Atajos de teclado'), fn: () => { settingsTab = 'keys'; renderSettings(); } }),
      ]],
      [t('Actualizaciones'), [
        row({ type: 'update' }),
        row({ type: 'link', ic: 'star', label: t('Novedades'), sub: t('Qué cambió en cada versión'), fn: () => openChangelog() }),
        row({ type: 'toggle', label: t('Buscar actualizaciones al iniciar'), value: N.AutoCheckUpdates !== false, fn: (v) => send({ t: 'setsetting', k: 'AutoCheckUpdates', v }) }),
        row({ type: 'toggle', label: t('Instalar automáticamente'), value: !!N.AutoInstallUpdates, fn: (v) => send({ t: 'setsetting', k: 'AutoInstallUpdates', v }) }),
      ]],
      [t('Notificaciones'), [
        row({ type: 'toggle', label: t('Notificaciones de la app'), hint: t('Avisos de Windows con tu actividad de TikTok'), value: N.Notifications !== false, fn: (v) => send({ t: 'setsetting', k: 'Notifications', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Recibirlas con la app cerrada'), hint: t('Un proceso muy liviano (sin navegador) revisa la actividad y arranca con Windows'), value: N.NotifyBackground !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyBackground', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Mensajes'), hint: t('Solo con la app abierta o en la bandeja'), value: N.NotifyMessages !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyMessages', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Me gusta'), value: N.NotifyLikes !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyLikes', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Comentarios'), value: N.NotifyComments !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyComments', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Menciones y etiquetas'), value: N.NotifyMentions !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyMentions', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Nuevos seguidores'), value: N.NotifyFollowers !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyFollowers', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Otra actividad'), hint: t('Compartidos, republicaciones y similares'), value: N.NotifyOther !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyOther', v }) }),
        N.Notifications !== false && row({ type: 'toggle', label: t('Actualizaciones de Tokdesk'), hint: t('Avisa si hay una versión nueva con la app minimizada o en la bandeja'), value: N.NotifyUpdates !== false, fn: (v) => send({ t: 'setsetting', k: 'NotifyUpdates', v }) }),
        N.Notifications !== false && row({ type: 'seg', label: t('Revisar cada'), value: N.NotifyInterval || 2, options: [[1, '1 min'], [2, '2 min'], [5, '5 min'], [15, '15 min']], fn: (v) => send({ t: 'setsetting', k: 'NotifyInterval', v }) }),
      ]],
      [t('Privacidad y datos'), [
        row({ type: 'link', ic: 'clock', label: t('Historial de reproducciones'), sub: t('Los videos que miraste, guardados solo en este equipo'), fn: () => openHistory() }),
        row({ type: 'link', ic: 'close', label: t('Borrar historial de reproducciones'), fn: () => clearHistory() }),
        row({ type: 'link', ic: 'search', label: t('Borrar historial de búsqueda'), fn: () => { pref.set('searchHistory', []); toast(t('Historial borrado')); } }),
        row({ type: 'link', ic: 'download', label: t('Borrar caché'), fn: () => send({ t: 'clearcache' }) }),
        row({ type: 'link', ic: 'thumbdown', label: t('Borrar «no me gusta» de comentarios'), fn: () => { state.cmtDislikes.clear(); pref.set('cmtDislikes', []); toast(t('Listo')); } }),
        row({ type: 'link', ic: 'folder', label: t('Abrir carpeta de datos y registros'), fn: () => send({ t: 'openfolder' }) }),
        row({ type: 'link', ic: 'autoscroll', label: t('Restablecer configuración'), danger: true, fn: resetSettings }),
      ]],
      ['', [
        row({ type: 'link', ic: 'autoscroll', label: t('Reiniciar la app'), fn: () => send({ t: 'restart' }) }),
        row({ type: 'link', ic: 'close', label: t('Salir de Tokdesk'), danger: true, fn: () => send({ t: 'exit' }) }),
        row({ type: 'info', label: `Tokdesk ${native ? native.version : ''} · ${t('cliente no oficial para TikTok')}` }),
      ]],
    ],
  };

  $('#setTitle').textContent = t({ main: 'Configuración', keys: 'Atajos de teclado', themes: 'Temas personalizados' }[settingsTab]);
  $('#setBack').onclick = () => { if (settingsTab !== 'main') { settingsTab = 'main'; renderSettings(); } else closePanels(); };
  const keep = body.scrollTop;
  body.innerHTML = '';
  if (settingsTab === 'keys') renderKeys(body);
  else if (settingsTab === 'themes') renderThemes(body);
  else {
    const q = ($('#setSearch').value || '').trim().toLowerCase();
    const match = (r) => [r.label, r.hint, r.sub].some((s) => s && String(s).toLowerCase().includes(q));
    let shown = 0;
    for (const [title, rows] of sections.main) {
      const list = rows.filter(Boolean).filter((r) => !q || (title && title.toLowerCase().includes(q)) || match(r));
      if (!list.length) continue;
      shown += list.length;
      if (title) body.insertAdjacentHTML('beforeend', `<div class="set-sec">${esc(title)}</div>`);
      const g = document.createElement('div');
      g.className = 'og';
      for (const r of list) g.appendChild(buildRow(r));
      body.appendChild(g);
    }
    if (!shown) body.insertAdjacentHTML('beforeend', `<div class="sheet-msg">${esc(t('Sin resultados.'))}</div>`);
  }
  $('#setSearch').style.display = settingsTab === 'main' ? '' : 'none';
  body.scrollTop = settingsTab === 'main' ? keep : 0;
}

// Aplica un cambio de preferencia de la interfaz y lo guarda
function changed() { saveOpt(); applyLook(); }

function buildRow(r) {
  const el = document.createElement('div');
  el.className = 'oi set-row' + (r.danger ? ' danger' : '');
  const label = `<span class="lbl"><span>${esc(r.label || '')}</span>${r.hint ? `<small>${esc(r.hint)}</small>` : ''}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>`;
  switch (r.type) {
    case 'toggle': {
      el.innerHTML = label + `<span class="sw ${r.value ? 'on' : ''}"></span>`;
      el.onclick = () => { const sw = $('.sw', el); const v = !sw.classList.contains('on'); sw.classList.toggle('on', v); r.fn(v); changed(); };
      break;
    }
    case 'seg': {
      el.innerHTML = label;
      const seg = document.createElement('span');
      seg.className = 'seg';
      for (const [v, l] of r.options) {
        const b = document.createElement('button');
        b.textContent = l;
        b.classList.toggle('on', v === r.value);
        b.onclick = () => { $$('button', seg).forEach((x) => x.classList.toggle('on', x === b)); r.fn(v); changed(); if (state.feed) render(); };
        seg.appendChild(b);
      }
      el.appendChild(seg);
      break;
    }
    case 'range': {
      el.innerHTML = label + `<span class="rng"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.value}"><b>${r.value}${r.unit || ''}</b></span>`;
      const inp = $('input', el);
      inp.oninput = () => { $('b', el).textContent = inp.value + (r.unit || ''); };
      inp.onchange = () => { r.fn(+inp.value); changed(); };
      break;
    }
    case 'colors': {
      el.innerHTML = label + `<span class="swatches">${ACCENTS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === opt.accent ? 'on' : ''}"></button>`).join('')}<input type="color" value="${opt.accent}" title="Otro color"></span>`;
      $$('[data-c]', el).forEach((b) => b.onclick = () => { opt.accent = b.dataset.c; changed(); renderSettings(); });
      $('input', el).onchange = (e) => { opt.accent = e.target.value; changed(); renderSettings(); };
      break;
    }
    case 'update': {
      const u = updateState || {};
      const text = {
        checking: t('Buscando…'), none: t('Tienes la última versión'), available: t('Disponible: {0}', u.version),
        error: t('No se pudo comprobar'), noconfig: t('Actualizaciones sin configurar'), installing: t('Descargando…') + ' ' + (u.p || 0) + '%',
      }[u.status] || t('Versión {0}', native ? native.version : '');
      el.innerHTML = `<span class="lbl"><span>${t('Buscar actualizaciones')}</span><small>${esc(text)}</small>${u.status === 'available' && u.notes ? `<small>${esc(u.notes).slice(0, 300)}</small>` : ''}</span>
        <button class="pill">${u.status === 'available' ? t('Actualizar') : t('Buscar')}</button>`;
      $('.pill', el).onclick = (e) => {
        e.stopPropagation();
        if (u.status === 'available') { updateState = { status: 'installing', p: 0 }; send({ t: 'installupdate' }); }
        else { updateState = { status: 'checking' }; send({ t: 'checkupdate' }); }
        renderSettings();
      };
      break;
    }
    case 'select': {
      el.innerHTML = label + `<select class="sel">${r.options.map(([v, l]) => `<option value="${esc(v)}" ${v === r.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      $('select', el).onchange = (e) => r.fn(e.target.value);
      break;
    }
    case 'info':
      el.classList.add('info');
      el.innerHTML = label;
      break;
    default: {
      el.innerHTML = `${ICON[r.ic] || ''}${label}${r.noChev ? '' : '<span class="chev">›</span>'}`;
      el.onclick = r.fn;
    }
  }
  return el;
}

function renderKeys(body) {
  body.insertAdjacentHTML('beforeend', '<div class="set-sec">' + t('Haz clic en una tecla para cambiarla. Retroceso la quita; Esc cancela.') + '</div>');
  const g = document.createElement('div');
  g.className = 'og';
  for (const a of ACTIONS) {
    const el = document.createElement('div');
    el.className = 'oi set-row';
    const k = keyOf(a);
    el.innerHTML = `<span class="lbl"><span>${esc(a.label)}</span></span><button class="kbd ${capturing === a ? 'wait' : ''}">${capturing === a ? t('Presiona una tecla…') : esc(k ? keyLabel(k) : t('Sin asignar'))}</button>`;
    $('.kbd', el).onclick = (e) => { e.stopPropagation(); capturing = a; renderSettings(); };
    g.appendChild(el);
  }
  body.appendChild(g);
  const r = document.createElement('div');
  r.className = 'og';
  r.appendChild(buildRow({ type: 'link', ic: 'autoscroll', label: t('Restablecer atajos'), fn: () => { opt.hotkeys = {}; saveOpt(); renderSettings(); toast(t('Atajos restablecidos')); } }));
  body.appendChild(r);
}

const THEME_HELP = `/* Ejemplo: cambia lo que quieras con CSS.
   Variables en :root: --red (color de acento), --text-scale (tamaño del texto, 1 = 100 %),
   --chat-font (texto de los mensajes), --live-chat-font, --live-chat-opacity y --live-chat-width (chat del LIVE),
   --panel-width (ancho de los paneles). Clases útiles: body.light, .panel, .rail, .meta, #bottom, #top, .lv-chat */
:root { --red: #00e0ff; --text-scale: 1.1; }
#bottom { background: #0b0b14; }
.panel.dark, #sheet, #share, #opts { background: #10101a; }
.msg.mine .bub { background: #7c3aed; }`;

function renderThemes(body) {
  const g = document.createElement('div');
  g.className = 'og';
  g.appendChild(buildRow({ type: 'seg', label: t('Tema activo'), value: opt.activeTheme,
    options: [['', t('Ninguno')], ...opt.themes.map((t) => [t.name, t.name])], fn: (v) => { opt.activeTheme = v; } }));
  body.appendChild(g);
  const cur = opt.themes.find((t) => t.name === (opt.editing || opt.activeTheme)) || { name: '', css: '' };
  body.insertAdjacentHTML('beforeend', `<div class="set-sec">${t('Editor')}</div>
    <div class="theme-ed">
      <input id="thName" placeholder="${t('Nombre del tema')}" value="${esc(cur.name)}">
      <textarea id="thCss" spellcheck="false" placeholder="${esc(THEME_HELP)}">${esc(cur.css)}</textarea>
      <div class="theme-btns">
        <button id="thPreview">${t('Vista previa')}</button><button id="thSave" class="primary">${t('Guardar y aplicar')}</button>
        <button id="thDelete">${t('Eliminar')}</button><button id="thExport">${t('Copiar')}</button><button id="thImport">${t('Pegar tema')}</button>
      </div>
    </div>`);
  $('#thPreview').onclick = () => { $('#userTheme').textContent = $('#thCss').value; toast(t('Vista previa (sin guardar)')); };
  $('#thSave').onclick = () => {
    const name = $('#thName').value.trim() || t('Mi tema');
    const css = $('#thCss').value;
    const i = opt.themes.findIndex((t) => t.name === name);
    if (i >= 0) opt.themes[i].css = css; else opt.themes.push({ name, css });
    opt.activeTheme = name; opt.editing = name;
    changed(); renderSettings(); toast(t('Tema guardado'));
  };
  $('#thDelete').onclick = () => {
    const name = $('#thName').value.trim();
    opt.themes = opt.themes.filter((t) => t.name !== name);
    if (opt.activeTheme === name) opt.activeTheme = '';
    opt.editing = '';
    changed(); renderSettings();
  };
  $('#thExport').onclick = () => navigator.clipboard.writeText(JSON.stringify({ name: $('#thName').value, css: $('#thCss').value })).then(() => toast(t('Tema copiado')));
  $('#thImport').onclick = async () => {
    try {
      const t = JSON.parse(await navigator.clipboard.readText());
      $('#thName').value = t.name || ''; $('#thCss').value = t.css || '';
      toast(t('Tema pegado: revisa y guarda'));
    } catch { toast(t('El portapapeles no tiene un tema válido')); }
  };
}

function resetSettings() {
  if (!confirm(t('¿Restablecer toda la configuración de la interfaz?'))) return;
  for (const k of ['opt', 'speed', 'volume', 'muted', 'auto', 'cc', 'bgAudio']) pref.set(k, null);
  try { Object.keys(localStorage).filter((k) => k.startsWith('tp.')).forEach((k) => localStorage.removeItem(k)); } catch { }
  location.reload();
}

// ---------- Descargas ----------
function openDownloadMenu(it) {
  if (!it) return;
  const base = `${it.author}_${it.id}`;
  const dl = (url, ext, suffix = '') => url ? () => startDownload(url, base + suffix, ext) : null;
  const items = it.photos.length
    ? it.photos.map((p, i) => ({ ic: 'download', label: t('Foto {0} (JPG)', i + 1), fn: dl(p, 'jpg', '_' + (i + 1)) }))
    : [
      { ic: 'download', label: t('Video sin marca de agua (MP4)'), fn: dl(it.src, 'mp4') },
      it.bestSrc && it.bestSrc !== it.src && { ic: 'download', label: t('Video en la mejor calidad (MP4)'), fn: dl(it.bestSrc, 'mp4', '_hq') },
      it.watermarkSrc && { ic: 'download', label: t('Video original con marca de agua (MP4)'), fn: dl(it.watermarkSrc, 'mp4', '_tiktok') },
    ];
  openOptions([
    items.filter((x) => x && x.fn),
    [
      it.musicUrl && { ic: 'music', label: t('Solo audio (MP3)'), fn: dl(it.musicUrl, 'mp3', '_audio') },
      it.cover && { ic: 'grid', label: t('Portada (JPG)'), fn: dl(it.cover, 'jpg', '_portada') },
    ].filter(Boolean),
    [{ ic: 'folder', label: t('Abrir carpeta de descargas'), fn: () => send({ t: 'showfile', file: '' }) }],
  ]);
}

let dlRid = 0;
const downloads = new Map();
function startDownload(url, name, ext) {
  const rid = ++dlRid;
  downloads.set(rid, { name: name + '.' + ext });
  notice(t('Descargando {0}…', name + '.' + ext), null, null, rid);
  send({ t: 'download', url, name, ext, rid });
}

// Aviso inferior con acción opcional (por ejemplo "Mostrar en carpeta")
let noticeTimer;
function notice(text, action, fn, sticky) {
  const n = $('#notice');
  n.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) $('button', n).onclick = () => { n.classList.remove('show'); fn(); };
  n.classList.add('show');
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(() => n.classList.remove('show'), action ? 6000 : 2500);
}

function onDownload(m) {
  const d = downloads.get(m.rid) || { name: '' };
  if (m.state === 'progress') notice(t('Descargando {0}…', d.name) + ' ' + (m.p >= 0 ? m.p + '%' : ''), null, null, true);
  else if (m.state === 'done') { downloads.delete(m.rid); notice(t('Guardado: {0}', m.name), t('Mostrar en carpeta'), () => send({ t: 'showfile', file: m.file })); }
  else if (m.state === 'cancel') { downloads.delete(m.rid); $('#notice').classList.remove('show'); }
  else { downloads.delete(m.rid); notice(t('No se pudo descargar {0}', d.name)); }
}

// ---------- Reproducción con la ventana minimizada o sin foco ----------
let win = { minimized: false, focused: true };
function applyWinState() {
  const el = current(); if (!el) return;
  const shouldPause = (win.minimized && !state.bgAudio) || (!win.minimized && !win.focused && !opt.bgPlay);
  // Sin «Audio de fondo», la app no se escucha mientras otra ventana tiene el foco (el video sigue sin sonido)
  const shouldMute = !win.focused && !state.bgAudio && !document.pictureInPictureElement;
  if (shouldMute && !el.media.muted) { el.dataset.autoMuted = '1'; el.media.muted = true; }
  else if (!shouldMute && el.dataset.autoMuted) { delete el.dataset.autoMuted; el.media.muted = state.muted; }
  if (shouldPause && !el.media.paused && !document.pictureInPictureElement) {
    el.dataset.autoPaused = '1'; el.media.pause();
  } else if (!shouldPause && el.dataset.autoPaused) {
    delete el.dataset.autoPaused; el.media.play().catch(() => { });
  }
}

// ---------- Mensajes del programa que no maneja app.js ----------
function onHostMessage(m) {
  switch (m.t) {
    case 'settings':
      native = m; renderSettings();
      // Primera vez con una versión nueva: aviso con acceso a las novedades
      if (m.version) {
        const last = pref.get('lastVersion', null);
        // Tras actualizar (la app ya se reinició en la versión nueva) se abren solas las novedades
        if (last && last !== m.version) setTimeout(openChangelog, 1500);
        if (last !== m.version) pref.set('lastVersion', m.version);
      }
      break;
    case 'update':
      updateState = m;
      if (m.status === 'available' && !m.manual) notice(t('Nueva versión {0} disponible', m.version), t('Actualizar'), () => { updateState = { status: 'installing', p: 0 }; send({ t: 'installupdate' }); notice(t('Descargando actualización…'), null, null, true); });
      else if (m.manual && m.status === 'none') toast(t('Ya tienes la última versión'));
      else if (m.manual && m.status === 'error') toast(t('No se pudo buscar actualizaciones'));
      renderSettings();
      break;
    case 'updprogress':
      updateState = { status: 'installing', p: m.p };
      notice(t('Descargando actualización…') + ' ' + m.p + '%', null, null, true);
      renderSettings();
      break;
    case 'dl': onDownload(m); break;
    case 'hevc': onHevc(m); break;
    case 'offsaved': onOffSaved(m); break;
    case 'offlist': onOffList(m); break;
    case 'win': win = m; applyWinState(); break;
    case 'hotkey':
      if (m.a === 'toggle') togglePause(); else if (m.a === 'next') go(1); else if (m.a === 'prev') go(-1);
      break;
  }
}

// ---------- Botón de configuración ----------
$('#btnSettings').innerHTML = ICON.gear;
$('#btnSettings').addEventListener('click', () => openSettings());
$('#setBack').innerHTML = ICON.back;
applyLook();
applyLang();

// Códigos de idioma que usa la web de TikTok para cada idioma de la app
const TIKTOK_LANG = {
  en: 'en', es: 'es', pt: 'pt-BR', fr: 'fr', de: 'de-DE', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL', ro: 'ro-RO', cs: 'cs-CZ',
  hu: 'hu-HU', el: 'el-GR', sv: 'sv-SE', da: 'da', nb: 'nb-NO', fi: 'fi-FI', ru: 'ru-RU', uk: 'uk-UA', tr: 'tr-TR', ar: 'ar',
  he: 'he-IL', ur: 'ur', hi: 'hi-IN', bn: 'bn-IN', id: 'id-ID', ms: 'ms-MY', jv: 'jv-ID', ceb: 'ceb-PH', fil: 'fil-PH',
  vi: 'vi-VN', th: 'th-TH', km: 'km-KH', my: 'my-MM', ja: 'ja-JP', ko: 'ko-KR', 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant-TW',
};

$('#setSearch').addEventListener('input', () => renderSettings());
// Textos traducidos para el notificador liviano (corre fuera de la app y no tiene las traducciones)
function sendNotifyStrings() {
  send({ t: 'notifystrings', lang: TIKTOK_LANG[uiLang] || uiLang, s: {
    comment: t('comentó: {0}'), reply: t('respondió a tu comentario: {0}'), mention: t('te mencionó: {0}'),
    follow: t('comenzó a seguirte'), more: t('y {0} más'), andmore: t('y {0} más'),
    open: t('Abrir Tokdesk'), pause: t('Pausar 1 hora'), quit: t('Salir'),
  } });
}
// Instalación de la extensión HEVC gratuita de Microsoft: el estado se ve en la misma fila y en un aviso
let hevcBusy = false, hevcText = '';
function onHevc(m) {
  if (m.state === 'resolving') hevcText = t('Buscando la extensión HEVC en Microsoft…');
  else if (m.state === 'removing') hevcText = t('Desinstalando la extensión HEVC…');
  else if (m.state === 'downloading') hevcText = t('Descargando la extensión HEVC… {0}%', m.p);
  else if (m.state === 'installing') hevcText = t('Instalando la extensión HEVC…');
  else if (m.state === 'done') hevcText = t('Extensión HEVC instalada. Reiniciando la app…');
  else if (m.state === 'removed') hevcText = t('Extensión HEVC desinstalada. Reiniciando la app…');
  else if (m.state === 'error') { hevcBusy = false; hevcText = t('No se pudo instalar la extensión HEVC: {0}', m.msg || ''); }
  notice(hevcText, null, null, m.state !== 'error');
  // El navegador solo detecta el cambio de códecs al reiniciar
  if (m.state === 'done' || m.state === 'removed') setTimeout(() => send({ t: 'restart' }), 2000);
  if (document.querySelector('#settings').classList.contains('open')) renderSettings();
}

function hevcRun(action) { hevcBusy = true; onHevc({ state: action === 'hevcuninstall' ? 'removing' : 'resolving' }); send({ t: action }); }
function hevcOptions() {
  openOptions([[
    { ic: 'download', label: t('Reinstalar o reparar la extensión HEVC'), fn: () => { closePanel('opts'); hevcRun('hevcreinstall'); } },
    { ic: 'close', label: t('Desinstalar la extensión HEVC'), danger: true, fn: () => { closePanel('opts'); hevcRun('hevcuninstall'); } },
  ]], true);
}
// ---------- Novedades: notas de cada versión, tomadas de las releases de GitHub ----------
function mdLite(md) {
  // Markdown mínimo de las notas: títulos, negritas, listas y párrafos
  return esc(md || '').split(/\r?\n/).map((l) => {
    const b = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    if (/^#{1,6}\s/.test(l)) return `<div class="cl-h">${b.replace(/^#+\s*/, '')}</div>`;
    if (/^\s*[-*]\s/.test(l)) return `<div class="cl-li">${b.replace(/^\s*[-*]\s/, '')}</div>`;
    return l.trim() ? `<p>${b}</p>` : '';
  }).join('');
}
async function openChangelog() {
  const body = $('#optsBody');
  body.innerHTML = `<div class="cp-title">${esc(t('Novedades'))}</div><div class="sheet-msg"><div class="spinner"></div></div>`;
  openPanel('opts', true);
  let list = null;
  try {
    const r = await fetch('https://api.github.com/repos/TheLucXas/tokdesk/releases?per_page=20', { headers: { Accept: 'application/vnd.github+json' } });
    if (r.ok) list = await r.json();
  } catch { }
  if (!$('#opts').classList.contains('open')) return;
  if (!Array.isArray(list) || !list.length) {
    body.innerHTML = `<div class="cp-title">${esc(t('Novedades'))}</div><div class="sheet-msg">${esc(t('No se pudieron cargar las novedades.'))}</div>`;
    return;
  }
  const cur = native && native.version;
  body.innerHTML = `<div class="cp-title">${esc(t('Novedades'))}</div>` + list.map((rel) => {
    const v = (rel.tag_name || '').replace(/^v/, '');
    const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString(uiLang) : '';
    return `<div class="cl-rel"><div class="cl-top"><b>${esc(rel.name || rel.tag_name)}</b>${v === cur ? `<span class="cl-cur">${esc(t('Tu versión'))}</span>` : ''}<span class="cl-date">${esc(date)}</span></div>${mdLite(rel.body)}</div>`;
  }).join('');
}