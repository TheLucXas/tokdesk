'use strict';
// Traducciones: el texto en español es la clave; cada idioma vive en i18n/<código>.json.
// Si falta una traducción se muestra el texto original.

// Idiomas que ofrece TikTok (código propio → nombre en su idioma)
const LANGS = [
  ['en', 'English'], ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['ro', 'Română'], ['cs', 'Čeština'], ['hu', 'Magyar'], ['el', 'Ελληνικά'],
  ['sv', 'Svenska'], ['da', 'Dansk'], ['nb', 'Norsk'], ['fi', 'Suomi'], ['ru', 'Русский'], ['uk', 'Українська'],
  ['tr', 'Türkçe'], ['ar', 'العربية'], ['he', 'עברית'], ['ur', 'اردو'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'],
  ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['jv', 'Basa Jawa'], ['ceb', 'Cebuano'], ['fil', 'Filipino'],
  ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['km', 'ខ្មែរ'], ['my', 'မြန်မာ'], ['ja', '日本語'], ['ko', '한국어'],
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'],
];
const RTL = ['ar', 'he', 'ur'];

let dict = {};
let uiLang = 'es';

function t(s, ...args) {
  let r = (dict && dict[s]) || s;
  args.forEach((a, i) => { r = r.replace('{' + i + '}', a); });
  return r;
}

// Convierte un código de idioma de TikTok o del sistema ("es-419", "zh-Hant-TW", "pt_BR") al nuestro
function matchLang(code) {
  if (!code) return null;
  const c = String(code).replace('_', '-').toLowerCase();
  if (c.startsWith('zh')) return /hant|tw|hk|mo/.test(c) ? 'zh-Hant' : 'zh-Hans';
  if (c === 'no' || c.startsWith('nn') || c.startsWith('nb')) return 'nb';
  if (c.startsWith('tl') || c.startsWith('fil')) return 'fil';
  if (c.startsWith('iw')) return 'he';
  if (c.startsWith('in')) return 'id';
  const base = c.split('-')[0];
  const hit = LANGS.find(([k]) => k.toLowerCase() === base);
  return hit ? hit[0] : null;
}

// Idioma de la página de TikTok (lo manda el programa) o del sistema; si no hay ninguno compatible, inglés
let tiktokLang = null;
function resolveLang() {
  if (opt.lang && opt.lang !== 'auto') return opt.lang;
  return matchLang(tiktokLang) || matchLang(navigator.language) || 'en';
}

async function applyLang() {
  const lang = resolveLang();
  if (lang !== 'es') {
    try { dict = await (await fetch(`i18n/${lang}.json`)).json(); } catch { dict = {}; }
  } else dict = {};
  uiLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr';
  translateDom();
  if (typeof renderSettings === 'function') renderSettings();
  if (typeof renderInbox === 'function') renderInbox();
  if (typeof sendNotifyStrings === 'function') sendNotifyStrings();
}

// Textos fijos del HTML: data-i18n (texto), data-i18n-ph (placeholder), data-i18n-title (tooltip)
function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    if (!el.dataset.src) el.dataset.src = el.textContent.trim();
    el.textContent = t(el.dataset.src);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    if (!el.dataset.srcPh) el.dataset.srcPh = el.placeholder;
    el.placeholder = t(el.dataset.srcPh);
  });
  root.querySelectorAll('[title]').forEach((el) => {
    if (!el.dataset.srcTitle) el.dataset.srcTitle = el.title;
    el.title = t(el.dataset.srcTitle);
  });
}
