'use strict';

const A4 = { w: 210, h: 297 }; // mm
const STORAGE_KEY = 'spine-labels.settings';
const LOGO_KEY = 'spine-labels.logo'; // kept apart: a data: URL can be megabytes

const DEFAULTS = {
  names: 'Українська мова\nТекст де багато слів\nСлово',

  width: 50,
  height: 190,

  font: 'Georgia',
  weight: '700',
  autoFit: true,
  fontSize: 36, // pt
  fontMax: 48,  // pt, upper bound for auto-fit

  color: '#2a6f73',
  shadowColor: '#a8d8ea',
  shadowX: 0.4, // mm
  shadowY: 0.4, // mm

  logoOn: true,
  logoData: 'public/logo.png', // path or data: URL
  logoPos: 'bottom',
  logoSize: 75,        // % of label width
  logoMarginTop: 3,    // mm
  logoMarginBottom: 5, // mm

  margin: 10,
  gap: 5,
  cutLines: true,
};

const $ = (selector) => document.querySelector(selector);
const field = (key) => $(`[data-key="${key}"]`);

const settings = loadSettings();

function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    Object.assign(s, JSON.parse(localStorage.getItem(STORAGE_KEY)));
    s.logoData = localStorage.getItem(LOGO_KEY) || s.logoData;
  } catch {}
  return s;
}

function saveSettings() {
  const { logoData, ...rest } = settings;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {}
}

function saveLogo() {
  try {
    localStorage.setItem(LOGO_KEY, settings.logoData);
  } catch {
    showInfo('Лого завелике, щоб зберегти його між сесіями.', true);
  }
}

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return Number(el.value) || 0;
  return el.value;
}

function writeField(el, value) {
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
}

function setSetting(key, value) {
  settings[key] = value;
  writeField(field(key), value);
}

function onChange() {
  saveSettings();
  render();
}

function bindFields() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    writeField(el, settings[key]);
    el.addEventListener('input', () => {
      settings[key] = readField(el);
      onChange();
    });
  }
}

function bindPresets() {
  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      const [w, h] = btn.dataset.preset.split('x').map(Number);
      setSetting('width', w);
      setSetting('height', h);
      onChange();
    });
  }
}

function bindLogoFile() {
  $('#logoFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      settings.logoData = reader.result;
      setSetting('logoOn', true);
      onChange();
      saveLogo();
    };
    reader.readAsDataURL(file);
  });
}

function syncDisabledFields() {
  field('fontSize').disabled = settings.autoFit;
  field('fontMax').disabled = !settings.autoFit;
}

// n*size + (n-1)*gap <= space  =>  n <= (space + gap) / (size + gap)
function fitCount(space, size, gap) {
  if (size <= 0) return 0;
  return Math.max(0, Math.floor((space + gap + 1e-6) / (size + gap)));
}

function computeGrid(s) {
  const cols = fitCount(A4.w - 2 * s.margin, s.width, s.gap);
  const rows = fitCount(A4.h - 2 * s.margin, s.height, s.gap);
  return { cols, rows, perPage: cols * rows };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Georgia lacks U+02BC (Ukrainian apostrophe) and would fall back to another
// font, so swap it for U+2019, which all offered fonts have.
function getNames(s) {
  return s.names
    .split('\n')
    .map((name) => name.trim().replace(/ʼ/g, '’'))
    .filter(Boolean);
}

// Shadow X/Y are relative to the glyphs (X along the line, Y below the letters).
// vertical-rl turns the text 90° clockwise and rotate(180deg) flips it, so in
// the element's own frame "along the line" is +Y and "below" is -X.
function shadowCss(s) {
  return `${-s.shadowY}mm ${s.shadowX}mm 0 ${s.shadowColor}`;
}

function applyCssVars(s, cols) {
  const vars = {
    '--w': s.width + 'mm',
    '--h': s.height + 'mm',
    '--margin': s.margin + 'mm',
    '--gap': s.gap + 'mm',
    '--cols': cols,

    '--font': `"${s.font}", serif`,
    '--weight': s.weight,
    '--font-size': s.fontSize + 'pt',
    '--color': s.color,
    '--shadow': shadowCss(s),

    '--logo-size': s.logoSize + '%',
    '--logo-mt': s.logoMarginTop + 'mm',
    '--logo-mb': s.logoMarginBottom + 'mm',
  };
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function createLogo(s) {
  const img = el('img', 'logo');
  img.src = s.logoData;
  img.alt = '';
  return img;
}

function createLabel(name, s) {
  const label = el('div', 'label');
  label.classList.toggle('cut', s.cutLines);
  label.classList.toggle('logo-top', s.logoPos === 'top');

  const text = el('span', 'text');
  text.textContent = name;

  const box = el('div', 'text-box');
  box.append(text);
  label.append(box);
  resizeObserver.observe(box);
  resizeObserver.observe(text);

  if (s.logoOn && s.logoData) label.append(createLogo(s));
  return label;
}

function createSheet(names, s) {
  const sheet = el('div', 'sheet');
  for (const name of names) sheet.append(createLabel(name, s));
  return sheet;
}

// Measure every text at 100pt and scale linearly so the line length fits the
// box height and the line thickness fits its width. Writes and reads are done
// in separate passes to get a single layout instead of one per label.
function fitAll() {
  if (!settings.autoFit) return;
  const texts = [...document.querySelectorAll('.label .text')];
  if (!texts.length) return;

  const pad = parseFloat(getComputedStyle(texts[0].parentElement).paddingTop) * 2;
  const maxPt = settings.fontMax || Infinity;

  for (const t of texts) t.style.fontSize = '100pt';
  // offset* sizes ignore transforms, so rotate(180deg) doesn't skew them
  const sizes = texts.map((t) => {
    const box = t.parentElement;
    const fit = Math.min((box.clientHeight - pad) / t.offsetHeight, (box.clientWidth - pad) / t.offsetWidth);
    return Math.max(1, Math.min(100 * fit, maxPt));
  });
  texts.forEach((t, i) => { t.style.fontSize = Math.floor(sizes[i] * 10) / 10 + 'pt'; });
}

let fitQueued = false;
function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitAll();
  });
}

// Re-fits whenever a text box or text changes size: logo load, web font load,
// layout changes. After a fit the sizes are stable, so it doesn't loop.
const resizeObserver = new ResizeObserver(scheduleFit);

function showInfo(msg, isError = false) {
  const info = $('#info');
  info.textContent = msg;
  info.className = isError ? 'info error' : 'info';
}

function render() {
  const s = settings;
  const preview = $('#preview');
  const { cols, rows, perPage } = computeGrid(s);
  const names = getNames(s);

  applyCssVars(s, cols);
  syncDisabledFields();
  resizeObserver.disconnect();
  preview.replaceChildren();

  if (perPage === 0) {
    showInfo('Етикетка не влазить на A4 з такими полями.', true);
    return;
  }

  const pages = chunk(names, perPage);
  for (const pageNames of pages) preview.append(createSheet(pageNames, s));
  showInfo(`На аркуші: ${cols} × ${rows} = ${perPage} шт. Етикеток: ${names.length}, аркушів: ${pages.length}.`);
}

function selfCheck() {
  console.assert(fitCount(190, 50, 5) === 3, 'fitCount 50mm');
  console.assert(fitCount(190, 75, 5) === 2, 'fitCount 75mm');
  console.assert(fitCount(277, 190, 5) === 1, 'fitCount height');
  console.assert(fitCount(100, 50, 0) === 2, 'fitCount exact fit');
  console.assert(fitCount(40, 50, 5) === 0, 'fitCount too big');
}

selfCheck();
bindFields();
bindPresets();
bindLogoFile();
$('#printBtn').addEventListener('click', () => window.print());

render();
