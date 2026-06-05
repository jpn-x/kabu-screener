'use strict';

// ── State ────────────────────────────────────────────────────
const VOL_FIELD_MAP = {
  '当日': 'intraday_vol',
  '3日平均': 'vol_3d',
  '5日平均': 'vol_5d',
  '20日平均': 'vol_20d',
};

const state = {
  allStocks: [],
  ptsList: [],
  filtered: [],
  ptsMode: false,
  updatedAt: '',
  sortKey: 'intraday_vol',
  volPeriod: '当日',
  filters: {
    pages: ['売買代金','出来高','値上がり率','値下がり率','ストップ高','ストップ安'],
    market: '全市場',
    minVol: 5.0,
    minTv: 2.5,
    minChange: 5.0,
  },
};

const DATA_URL = 'data/results.json';

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $q = sel => document.querySelector(sel);

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildFilterUI();
  bindEvents();
  loadData();
});

// ── Data loading ─────────────────────────────────────────────
async function loadData(showSpinner = true) {
  if (showSpinner) showLoading(true);
  setRefreshAnim(true);
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.allStocks = json.stocks || [];
    state.ptsList   = json.pts    || [];
    state.updatedAt = json.updated_at_display || '';
    if (state.ptsMode) renderPts(state.ptsMode);
    else applyFilters();
    $('last-update').textContent = `更新: ${state.updatedAt}`;
  } catch (e) {
    showToast('データ取得失敗: ' + e.message);
    renderEmpty('データを取得できませんでした');
  } finally {
    showLoading(false);
    setRefreshAnim(false);
  }
}

// ── PTS mode ─────────────────────────────────────────────────
function renderPts(kind) {
  state.ptsMode = kind;
  const list = $('results');
  const data = state.ptsList.filter(s => s.source === kind);
  $('count-badge').textContent = `${data.length}件`;
  $('last-update').textContent = `更新: ${state.updatedAt}`;

  if (!data.length) {
    list.innerHTML = '';
    renderEmpty('PTSデータがありません（市場時間外か未更新）');
    return;
  }
  $('empty-state').style.display = 'none';

  // 前日比絶対値降順
  data.sort((a,b) => Math.abs(b.pts_change_pct||0) - Math.abs(a.pts_change_pct||0));

  list.innerHTML = data.map(s => {
    const up = (s.pts_change_pct||0) >= 0;
    const chgStr = s.pts_change_pct != null ? `${s.pts_change_pct>=0?'+':''}${s.pts_change_pct.toFixed(2)}%` : '-';
    const closeStr = s.close  != null ? s.close.toLocaleString()     : '-';
    const ptsStr   = s.pts_price != null ? s.pts_price.toLocaleString() : '-';

    let matHTML = '';
    if (s.material_text) {
      const isIR = s.material_text.startsWith('[IR');
      const cardCls = isIR ? 'card-material ir' : 'card-material';
      const badge = isIR ? `<span class="material-badge badge-ir">IR</span>`
                         : `<span class="material-badge badge-minkabu">みんかぶ</span>`;
      const clean = s.material_text.replace(/^\[.*?\]\s*/,'');
      const hasAll = s.material_all && s.material_all.length > 0;
      matHTML = `<div class="${cardCls}" data-code="${s.code}" data-url="${s.material_url||''}" data-all="${encodeURIComponent(s.material_all||'')}">
        ${badge}<span class="${isIR?'material-text ir-text':'material-text'}">${escHtml(clean)}</span>
        <span class="material-link-icon">${hasAll?'📋':'↗'}</span></div>`;
    }

    return `<div class="stock-card ${up?'up':'down'}" data-code="${s.code}">
      <div class="card-top">
        <div class="card-left">
          <div class="card-code">${s.code}</div>
          <div class="card-name">${escHtml(s.name)}</div>
        </div>
        <div class="card-right">
          <div class="card-market">${escHtml(s.market||'')}</div>
          <div class="card-source" style="color:${up?'#ff6b6b':'#51cf66'};font-weight:700;">${chgStr}</div>
        </div>
      </div>
      <div class="card-metrics">
        <div class="metric"><div class="metric-label">通常終値</div><div class="metric-value">¥${closeStr}</div></div>
        <div class="metric"><div class="metric-label">PTS価格</div><div class="metric-value" style="color:#ffd700;font-weight:700;">¥${ptsStr}</div></div>
        <div class="metric"><div class="metric-label">PTS変化</div><div class="metric-value ${up?'up':'down'}">${chgStr}</div></div>
        <div class="metric"><div class="metric-label">種別</div><div class="metric-value" style="font-size:11px;">${escHtml(s.source)}</div></div>
      </div>
      ${matHTML}
    </div>`;
  }).join('');

  // イベント
  list.querySelectorAll('.card-material').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const all = el.dataset.all, url = el.dataset.url, code = el.dataset.code;
      if (all) openMaterialModal(code, url, all);
      else if (url) window.open(url, '_blank');
    });
  });
  list.querySelectorAll('.stock-card').forEach(el => {
    el.addEventListener('click', () => window.open(`https://kabutan.jp/stock/news?code=${el.dataset.code}`, '_blank'));
  });
}

function exitPtsMode() {
  state.ptsMode = false;
  // PTSボタンの選択状態をリセット
  document.querySelectorAll('.pts-btn').forEach(b => b.classList.remove('pts-active'));
  applyFilters();
}

// ── Filter logic ─────────────────────────────────────────────
function getVolField() {
  return VOL_FIELD_MAP[state.volPeriod] || 'intraday_vol';
}

function applyFilters() {
  const f = state.filters;
  const volField = getVolField();
  state.filtered = state.allStocks.filter(s => {
    if (f.market !== '全市場') {
      const mkt = s.market || '';
      // JPX形式「プライム（内国株式）」と旧形式「東P」両対応
      const ok = mkt.includes(f.market) ||
        (f.market === 'プライム'     && (mkt.includes('東P') || mkt.includes('Ｐ'))) ||
        (f.market === 'スタンダード' && (mkt.includes('東S') || mkt.includes('Ｓ'))) ||
        (f.market === 'グロース'     && (mkt.includes('東G') || mkt.includes('Ｇ')));
      if (!ok) return false;
    }
    if (f.pages.length && !f.pages.includes(s.source)) return false;
    if (f.minVol > 0 && (s[volField] == null || s[volField] < f.minVol)) return false;
    if (f.minTv > 0  && (s.trading_value == null || s.trading_value < f.minTv)) return false;
    if (f.minChange > 0 && (s.change_pct == null || Math.abs(s.change_pct) < f.minChange)) return false;
    return true;
  });
  sortStocks();
}

function sortStocks() {
  const key = state.sortKey === 'intraday_vol' ? getVolField() : state.sortKey;
  state.filtered.sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    if (key === 'change_pct') return Math.abs(bv) - Math.abs(av);
    return bv - av;
  });
  render();
}

// ── Render ───────────────────────────────────────────────────
function render() {
  const list = $('results');
  const count = state.filtered.length;
  $('count-badge').textContent = `${count}件`;

  if (count === 0) {
    list.innerHTML = '';
    renderEmpty('条件に合う銘柄がありません');
    return;
  }
  $('empty-state').style.display = 'none';

  list.innerHTML = state.filtered.map(s => cardHTML(s)).join('');

  // Material click handlers
  list.querySelectorAll('.card-material').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const code = el.dataset.code;
      const url  = el.dataset.url;
      const all  = el.dataset.all;
      if (all) {
        openMaterialModal(code, url, all);
      } else if (url) {
        window.open(url, '_blank');
      }
    });
  });

  // Card tap → kabutan news
  list.querySelectorAll('.stock-card').forEach(el => {
    el.addEventListener('click', () => {
      const code = el.dataset.code;
      window.open(`https://kabutan.jp/stock/news?code=${code}`, '_blank');
    });
  });
}

function cardHTML(s) {
  const up = (s.change_pct ?? 0) >= 0;
  const chgClass = up ? 'up' : 'down';
  const chgStr   = s.change_pct != null ? `${s.change_pct >= 0 ? '+' : ''}${s.change_pct.toFixed(2)}%` : '-';
  const volField = getVolField();
  const volVal   = s[volField];
  const volStr   = volVal != null ? `${volVal.toFixed(1)}%` : '-';
  const volLabel = state.volPeriod === '当日' ? 'ボラ' : `ボラ(${state.volPeriod})`;
  const tvStr    = s.trading_value   != null ? `${s.trading_value.toFixed(1)}億`      : '-';
  const closeStr = s.close           != null ? s.close.toLocaleString()                : '-';
  const mcapStr  = s.market_cap      != null ? `${s.market_cap.toLocaleString()}億`   : '-';
  const ytd      = s.ytd_perf;
  const ytdStr   = ytd != null ? `${ytd >= 0 ? '+' : ''}${ytd.toFixed(1)}%`           : '-';
  const ytdClass = ytd != null ? (ytd >= 0 ? 'up' : 'down') : '';
  const yspStr   = s.year_start_price != null ? `¥${s.year_start_price.toLocaleString()}` : '-';
  const mktAbbr  = (s.market||'').includes('プライム') ? 'プラ'
                 : (s.market||'').includes('スタンダード') ? 'スタ'
                 : (s.market||'').includes('グロース') ? 'グロ'
                 : (s.market||'').slice(0,3);

  let matHTML = '';
  if (s.material_text) {
    const text = s.material_text;
    const isIR = text.startsWith('[IR');
    const isMinka = text.startsWith('[みんかぶ]');
    const cardClass = isIR ? 'card-material ir' : 'card-material';
    const badge = isIR
      ? `<span class="material-badge badge-ir">IR</span>`
      : isMinka
        ? `<span class="material-badge badge-minkabu">みんかぶ</span>`
        : `<span class="material-badge badge-kabutan">株探</span>`;
    const cleanText = text.replace(/^\[.*?\]\s*/, '');
    const textClass = isIR ? 'material-text ir-text' : 'material-text';
    const hasAll = s.material_all && s.material_all.length > 0;
    matHTML = `
      <div class="${cardClass}" data-code="${s.code}" data-url="${s.material_url || ''}" data-all="${encodeURIComponent(s.material_all || '')}">
        ${badge}
        <span class="${textClass}">${escHtml(cleanText)}</span>
        <span class="material-link-icon">${hasAll ? '📋' : '↗'}</span>
      </div>`;
  }

  return `
    <div class="stock-card ${chgClass}" data-code="${s.code}">
      <div class="card-top">
        <div class="card-left">
          <div class="card-code">${s.code}</div>
          <div class="card-name">${escHtml(s.name)}</div>
        </div>
        <div class="card-right">
          <div class="card-market">${mktAbbr}</div>
          <div class="card-source">${escHtml(s.source)}</div>
        </div>
      </div>
      <div class="card-metrics">
        <div class="metric">
          <div class="metric-label">終値</div>
          <div class="metric-value">¥${closeStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">前日比</div>
          <div class="metric-value ${chgClass}">${chgStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">${volLabel}</div>
          <div class="metric-value accent">${volStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">売買代金</div>
          <div class="metric-value">${tvStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">時価総額</div>
          <div class="metric-value">${mcapStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">年パフォ</div>
          <div class="metric-value ${ytdClass}">${ytdStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">年初株価</div>
          <div class="metric-value">${yspStr}</div>
        </div>
        <div class="metric">
          <div class="metric-label">ランキング元</div>
          <div class="metric-value" style="font-size:10px;">${escHtml(s.source)}</div>
        </div>
      </div>
      ${matHTML}
    </div>`;
}

function renderEmpty(msg) {
  const el = $('empty-state');
  el.querySelector('p').textContent = msg;
  el.style.display = 'block';
}

// ── Filter UI builder ─────────────────────────────────────────
const PAGE_OPTIONS    = ['売買代金','出来高','値上がり率','値下がり率','ストップ高','ストップ安'];
const MARKET_OPTIONS  = ['全市場','プライム','スタンダード','グロース'];
const SORT_OPTIONS    = [
  { key: 'intraday_vol',  label: 'ボラ順' },
  { key: 'change_pct',    label: '騰落率順' },
  { key: 'trading_value', label: '売買代金順' },
];

function buildFilterUI() {
  // データソースボタン
  const pgContainer = $('page-btns');
  PAGE_OPTIONS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tog-btn' + (state.filters.pages.includes(p) ? ' active' : '');
    btn.textContent = p;
    btn.onclick = () => {
      const f = state.filters.pages;
      const idx = f.indexOf(p);
      if (idx >= 0) { if (f.length > 1) f.splice(idx, 1); }
      else f.push(p);
      btn.classList.toggle('active', f.includes(p));
    };
    pgContainer.appendChild(btn);
  });

  // 市場ボタン
  const mktContainer = $('market-btns');
  MARKET_OPTIONS.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'tog-btn' + (state.filters.market === m ? ' active' : '');
    btn.textContent = m;
    btn.onclick = () => {
      state.filters.market = m;
      mktContainer.querySelectorAll('.tog-btn').forEach(b =>
        b.classList.toggle('active', b.textContent === m));
    };
    mktContainer.appendChild(btn);
  });

  // 期間ごとの推奨ボラ閾値
  const VOL_SUGGEST = { '当日': 5.0, '3日平均': 4.0, '5日平均': 3.5, '20日平均': 2.0 };

  // ボラ期間ボタン
  const vpContainer = $('vol-period-btns');
  Object.keys(VOL_FIELD_MAP).forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tog-btn' + (state.volPeriod === p ? ' active' : '');
    btn.textContent = p;
    btn.onclick = () => {
      state.volPeriod = p;
      vpContainer.querySelectorAll('.tog-btn').forEach(b =>
        b.classList.toggle('active', b.textContent === p));
      // 推奨閾値に自動調整
      const suggested = VOL_SUGGEST[p] ?? 5.0;
      const slider = $('slider-vol');
      const label  = $('val-vol');
      if (slider) {
        slider.value = suggested;
        label.textContent = `${suggested.toFixed(1)}%`;
        state.filters.minVol = suggested;
      }
      applyFilters();
    };
    vpContainer.appendChild(btn);
  });

  // ソートチップ
  const sortBar = $('sort-bar');
  SORT_OPTIONS.forEach(opt => {
    const chip = document.createElement('button');
    chip.className = 'sort-chip' + (state.sortKey === opt.key ? ' active' : '');
    chip.textContent = opt.label;
    chip.onclick = () => {
      state.sortKey = opt.key;
      sortBar.querySelectorAll('.sort-chip').forEach(c =>
        c.classList.toggle('active', c.textContent === opt.label));
      sortStocks();
    };
    sortBar.appendChild(chip);
  });

  // スライダー初期値
  syncSliderUI('vol',    state.filters.minVol);
  syncSliderUI('tv',     state.filters.minTv);
  syncSliderUI('change', state.filters.minChange);
}

function syncSliderUI(id, val) {
  const slider = $(`slider-${id}`);
  const label  = $(`val-${id}`);
  if (!slider) return;
  slider.value = val;
  const unit = id === 'tv' ? '億' : '%';
  label.textContent = `${val.toFixed(1)}${unit}`;
}

// ── Events ───────────────────────────────────────────────────
function bindEvents() {
  // Filter toggle
  $('filter-toggle').addEventListener('click', () => {
    const body = $('filter-body');
    const btn  = $('filter-toggle');
    body.classList.toggle('open');
    btn.classList.toggle('open');
  });

  // Sliders
  ['vol', 'tv', 'change'].forEach(id => {
    const slider = $(`slider-${id}`);
    const label  = $(`val-${id}`);
    if (!slider) return;
    const unit = id === 'tv' ? '億' : '%';
    const step = id === 'tv' ? 0.5 : 0.5;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      label.textContent = `${v.toFixed(1)}${unit}`;
      if (id === 'vol')    state.filters.minVol    = v;
      if (id === 'tv')     state.filters.minTv     = v;
      if (id === 'change') state.filters.minChange = v;
    });
  });

  // Run button
  $('run-btn').addEventListener('click', () => {
    applyFilters();
    // Close filter panel
    $('filter-body').classList.remove('open');
    $('filter-toggle').classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Refresh button
  $('refresh-btn').addEventListener('click', () => loadData());

  // Modal close
  $('material-modal').addEventListener('click', e => {
    if (e.target === $('material-modal')) closeMaterialModal();
  });
}

// ── Material modal ───────────────────────────────────────────
function openMaterialModal(code, mainUrl, allEncoded) {
  const all = decodeURIComponent(allEncoded);
  const modal = $('material-modal');
  const sheet = modal.querySelector('.modal-sheet');

  const items = all.split('\n').filter(Boolean);
  const itemsHTML = items.map(line => {
    const m = line.match(/^\[(.+?)\]\s*(.+)/);
    if (!m) return `<div class="modal-item">${escHtml(line)}</div>`;
    return `<div class="modal-item">
      <div class="modal-item-date">${escHtml(m[1])}</div>
      ${escHtml(m[2])}
    </div>`;
  }).join('');

  sheet.querySelector('.modal-title').textContent = `${code} の適時開示一覧`;
  sheet.querySelector('#modal-items').innerHTML = itemsHTML;
  sheet.querySelector('#modal-open-btn').onclick = () => {
    if (mainUrl) window.open(mainUrl, '_blank');
    closeMaterialModal();
  };
  sheet.querySelector('#modal-close-btn').onclick = closeMaterialModal;

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMaterialModal() {
  $('material-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// ── UI helpers ───────────────────────────────────────────────
function showLoading(v) {
  $('loading-overlay').style.display = v ? 'flex' : 'none';
}

function setRefreshAnim(v) {
  $('refresh-btn').classList.toggle('spinning', v);
}

let toastTimer;
function showToast(msg) {
  const el = $q('.toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
