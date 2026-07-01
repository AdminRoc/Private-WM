/* ═══════════════════════════════════════════════════════════
   main.js —— CSC·Alliance：Boss Tool
   ═══════════════════════════════════════════════════════════ */

const API = '/api/wm';
const WM_THUMB = 'https://wm.wfspeed.run/api/wm/thumb?path=';

/* ──────────────────────────────────────────────────────────
   状态
─────────────────────────────────────────────────────────── */
let _session   = null;
let _orders    = [];
let _items     = [];
let _lang      = 'zh';
let _typeF     = 'all';
let _visF      = 'all';
let _sort      = 'updated_desc';
let _priceMin  = 0;
let _priceMax  = Infinity;
let _searchQ   = '';
let _mult      = 2;
let _avgCache  = {};
let _openRow   = null;
let _openEdit  = null;
let _alertClosed = false;

/* ──────────────────────────────────────────────────────────
   工具
─────────────────────────────────────────────────────────── */
function ago(ts) {
  if (!ts) return '';
  const d = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (d < 60)    return d + '秒前';
  if (d < 3600)  return Math.floor(d/60) + '分钟前';
  if (d < 86400) return Math.floor(d/3600) + '小时前';
  return Math.floor(d/86400) + '天前';
}

function itemName(o) {
  if (_lang === 'zh' && o._zh) return o._zh;
  return o.item?.en_name || o.item?.name || o._name || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(path, opts) {
  opts = opts || {};
  const r = await fetch(API + path, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
  }));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* ──────────────────────────────────────────────────────────
   星空背景
─────────────────────────────────────────────────────────── */
(function initStars() {
  const canvas = document.getElementById('star-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, stars = [];
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function gen() {
    stars = Array.from({ length: 120 }, function() {
      return { x: Math.random()*W, y: Math.random()*H, r: Math.random()*1.2+.2, a: Math.random(), da: (Math.random()*.003+.001)*(Math.random()<.5?1:-1) };
    });
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    stars.forEach(function(s) {
      s.a += s.da;
      if (s.a > 1 || s.a < 0) s.da *= -1;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(180,210,255,' + (s.a*.55) + ')'; ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', function() { resize(); gen(); });
  resize(); gen(); draw();
})();

/* ──────────────────────────────────────────────────────────
   Auth
─────────────────────────────────────────────────────────── */
async function checkSession() {
  try { const j = await apiFetch('/session'); if (j.ok && j.session?.slug) return j.session; } catch {}
  return null;
}

function showLogin() {
  document.body.innerHTML = `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07080f;font-family:'xszt','PingFang SC','Microsoft YaHei',sans-serif">
<div style="width:340px;padding:2rem 2.2rem;background:rgba(10,16,34,.92);border:1px solid rgba(185,142,52,.38);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.65)">
  <div style="font-size:1.3rem;font-weight:800;color:#d4a84a;letter-spacing:.08em;margin-bottom:.3rem">CSC·Alliance</div>
  <div style="font-size:.8rem;color:#6888a8;margin-bottom:1.6rem;letter-spacing:.12em">BOSS TOOL — 登录</div>
  <input id="li-email" type="text" autocomplete="username" placeholder="用户名 / Email" style="width:100%;padding:.6rem .85rem;background:rgba(0,0,0,.5);border:1px solid rgba(185,142,52,.3);border-radius:8px;color:#eef6ff;font-size:.95rem;outline:none;margin-bottom:.75rem;font-family:inherit;box-sizing:border-box">
  <input id="li-pw" type="password" autocomplete="current-password" placeholder="密码" style="width:100%;padding:.6rem .85rem;background:rgba(0,0,0,.5);border:1px solid rgba(185,142,52,.3);border-radius:8px;color:#eef6ff;font-size:.95rem;outline:none;margin-bottom:1rem;font-family:inherit;box-sizing:border-box">
  <button id="li-btn" style="width:100%;padding:.65rem;background:rgba(192,148,58,.2);border:1px solid rgba(212,168,74,.6);border-radius:8px;color:#d4a84a;font-size:.95rem;font-weight:700;cursor:pointer;font-family:inherit">登录</button>
  <div id="li-msg" style="margin-top:.75rem;font-size:.8rem;text-align:center;min-height:1.1em;color:#e8924a"></div>
</div></div>`;
  const btn = document.getElementById('li-btn');
  const msg = document.getElementById('li-msg');
  async function doLogin() {
    const email = document.getElementById('li-email').value.trim();
    const pw    = document.getElementById('li-pw').value;
    if (!email || !pw) { msg.textContent = '请填写用户名和密码'; return; }
    btn.disabled = true; msg.textContent = '登录中…';
    try {
      const j = await apiFetch('/signin', { method: 'POST', body: JSON.stringify({ email, password: pw }) });
      if (j.ok) { location.reload(); }
      else { msg.textContent = j.error || '登录失败，请重试'; btn.disabled = false; }
    } catch(e) { msg.textContent = e.message || '网络错误'; btn.disabled = false; }
  }
  btn.addEventListener('click', doLogin);
  document.addEventListener('keydown', function kd(e) { if (e.key === 'Enter') doLogin(); });
}

/* ──────────────────────────────────────────────────────────
   加载物品总表
─────────────────────────────────────────────────────────── */
async function loadItems() {
  try { const j = await apiFetch('/items'); _items = Array.isArray(j.data) ? j.data : []; }
  catch { _items = []; }
}

/* ──────────────────────────────────────────────────────────
   加载订单
─────────────────────────────────────────────────────────── */
async function loadOrders() {
  const j = await apiFetch('/orders');
  const raw = Array.isArray(j.data) ? j.data : [];
  _orders = raw.map(function(o) {
    const slug = o.item?.url_name || o.item?.id || '';
    const itemObj = _items.find(function(i) { return i.url_name === slug || i.id === slug; });
    return Object.assign({}, o, {
      _slug:  slug,
      _name:  o.item?.en_name || o.item?.name || slug,
      _zh:    itemObj?.zh || itemObj?.i18n?.['zh-hans'] || '',
      _thumb: itemObj?.thumb || o.item?.thumb || '',
      _tags:  itemObj?.tags || [],
    });
  });
}

/* ──────────────────────────────────────────────────────────
   均价获取（队列限速 400ms）
─────────────────────────────────────────────────────────── */
const _avgQueue = [];
let _avgRunning = false;

async function _drainAvgQueue() {
  if (_avgRunning) return;
  _avgRunning = true;
  while (_avgQueue.length > 0) {
    const task = _avgQueue.shift();
    if (_avgCache[task.slug]) { task.resolve(_avgCache[task.slug]); continue; }
    try {
      const j = await apiFetch('/price/' + encodeURIComponent(task.slug));
      if (j.data) { _avgCache[task.slug] = j.data; task.resolve(j.data); }
      else task.resolve(null);
    } catch { task.resolve(null); }
    await sleep(410);
  }
  _avgRunning = false;
}

function fetchAvg(slug) {
  if (_avgCache[slug]) return Promise.resolve(_avgCache[slug]);
  return new Promise(function(resolve) {
    _avgQueue.push({ slug, resolve });
    _drainAvgQueue();
  });
}

/* ──────────────────────────────────────────────────────────
   个人资料卡
─────────────────────────────────────────────────────────── */
function renderProfile(sess) {
  const card = document.getElementById('bw-profile-card');
  if (!card) return;
  const slug      = sess.slug || sess.ingame_name || '—';
  const status    = sess.status || 'offline';
  const dotCls    = status === 'ingame' ? 'ingame' : status === 'online' ? 'online' : 'offline';
  const statusTxt = { ingame: '游戏中', online: '在线', offline: '离线' }[status] || status;
  const avatarSrc = 'https://wm.wfspeed.run/api/wm/avatar?slug=' + encodeURIComponent(slug);
  card.innerHTML = `
<img class="bw-avatar" id="bw-avatar-img" src="${avatarSrc}" alt="avatar"
     onerror="this.src=this.src.includes('csc-logo.png')?'picture/avatar-csc-2026.svg':'picture/csc-logo.png'">
<div class="bw-profile-info">
  <div class="bw-ign">${slug}</div>
  <div class="bw-meta">
    <span><span class="bw-status-dot ${dotCls}"></span>${statusTxt}</span>
    <span>订单：<span id="bw-total-count">…</span></span>
  </div>
</div>`;
}

/* ──────────────────────────────────────────────────────────
   筛选 & 排序
─────────────────────────────────────────────────────────── */
function filtered() {
  let list = _orders.filter(function(o) {
    const type  = o.order_type || o.orderType || '';
    const vis   = o.visible !== false;
    const price = o.platinum || 0;
    const name  = itemName(o).toLowerCase();
    const nameEn= (o._name || '').toLowerCase();
    const q     = _searchQ.toLowerCase();
    if (_typeF !== 'all' && type !== _typeF) return false;
    if (_visF === 'visible' && !vis) return false;
    if (_visF === 'hidden'  &&  vis) return false;
    if (_priceMin > 0 && price < _priceMin) return false;
    if (_priceMax < Infinity && price > _priceMax) return false;
    if (q && name.indexOf(q) === -1 && nameEn.indexOf(q) === -1) return false;
    return true;
  });
  return sortOrders(list);
}

function sortOrders(list) {
  return list.slice().sort(function(a, b) {
    switch (_sort) {
      case 'updated_asc':  return new Date(a.last_update||0) - new Date(b.last_update||0);
      case 'name_asc':     return itemName(a).localeCompare(itemName(b), 'zh-Hans');
      case 'name_desc':    return itemName(b).localeCompare(itemName(a), 'zh-Hans');
      case 'price_asc':    return (a.platinum||0) - (b.platinum||0);
      case 'price_desc':   return (b.platinum||0) - (a.platinum||0);
      case 'created_desc': return new Date(b.creation_date||0) - new Date(a.creation_date||0);
      case 'created_asc':  return new Date(a.creation_date||0) - new Date(b.creation_date||0);
      case 'qty_desc':     return (b.quantity||0) - (a.quantity||0);
      case 'qty_asc':      return (a.quantity||0) - (b.quantity||0);
      default:             return new Date(b.last_update||0) - new Date(a.last_update||0);
    }
  });
}

/* ──────────────────────────────────────────────────────────
   均价 badge HTML
─────────────────────────────────────────────────────────── */
function avgBadgeHtml(slug) {
  const c = _avgCache[slug];
  if (!c) return '<span class="bw-avg-badge loading" data-slug="' + slug + '">均价…</span>';
  const tgt = Math.round(c.avg * _mult);
  return '<span class="bw-avg-badge ok" data-slug="' + slug + '">均 ' + c.avg + 'p × ' + _mult + ' = ' + tgt + 'p</span>';
}

/* ──────────────────────────────────────────────────────────
   订单行 DOM
─────────────────────────────────────────────────────────── */
function mkRow(o) {
  const isHidden = o.visible === false;
  const type     = o.order_type || o.orderType || 'sell';
  const thumb    = o._thumb ? WM_THUMB + encodeURIComponent(o._thumb) : '';
  const pts      = o.mod_rank !== undefined ? ' 阶 ' + o.mod_rank : '';
  const perTrade = (o.quantity_in_set && o.quantity_in_set > 1) ? '×' + o.quantity_in_set + '/批' : '';
  const c        = _avgCache[o._slug];
  const isAlert  = c && o.platinum < c.avg * 1.5;

  const div = document.createElement('div');
  div.className = 'bw-order-row' + (isHidden ? ' bw-order-hidden' : '') + (isAlert ? ' bw-alert-row' : '');
  div.dataset.id   = o.id;
  div.dataset.slug = o._slug;

  div.innerHTML = `
<div class="bw-order-main-row">
  ${thumb ? `<img class="bw-order-thumb bw-thumb-loading" src="${thumb}" alt="" loading="lazy"
    onerror="this.style.display='none'" onload="this.classList.remove('bw-thumb-loading')">` : ''}
  <div class="bw-order-content">
    <span class="bw-order-item">${itemName(o)}${pts ? '<span class="bw-order-extra">' + pts + '</span>' : ''}</span>
    <div class="bw-order-submeta">
      ${perTrade ? '<span class="bw-per-trade">' + perTrade + '</span>' : ''}
      ${avgBadgeHtml(o._slug)}
      <span class="bw-order-ago">${ago(o.last_update)}</span>
    </div>
  </div>
  <div class="bw-order-right">
    ${isHidden ? '<span class="bw-hidden-badge">下架</span>' : ''}
    <span class="bw-order-price">${o.platinum}p</span>
    <div class="bw-order-actions">
      <button class="bw-act-btn bw-act-vis${isHidden ? ' is-hidden' : ''}" data-id="${o.id}">${isHidden ? '上架' : '下架'}</button>
      <button class="bw-act-btn bw-act-edit" data-id="${o.id}">编辑</button>
      <button class="bw-act-btn bw-act-del" data-id="${o.id}">删</button>
    </div>
  </div>
</div>
<div class="bw-order-detail" id="bw-detail-${o.id}">
  <div class="bw-detail-inner" id="bw-detail-inner-${o.id}">
    <div class="bw-detail-loading">加载中…</div>
  </div>
</div>`;

  div.querySelector('.bw-order-main-row').addEventListener('click', function(e) {
    if (e.target.closest('.bw-order-actions')) return;
    toggleDetail(o.id);
  });
  div.querySelector('.bw-act-vis').addEventListener('click', function(e) { e.stopPropagation(); toggleVisibility(o); });
  div.querySelector('.bw-act-edit').addEventListener('click', function(e) { e.stopPropagation(); openEdit(o, false); });
  div.querySelector('.bw-act-del').addEventListener('click', function(e) { e.stopPropagation(); openEdit(o, true); });
  return div;
}

/* ──────────────────────────────────────────────────────────
   渲染列表
─────────────────────────────────────────────────────────── */
function render() {
  const list     = filtered();
  const sellList = list.filter(function(o) { return (o.order_type || o.orderType) === 'sell'; });
  const buyList  = list.filter(function(o) { return (o.order_type || o.orderType) !== 'sell'; });

  const sellEl = document.getElementById('bw-sell-list');
  const buyEl  = document.getElementById('bw-buy-list');
  sellEl.innerHTML = '';
  buyEl.innerHTML  = '';

  if (sellList.length === 0) sellEl.innerHTML = '<div class="bw-empty">暂无出售订单</div>';
  sellList.forEach(function(o, i) { const row = mkRow(o); row.style.animationDelay = (i*28)+'ms'; sellEl.appendChild(row); });

  if (buyList.length === 0) buyEl.innerHTML = '<div class="bw-empty">暂无求购订单</div>';
  buyList.forEach(function(o, i) { const row = mkRow(o); row.style.animationDelay = (i*28)+'ms'; buyEl.appendChild(row); });

  document.getElementById('bw-sell-count').textContent = '(' + sellList.length + ')';
  document.getElementById('bw-buy-count').textContent  = '(' + buyList.length + ')';
  document.getElementById('bw-order-stats').textContent = '共 ' + _orders.length + ' 条 · 显示 ' + list.length + ' 条';
  const tot = document.getElementById('bw-total-count');
  if (tot) tot.textContent = _orders.length;

  const hasFilter = _typeF !== 'all' || _visF !== 'all' || _priceMin > 0 || _priceMax < Infinity || _searchQ;
  document.getElementById('bw-batch-panel').style.display = hasFilter ? 'flex' : 'none';
  document.getElementById('bw-batch-count').textContent = list.length;

  updateAlertSection(list);
  loadMissingAvg(list);
}

/* ──────────────────────────────────────────────────────────
   均价异步加载
─────────────────────────────────────────────────────────── */
function loadMissingAvg(list) {
  const seen = {};
  const slugs = [];
  list.forEach(function(o) {
    if (o._slug && !_avgCache[o._slug] && !seen[o._slug]) { seen[o._slug]=1; slugs.push(o._slug); }
  });
  slugs.forEach(function(slug) {
    fetchAvg(slug).then(function(data) {
      if (!data) return;
      document.querySelectorAll('.bw-avg-badge[data-slug="' + slug + '"]').forEach(function(el) {
        const tgt = Math.round(data.avg * _mult);
        el.textContent = '均 ' + data.avg + 'p × ' + _mult + ' = ' + tgt + 'p';
        el.classList.remove('loading'); el.classList.add('ok');
      });
      document.querySelectorAll('.bw-order-row[data-slug="' + slug + '"]').forEach(function(row) {
        const o = _orders.find(function(x) { return x.id === row.dataset.id; });
        if (o && o.platinum < data.avg * 1.5) row.classList.add('bw-alert-row');
      });
      updateAlertBadges();
    });
  });
}

/* ──────────────────────────────────────────────────────────
   价格警报
─────────────────────────────────────────────────────────── */
function updateAlertSection(visibleList) {
  if (_alertClosed) return;
  const alertOrders = visibleList.filter(function(o) {
    const c = _avgCache[o._slug]; return c && o.platinum < c.avg * 1.5;
  });
  const sec = document.getElementById('bw-alert-section');
  const fab = document.getElementById('bw-alert-fab');
  const n   = document.getElementById('bw-alert-fab-n');
  const cnt = document.getElementById('bw-alert-count');
  if (alertOrders.length > 0) {
    cnt.textContent = '（' + alertOrders.length + ' 条订单价格偏低）';
    sec.style.display = ''; fab.style.display = ''; n.textContent = alertOrders.length;
    const al = document.getElementById('bw-alert-list'); al.innerHTML = '';
    alertOrders.forEach(function(o) { al.appendChild(mkRow(o)); });
  } else { sec.style.display = 'none'; fab.style.display = 'none'; }
}

function updateAlertBadges() { updateAlertSection(filtered()); }

/* ──────────────────────────────────────────────────────────
   订单详情展开面板
─────────────────────────────────────────────────────────── */
async function toggleDetail(id) {
  const el = document.getElementById('bw-detail-' + id);
  if (!el) return;
  const isOpen = el.classList.contains('is-open');
  if (_openRow && _openRow !== id) {
    const prev = document.getElementById('bw-detail-' + _openRow);
    if (prev) prev.classList.remove('is-open');
  }
  if (isOpen) { el.classList.remove('is-open'); _openRow = null; return; }
  el.classList.add('is-open');
  _openRow = id;

  const o = _orders.find(function(x) { return x.id === id; });
  if (!o) return;
  const inner = document.getElementById('bw-detail-inner-' + id);
  const avgData = _avgCache[o._slug];
  const avgRow  = avgData
    ? '<div class="bw-detail-row"><div class="bw-detail-label">参考均价</div><div class="bw-detail-val">' + avgData.avg + 'p（' + avgData.count + '条，去极值后' + avgData.used + '条）</div></div>'
    : '<div class="bw-detail-row"><div class="bw-detail-label">参考均价</div><div class="bw-detail-val">加载中…</div></div>';

  inner.innerHTML = avgRow + `
<div class="bw-detail-row"><div class="bw-detail-label">类型</div><div class="bw-detail-val">${(o.order_type||o.orderType)==='sell'?'出售':'求购'}</div></div>
<div class="bw-detail-row"><div class="bw-detail-label">价格</div><div class="bw-detail-val">${o.platinum}p</div></div>
<div class="bw-detail-row"><div class="bw-detail-label">数量</div><div class="bw-detail-val">${o.quantity||1}</div></div>
<div class="bw-detail-row"><div class="bw-detail-label">可见性</div><div class="bw-detail-val">${o.visible===false?'已下架':'上架中'}</div></div>
${o.mod_rank!==undefined?'<div class="bw-detail-row"><div class="bw-detail-label">阶数</div><div class="bw-detail-val">'+o.mod_rank+'</div></div>':''}
<div class="bw-detail-row"><div class="bw-detail-label">最后更新</div><div class="bw-detail-val">${ago(o.last_update)}</div></div>`;

  if (o._slug) {
    try {
      const j = await apiFetch('/item/' + encodeURIComponent(o._slug));
      const it = j.data;
      if (it) {
        const desc = (it.description || '').replace(/<[^>]+>/g, '').slice(0, 200);
        [
          it.rarity ? '<div class="bw-detail-row"><div class="bw-detail-label">稀有度</div><div class="bw-detail-val">'+it.rarity+'</div></div>' : '',
          it.trading_tax !== undefined ? '<div class="bw-detail-row"><div class="bw-detail-label">交易税</div><div class="bw-detail-val">'+it.trading_tax+'</div></div>' : '',
          it.tags?.length ? '<div class="bw-detail-row"><div class="bw-detail-label">标签</div><div class="bw-detail-val">'+it.tags.join(' · ')+'</div></div>' : '',
          desc ? '<div class="bw-detail-desc">'+desc+'</div>' : '',
        ].forEach(function(h) { if (h) inner.insertAdjacentHTML('beforeend', h); });
      }
    } catch {}
  }
}

/* ──────────────────────────────────────────────────────────
   快速切换可见性
─────────────────────────────────────────────────────────── */
async function toggleVisibility(o) {
  const newVis = o.visible === false;
  try {
    await apiFetch('/order/' + o.id, { method: 'PATCH', body: JSON.stringify({ visible: newVis }) });
    o.visible = newVis; render();
  } catch(e) { console.error('visibility error', e); }
}

/* ──────────────────────────────────────────────────────────
   编辑抽屉
─────────────────────────────────────────────────────────── */
function openEdit(o, showDel) {
  _openEdit = o;
  document.getElementById('bw-drawer-item-name').textContent = itemName(o);
  const badge = document.getElementById('bw-drawer-type-badge');
  const type  = o.order_type || o.orderType || 'sell';
  badge.textContent = type === 'sell' ? '出售订单' : '求购订单';
  badge.className   = 'bw-drawer-type-badge is-' + type;
  document.getElementById('bw-pill-visible').classList.toggle('active', o.visible !== false);
  document.getElementById('bw-pill-hidden').classList.toggle('active', o.visible === false);
  document.getElementById('bw-drawer-price').value = o.platinum || '';
  document.getElementById('bw-drawer-qty').value   = o.quantity  || 1;
  const ptWrap = document.getElementById('bw-drawer-per-trade-wrap');
  if (o.quantity_in_set > 1) { ptWrap.style.display = ''; document.getElementById('bw-drawer-per-trade').value = o.quantity_in_set; }
  else { ptWrap.style.display = 'none'; }
  refreshPriceHint(o._slug, +(document.getElementById('bw-drawer-price').value));
  document.getElementById('bw-drawer-confirm-del').classList.remove('is-open');
  setDrawerMsg('');
  if (showDel) document.getElementById('bw-drawer-confirm-del').classList.add('is-open');
  openDrawer('bw-edit-drawer', 'bw-drawer-overlay');
}

function refreshPriceHint(slug, price) {
  const hint = document.getElementById('bw-drawer-price-hint');
  if (!hint) return;
  const c = _avgCache[slug];
  if (!c || !price) { hint.textContent = ''; return; }
  const target = c.avg * _mult;
  if (price < c.avg * 1.5) {
    hint.className = 'bw-drawer-price-hint alert';
    hint.textContent = '⚠ 价格偏低！均价 ' + c.avg + 'p，目标 ' + Math.round(target) + 'p';
  } else if (price < target) {
    hint.className = 'bw-drawer-price-hint warn';
    hint.textContent = '均价 ' + c.avg + 'p，目标 ' + Math.round(target) + 'p（当前低于倍率目标）';
  } else {
    hint.className = 'bw-drawer-price-hint good';
    hint.textContent = '均价 ' + c.avg + 'p，价格合理 ✓';
  }
}

function closeEdit() { closeDrawer('bw-edit-drawer', 'bw-drawer-overlay'); _openEdit = null; }

function openDrawer(did, oid) {
  document.getElementById(did).classList.add('is-open');
  document.getElementById(oid).classList.add('is-open');
}
function closeDrawer(did, oid) {
  document.getElementById(did).classList.remove('is-open');
  document.getElementById(oid).classList.remove('is-open');
}
function setDrawerMsg(text, cls) {
  const el = document.getElementById('bw-drawer-msg'); if (!el) return;
  el.textContent = text; el.className = 'bw-drawer-msg' + (cls ? ' ' + cls : '');
}

/* ──────────────────────────────────────────────────────────
   创建抽屉
─────────────────────────────────────────────────────────── */
let _createType = 'sell', _createVis = true, _createItemId = '';

function openCreate() {
  _createType = 'sell'; _createVis = true; _createItemId = '';
  ['bw-create-item-q','bw-create-item-id','bw-create-price'].forEach(function(id) { document.getElementById(id).value = ''; });
  document.getElementById('bw-create-qty').value = 1;
  document.getElementById('bw-create-type-sell').classList.add('active');
  document.getElementById('bw-create-type-buy').classList.remove('active');
  document.getElementById('bw-create-vis-on').classList.add('active');
  document.getElementById('bw-create-vis-off').classList.remove('active');
  document.getElementById('bw-item-dropdown').innerHTML = '';
  ['bw-create-rank-wrap','bw-create-per-trade-wrap','bw-create-subtype-wrap'].forEach(function(id) { document.getElementById(id).style.display='none'; });
  const msg = document.getElementById('bw-create-msg'); if (msg) msg.textContent = '';
  openDrawer('bw-create-drawer', 'bw-create-overlay');
  document.getElementById('bw-create-item-q').focus();
}
function closeCreate() { closeDrawer('bw-create-drawer', 'bw-create-overlay'); }

/* 物品搜索联想 */
function setupItemSearch() {
  const q   = document.getElementById('bw-create-item-q');
  const dd  = document.getElementById('bw-item-dropdown');
  const hid = document.getElementById('bw-create-item-id');

  q.addEventListener('input', function() {
    const text = q.value.trim().toLowerCase();
    hid.value = ''; _createItemId = '';
    if (!text) { dd.innerHTML = ''; return; }
    const matches = _items.filter(function(i) {
      const zh = (i.zh || (i.i18n && i.i18n['zh-hans']) || '').toLowerCase();
      const en = (i.en_name || i.name || i.url_name || '').toLowerCase();
      return zh.indexOf(text) !== -1 || en.indexOf(text) !== -1;
    }).slice(0, 30);
    if (matches.length === 0) { dd.innerHTML = '<div class="bw-item-drop-empty">无匹配结果</div>'; return; }
    dd.innerHTML = matches.map(function(i) {
      const zh = i.zh || (i.i18n && i.i18n['zh-hans']) || '';
      const en = i.en_name || i.name || i.url_name || '';
      return '<div class="bw-item-drop-row" data-id="'+(i.url_name||i.id)+'" data-zh="'+zh+'" data-en="'+en+'">'
        +'<span class="bw-item-drop-zh">'+(zh||en)+'</span>'
        +'<span class="bw-item-drop-en">'+(zh?en:'')+'</span></div>';
    }).join('');
    dd.querySelectorAll('.bw-item-drop-row').forEach(function(row) {
      row.addEventListener('click', function() {
        const zh = row.dataset.zh, en = row.dataset.en;
        q.value = (_lang === 'zh' && zh) ? zh : en;
        hid.value = row.dataset.id; _createItemId = row.dataset.id;
        dd.innerHTML = '';
        const item = _items.find(function(i) { return (i.url_name||i.id) === _createItemId; });
        if (item) updateCreateFields(item);
      });
    });
  });
  document.addEventListener('click', function(e) {
    if (!q.closest('.bw-item-search-wrap').contains(e.target)) dd.innerHTML = '';
  });
}

function updateCreateFields(item) {
  const tags = item.tags || [];
  const isMod = tags.includes('mod'), isRiven = tags.includes('riven');
  const isLich = tags.includes('lich'), isSister = tags.includes('sister');
  const rankWrap = document.getElementById('bw-create-rank-wrap');
  const rl = document.getElementById('bw-create-rank-label');
  if (isMod || isRiven) {
    rankWrap.style.display = '';
    rl.textContent = isRiven ? 'Mastery（0–16）' : '阶数（0–' + (item.max_rank||10) + '）';
    document.getElementById('bw-create-rank').max = item.max_rank || (isRiven ? 16 : 10);
  } else { rankWrap.style.display = 'none'; }
  const subtypeWrap = document.getElementById('bw-create-subtype-wrap');
  if (isLich || isSister) {
    subtypeWrap.style.display = '';
    const subtypes = isLich ? ['Kuva Lich','Kuva Lich (Ephemera)'] : ['Sisters of Parvos','Sisters of Parvos (Ephemera)'];
    document.getElementById('bw-create-subtype').innerHTML = subtypes.map(function(t) { return '<option value="'+t+'">'+t+'</option>'; }).join('');
  } else { subtypeWrap.style.display = 'none'; }
  const isSet = (item.url_name||'').endsWith('_set') || tags.includes('set');
  document.getElementById('bw-create-per-trade-wrap').style.display = isSet ? '' : 'none';
}

/* ──────────────────────────────────────────────────────────
   批量操作
─────────────────────────────────────────────────────────── */
async function batchOp(orders, patchFn) {
  const bar  = document.getElementById('bw-batch-bar');
  const prog = document.getElementById('bw-batch-progress');
  const txt  = document.getElementById('bw-batch-prog-text');
  prog.style.display = '';
  let done = 0;
  for (const o of orders) {
    const patch = patchFn(o);
    if (patch) {
      try {
        await apiFetch('/order/' + o.id, { method: 'PATCH', body: JSON.stringify(patch) });
        Object.assign(o, patch);
      } catch {}
    }
    done++;
    bar.style.width = Math.round(done/orders.length*100) + '%';
    txt.textContent = done + ' / ' + orders.length;
    await sleep(410);
  }
  prog.style.display = 'none'; bar.style.width = '0%';
  render();
}

async function visAllOrders(visible) {
  const targets = _orders.filter(function(o) { return (o.visible !== false) !== visible; });
  if (!targets.length) return;
  await batchOp(targets, function() { return { visible }; });
}

/* ──────────────────────────────────────────────────────────
   事件绑定
─────────────────────────────────────────────────────────── */
function bindEvents() {
  /* 退出 */
  document.getElementById('bw-logout-btn')?.addEventListener('click', async function() {
    await apiFetch('/signout', { method: 'POST' }).catch(function(){});
    location.reload();
  });

  /* 语言切换 */
  const langBtn = document.getElementById('bw-lang-btn');
  langBtn?.addEventListener('click', function() {
    _lang = _lang === 'zh' ? 'en' : 'zh';
    langBtn.classList.toggle('is-en', _lang === 'en');
    document.getElementById('bw-lang-zh').classList.toggle('active', _lang === 'zh');
    document.getElementById('bw-lang-en').classList.toggle('active', _lang === 'en');
    render();
  });

  /* 类型筛选 */
  document.querySelectorAll('.bw-type-pill').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.bw-type-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active'); _typeF = btn.dataset.type; render();
    });
  });

  /* 可见性筛选 */
  document.querySelectorAll('.bw-vis-f-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.bw-vis-f-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active'); _visF = btn.dataset.vis; render();
    });
  });

  /* 价格区间 */
  document.getElementById('bw-price-min')?.addEventListener('input', function(e) { _priceMin = +e.target.value || 0; render(); });
  document.getElementById('bw-price-max')?.addEventListener('input', function(e) { _priceMax = +e.target.value || Infinity; render(); });

  /* 搜索 */
  document.getElementById('bw-search-q')?.addEventListener('input', function(e) { _searchQ = e.target.value.trim(); render(); });

  /* 倍率 */
  document.getElementById('bw-multiplier')?.addEventListener('input', function(e) { _mult = parseFloat(e.target.value) || 2; render(); });

  /* 自定义排序 */
  const sortWrap = document.getElementById('bw-sort-wrap');
  document.getElementById('bw-sort-trigger')?.addEventListener('click', function(e) {
    e.stopPropagation(); sortWrap.classList.toggle('is-open');
  });
  document.querySelectorAll('.bw-sort-item').forEach(function(item) {
    item.addEventListener('click', function() {
      document.querySelectorAll('.bw-sort-item').forEach(function(i) { i.classList.remove('active'); });
      item.classList.add('active'); _sort = item.dataset.sort;
      document.getElementById('bw-sort-label').textContent = item.textContent;
      sortWrap.classList.remove('is-open'); render();
    });
  });
  document.addEventListener('click', function() { sortWrap.classList.remove('is-open'); });

  /* 批量上下架 */
  document.getElementById('bw-vis-show-all')?.addEventListener('click', function() { visAllOrders(true); });
  document.getElementById('bw-vis-hide-all')?.addEventListener('click', function() { visAllOrders(false); });

  /* 创建抽屉 */
  document.getElementById('bw-create-btn')?.addEventListener('click', openCreate);
  document.getElementById('bw-create-close')?.addEventListener('click', closeCreate);
  document.getElementById('bw-create-overlay')?.addEventListener('click', closeCreate);

  document.getElementById('bw-create-type-sell')?.addEventListener('click', function() {
    _createType = 'sell';
    document.getElementById('bw-create-type-sell').classList.add('active');
    document.getElementById('bw-create-type-buy').classList.remove('active');
  });
  document.getElementById('bw-create-type-buy')?.addEventListener('click', function() {
    _createType = 'buy';
    document.getElementById('bw-create-type-buy').classList.add('active');
    document.getElementById('bw-create-type-sell').classList.remove('active');
  });
  document.getElementById('bw-create-vis-on')?.addEventListener('click', function() {
    _createVis = true;
    document.getElementById('bw-create-vis-on').classList.add('active');
    document.getElementById('bw-create-vis-off').classList.remove('active');
  });
  document.getElementById('bw-create-vis-off')?.addEventListener('click', function() {
    _createVis = false;
    document.getElementById('bw-create-vis-off').classList.add('active');
    document.getElementById('bw-create-vis-on').classList.remove('active');
  });

  document.getElementById('bw-create-submit')?.addEventListener('click', async function() {
    const msg = document.getElementById('bw-create-msg');
    if (!_createItemId) { msg.textContent = '请先选择物品'; msg.className = 'bw-drawer-msg err'; return; }
    const price = +document.getElementById('bw-create-price').value;
    const qty   = +document.getElementById('bw-create-qty').value || 1;
    if (!price || price < 1) { msg.textContent = '请输入有效价格'; msg.className = 'bw-drawer-msg err'; return; }
    const body = { item_id: _createItemId, order_type: _createType, platinum: price, quantity: qty, visible: _createVis };
    if (document.getElementById('bw-create-rank-wrap').style.display !== 'none') {
      body.mod_rank = +document.getElementById('bw-create-rank').value || 0;
    }
    msg.textContent = '创建中…'; msg.className = 'bw-drawer-msg';
    try {
      await apiFetch('/order', { method: 'POST', body: JSON.stringify(body) });
      msg.textContent = '创建成功！'; msg.className = 'bw-drawer-msg ok';
      await loadOrders(); render();
      setTimeout(closeCreate, 900);
    } catch(e) { msg.textContent = e.message || '创建失败'; msg.className = 'bw-drawer-msg err'; }
  });

  /* 编辑抽屉 */
  document.getElementById('bw-drawer-close')?.addEventListener('click', closeEdit);
  document.getElementById('bw-drawer-overlay')?.addEventListener('click', closeEdit);

  document.querySelectorAll('.bw-vis-pill[data-val]').forEach(function(p) {
    p.addEventListener('click', function() {
      document.querySelectorAll('.bw-vis-pill[data-val]').forEach(function(x) { x.classList.remove('active'); });
      p.classList.add('active');
    });
  });

  document.getElementById('bw-drawer-price')?.addEventListener('input', function(e) {
    if (_openEdit) refreshPriceHint(_openEdit._slug, +e.target.value);
  });

  document.getElementById('bw-drawer-update')?.addEventListener('click', async function() {
    if (!_openEdit) return;
    const price = +document.getElementById('bw-drawer-price').value;
    const qty   = +document.getElementById('bw-drawer-qty').value || 1;
    const vis   = document.getElementById('bw-pill-visible').classList.contains('active');
    const patch = { platinum: price, quantity: qty, visible: vis };
    if (document.getElementById('bw-drawer-per-trade-wrap').style.display !== 'none') {
      patch.quantity_in_set = +document.getElementById('bw-drawer-per-trade').value || 1;
    }
    setDrawerMsg('更新中…');
    try {
      await apiFetch('/order/' + _openEdit.id, { method: 'PATCH', body: JSON.stringify(patch) });
      Object.assign(_openEdit, patch); setDrawerMsg('更新成功！', 'ok'); render();
      setTimeout(closeEdit, 700);
    } catch(e) { setDrawerMsg(e.message || '更新失败', 'err'); }
  });

  document.getElementById('bw-drawer-delete')?.addEventListener('click', function() {
    document.getElementById('bw-drawer-confirm-del').classList.add('is-open');
  });
  document.getElementById('bw-drawer-confirm-no')?.addEventListener('click', function() {
    document.getElementById('bw-drawer-confirm-del').classList.remove('is-open');
  });
  document.getElementById('bw-drawer-confirm-yes')?.addEventListener('click', async function() {
    if (!_openEdit) return;
    setDrawerMsg('删除中…');
    try {
      await apiFetch('/order/' + _openEdit.id, { method: 'DELETE' });
      _orders = _orders.filter(function(o) { return o.id !== _openEdit.id; });
      setDrawerMsg('已删除', 'ok'); render();
      setTimeout(closeEdit, 600);
    } catch(e) { setDrawerMsg(e.message || '删除失败', 'err'); }
  });

  /* 批量操作 */
  document.getElementById('bw-batch-price-btn')?.addEventListener('click', async function() {
    const val = +document.getElementById('bw-batch-price').value; if (!val||val<1) return;
    await batchOp(filtered(), function() { return { platinum: val }; });
  });
  document.getElementById('bw-batch-qty-btn')?.addEventListener('click', async function() {
    const val = +document.getElementById('bw-batch-qty').value; if (!val||val<1) return;
    await batchOp(filtered(), function() { return { quantity: val }; });
  });
  document.getElementById('bw-batch-mult-btn')?.addEventListener('click', async function() {
    await batchOp(filtered(), function(o) {
      const c = _avgCache[o._slug]; if (!c) return null;
      return { platinum: Math.round(c.avg * _mult) };
    });
  });

  /* 价格警报 FAB */
  document.getElementById('bw-alert-fab')?.addEventListener('click', function() {
    _alertClosed = false;
    document.getElementById('bw-alert-section').scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('bw-alert-close')?.addEventListener('click', function() {
    _alertClosed = true;
    document.getElementById('bw-alert-section').style.display = 'none';
    document.getElementById('bw-alert-fab').style.display = 'none';
  });

  setupItemSearch();
}

/* ──────────────────────────────────────────────────────────
   主流程
─────────────────────────────────────────────────────────── */
async function main() {
  const sess = await checkSession();
  if (!sess) { showLogin(); return; }
  _session = sess;
  renderProfile(sess);
  bindEvents();
  await loadItems();
  try { await loadOrders(); }
  catch(e) {
    document.getElementById('bw-sell-list').innerHTML = '<div class="bw-empty">加载失败：' + e.message + '</div>';
    document.getElementById('bw-buy-list').innerHTML = '';
  }
  render();
}

document.addEventListener('DOMContentLoaded', main);
