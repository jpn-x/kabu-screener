'use strict';

const DATA_URL = 'https://jpn-x.github.io/kabu-screener/data/results.json';

// 市場名を2文字略称に変換
function mktAbbr(market) {
  const m = market || '';
  if (m.includes('プライム') || m.includes('東P') || m.includes('Ｐ')) return 'プラ';
  if (m.includes('スタンダード') || m.includes('東S') || m.includes('Ｓ')) return 'スタ';
  if (m.includes('グロース') || m.includes('東G') || m.includes('Ｇ')) return 'グロ';
  return m.slice(0, 3);
}

const VOL_PERIODS = { '当日': 'intraday_vol', '3日': 'vol_3d', '5日': 'vol_5d', '20日': 'vol_20d' };
const PAGES = ['売買代金','出来高','値上がり率','値下がり率','ストップ高','ストップ安'];
const MARKETS = ['全市場','プライム','スタンダード','グロース'];
const SITES = {
  '株探':           c => `https://kabutan.jp/stock/news?code=${c}`,
  'Yahoo!':         c => `https://finance.yahoo.co.jp/quote/${c}.T`,
  'SBI証券':        c => `https://kabutan.jp/stock/news?code=${c}`,
  '楽天証券':       c => `https://finance.yahoo.co.jp/quote/${c}.T`,
  '四季報':         c => `https://shikiho.toyokeizai.net/stocks/${c}`,
};

const state = {
  all: [], filtered: [], ptsList: [], ptsMode: false,
  sortCol: 'vol', sortAsc: false,
  volPeriod: '当日',
  brokerage: '株探',
  urlMap: {}, irMap: {},
  filters: {
    pages: [...PAGES],
    market: '全市場',
    minVol: 5.0, minTv: 2.5, minChange: 5.0,
  },
};

const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildUI();
  loadData();
});

// ── Data ─────────────────────────────────────────────────────
async function loadData(showLoader = true) {
  if (showLoader) showLoading(true);
  setRefresh(true);
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    state.all     = json.stocks || [];
    state.ptsList = json.pts    || [];
    $('time-txt').textContent = `取得: ${json.updated_at_display || '--'}`;
    applyMaterials();   // URLマップ・IRマップをデータ読み込み後に構築
    if (state.ptsMode) renderPts(state.ptsMode);
    else applyAndRender();
  } catch(e) {
    setStatus(`データ取得失敗: ${e.message}`);
  } finally {
    showLoading(false);
    setRefresh(false);
  }
}

// ── Filter + Render ───────────────────────────────────────────
function applyAndRender() {
  const f = state.filters;
  const vf = VOL_PERIODS[state.volPeriod] || 'intraday_vol';

  state.filtered = state.all.filter(s => {
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
    if (f.minVol > 0 && (s[vf] == null || s[vf] < f.minVol)) return false;
    if (f.minTv > 0  && (s.trading_value == null || s.trading_value < f.minTv)) return false;
    if (f.minChange > 0 && (s.change_pct == null || Math.abs(s.change_pct) < f.minChange)) return false;
    return true;
  });

  sortRows();
}

function sortRows() {
  const vf = VOL_PERIODS[state.volPeriod] || 'intraday_vol';
  const keyMap = { vol: vf, chg: 'change_pct', tv: 'trading_value', close: 'close', ytd: 'ytd_perf', ysp: 'year_start_price', mcap: 'market_cap' };
  const key = keyMap[state.sortCol] || vf;
  const asc = state.sortAsc;

  state.filtered.sort((a, b) => {
    let av = a[key] ?? (asc ? Infinity : -Infinity);
    let bv = b[key] ?? (asc ? Infinity : -Infinity);
    if (key === 'change_pct') { av = Math.abs(av); bv = Math.abs(bv); }
    return asc ? av - bv : bv - av;
  });

  renderTable();
}

function renderTable() {
  const tbody = $('tbody');
  const vf = VOL_PERIODS[state.volPeriod] || 'intraday_vol';
  const count = state.filtered.length;
  $('count-badge').textContent = `${count}件ヒット`;

  if (!count) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:40px;color:var(--text2);">条件に合う銘柄がありません</td></tr>`;
    return;
  }

  const rows = state.filtered.map((s, i) => {
    const up = (s.change_pct ?? 0) >= 0;
    const chgStr = s.change_pct != null ? `${s.change_pct >= 0?'+':''}${s.change_pct.toFixed(2)}%` : '-';
    const volVal  = s[vf];
    const volStr  = volVal != null ? `${volVal.toFixed(1)}%` : '-';
    const tvStr   = s.trading_value != null ? `${s.trading_value.toFixed(1)}` : '-';
    const closeStr = s.close != null ? s.close.toLocaleString() : '-';

    // material
    const mt = s.material_text || '';
    const isIR = mt.startsWith('[IR');
    const isMinka = mt.startsWith('[みんかぶ]');
    const badgeCls = isIR ? 'badge-ir' : isMinka ? 'badge-minkabu' : 'badge-kabutan';
    const badgeTxt = isIR ? 'IR' : isMinka ? 'みんかぶ' : '株探';
    const cleanMt = mt.replace(/^\[.*?\]\s*/, '').substring(0, 55);
    const matHTML = mt ? `<span class="badge ${badgeCls}">${badgeTxt}</span>${escHtml(cleanMt)}` : '';

    const rowCls = `${up ? 'row-up' : 'row-down'}${i%2===1?' row-alt':''}`;

    const ytd  = s.ytd_perf;
    const ytdStr = ytd  != null ? `${ytd  >= 0 ? '+' : ''}${ytd.toFixed(1)}%`  : '-';
    const ytdCls = ytd  != null ? (ytd  >= 0 ? 'c-up' : 'c-down') : 'c-dim';
    const ysp  = s.year_start_price;
    const yspStr = ysp  != null ? `¥${ysp.toLocaleString()}` : '-';
    const mcap = s.market_cap;
    const mcapStr = mcap != null ? `${mcap.toLocaleString()}億` : '-';

    return `<tr class="${rowCls}" data-code="${s.code}">
      <td class="col-code c-dim">${s.code}</td>
      <td class="col-name" style="text-align:left;padding-left:8px;">${escHtml(s.name)}</td>
      <td class="col-market c-dim">${mktAbbr(s.market)}</td>
      <td class="col-mcap c-dim">${mcapStr}</td>
      <td class="col-ytd ${ytdCls}">${ytdStr}</td>
      <td class="col-ysp c-dim">${yspStr}</td>
      <td class="col-close">¥${closeStr}</td>
      <td class="col-chg ${up?'c-up':'c-down'}">${chgStr}</td>
      <td class="col-vol c-acc">${volStr}</td>
      <td class="col-tv">${tvStr}億</td>
      <td class="col-mat mat-cell" data-code="${s.code}">${matHTML}</td>
      <td class="col-src c-dim">${escHtml(s.source)}</td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows;

  // 銘柄名セルをシングルクリックで開く
  tbody.querySelectorAll('td.col-name').forEach(td => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', e => {
      e.stopPropagation();
      const code = td.closest('tr')?.dataset.code;
      if (!code) return;
      const url = (SITES[state.brokerage] || SITES['株探'])(code);
      window.open(url, '_blank');
    });
  });

  // Material cell click
  tbody.querySelectorAll('.mat-cell').forEach(td => {
    td.addEventListener('click', e => {
      e.stopPropagation();
      const code = td.dataset.code;
      const url = state.urlMap[code];
      if (url) window.open(url, '_blank');
    });
    td.addEventListener('mouseenter', e => showTooltip(e, td.dataset.code));
    td.addEventListener('mouseleave', hideTooltip);
    td.addEventListener('mousemove', e => moveTooltip(e));
  });
}

// ── Column sort ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) state.sortAsc = !state.sortAsc;
      else { state.sortCol = col; state.sortAsc = false; }
      updateSortArrows();
      sortRows();
    });
  });
});

function updateSortArrows() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.col === state.sortCol) {
      arrow.textContent = state.sortAsc ? '▲' : '▼';
    } else {
      arrow.textContent = '';
    }
  });
}

// ── Tooltip ───────────────────────────────────────────────────
function showTooltip(e, code) {
  const ir = state.irMap[code];
  if (!ir) return;
  const tip = $('tooltip');
  tip.textContent = ir;
  tip.className = ir.includes('[IR') ? 'ir-tip' : '';
  tip.style.display = 'block';
  moveTooltip(e);
}
function moveTooltip(e) {
  const tip = $('tooltip');
  if (tip.style.display === 'none') return;
  const x = Math.min(e.clientX + 12, window.innerWidth - 440);
  const y = Math.min(e.clientY + 12, window.innerHeight - 120);
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}
function hideTooltip() {
  $('tooltip').style.display = 'none';
}

// ── Material fetch ────────────────────────────────────────────
// Materials are already in the JSON from GitHub Actions
function applyMaterials() {
  state.urlMap = {};
  state.irMap  = {};
  state.all.forEach(s => {
    if (s.material_url)  state.urlMap[s.code] = s.material_url;
    if (s.material_all)  state.irMap[s.code]  = s.material_all;
  });
}

// ── UI Builder ────────────────────────────────────────────────
function buildUI() {
  buildBtnGroup('page-btns', PAGES, 'c2', state.filters.pages, true, val => {
    const f = state.filters.pages;
    const i = f.indexOf(val);
    if (i >= 0) { if (f.length > 1) f.splice(i, 1); }
    else f.push(val);
  });

  buildBtnGroup('market-btns', MARKETS, 'c4', [state.filters.market], false, val => {
    state.filters.market = val;
  });

  buildBtnGroup('vol-period-btns', Object.keys(VOL_PERIODS), 'c4', [state.volPeriod], false, val => {
    state.volPeriod = val;
    // ボラ列ヘッダー更新
    const th = document.querySelector('th[data-col="vol"]');
    if (th) th.childNodes[0].textContent = `ボラ(${val}) `;
    applyAndRender();
  });

  buildBtnGroup('brokerage-btns', Object.keys(SITES), 'c2', [state.brokerage], false, val => {
    state.brokerage = val;
  });

  setupSlider('slider-vol',    'val-vol',    state.filters.minVol,    '%',  v => { state.filters.minVol    = v; });
  setupSlider('slider-tv',     'val-tv',     state.filters.minTv,     '億', v => { state.filters.minTv     = v; });
  setupSlider('slider-change', 'val-change', state.filters.minChange, '%',  v => { state.filters.minChange = v; });

  $('run-btn').addEventListener('click', applyAndRender);
  $('refresh-btn').addEventListener('click', () => loadData());
}

function buildBtnGroup(containerId, options, gridCls, selected, multi, onToggle) {
  const container = $(containerId);
  container.className = `btn-group ${gridCls}`;
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'tog' + (selected.includes(opt) ? ' on' : '');
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      onToggle(opt);
      if (multi) {
        btn.classList.toggle('on', state.filters.pages.includes(opt));
      } else {
        container.querySelectorAll('.tog').forEach(b => b.classList.toggle('on', b.textContent === opt));
      }
    });
    container.appendChild(btn);
  });
}

function setupSlider(sliderId, valId, initial, unit, onChange) {
  const slider = $(sliderId);
  const label  = $(valId);
  if (!slider) return;
  slider.value = initial;
  label.textContent = `${initial.toFixed(1)}${unit}`;
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    label.textContent = `${v.toFixed(1)}${unit}`;
    onChange(v);
  });
}

// ── Helpers ───────────────────────────────────────────────────
function showLoading(v) { $('loading-overlay').style.display = v ? 'flex' : 'none'; }
function setRefresh(v)  { $('refresh-btn').classList.toggle('spinning', v); }
function setStatus(msg) { $('status-txt').textContent = msg; }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── PTS ──────────────────────────────────────────────────────
function renderPts(kind) {
  state.ptsMode = kind;
  const tbody = $('tbody');
  const data  = (state.ptsList || []).filter(s => s.source === kind);
  $('count-badge').textContent = `${data.length}件ヒット`;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:40px;color:var(--text2);">PTSデータなし（市場時間外か未更新）</td></tr>`;
    return;
  }
  data.sort((a,b) => Math.abs(b.pts_change_pct||0) - Math.abs(a.pts_change_pct||0));

  tbody.innerHTML = data.map((s,i) => {
    const up  = (s.pts_change_pct||0) >= 0;
    const chg = s.pts_change_pct != null ? `${s.pts_change_pct>=0?'+':''}${s.pts_change_pct.toFixed(2)}%` : '-';
    const row = `${up?'row-up':'row-down'}${i%2?' row-alt':''}`;
    const mt  = s.material_text || '';
    const isIR = mt.startsWith('[IR');
    const badge = isIR ? `<span class="badge badge-ir">IR</span>` : `<span class="badge badge-minkabu">株</span>`;
    const clean = mt.replace(/^\[.*?\]\s*/,'').substring(0,55);
    return `<tr class="${row}" data-code="${s.code}" data-url="${s.material_url||''}">
      <td class="col-code c-dim">${s.code}</td>
      <td class="col-name" style="text-align:left;padding-left:8px;">${escHtml(s.name)}</td>
      <td class="col-market c-dim">${mktAbbr(s.market||'')}</td>
      <td class="col-close">¥${s.close?.toLocaleString()||'-'}</td>
      <td class="col-chg ${up?'c-up':'c-down'}">${chg}</td>
      <td class="col-vol" style="color:#ffd700;font-weight:700;">¥${s.pts_price?.toLocaleString()||'-'}</td>
      <td class="col-tv">-</td>
      <td class="col-mat mat-cell" data-code="${s.code}" data-url="${s.material_url||''}" data-all="${encodeURIComponent(s.material_all||'')}">${mt?badge+escHtml(clean):''}</td>
      <td class="col-src c-dim">${escHtml(s.source)}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('td.col-name').forEach(td => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', e => {
      e.stopPropagation();
      const code = td.closest('tr')?.dataset.code;
      if (code) window.open(`https://kabutan.jp/stock/news?code=${code}`, '_blank');
    });
  });
  tbody.querySelectorAll('.mat-cell').forEach(td => {
    td.addEventListener('click', e => { e.stopPropagation(); const u=td.dataset.url; if(u) window.open(u,'_blank'); });
    td.addEventListener('mouseenter', e => showTooltip(e, td.dataset.code));
    td.addEventListener('mouseleave', hideTooltip);
    td.addEventListener('mousemove', e => moveTooltip(e));
  });
}

function exitPtsMode() {
  state.ptsMode = false;
  document.querySelectorAll('.pts-btn').forEach(b => b.classList.remove('pts-active'));
  applyAndRender();
}

// materials already embedded in JSON
window.addEventListener('load', () => {
  applyMaterials();
  updateSortArrows();
});
