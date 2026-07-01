/* ════════════════════════════════════════════════════════════
   main.js —— CSC·Alliance：Boss Tool  Phase 3
   功能：认证门控 / 订单全量展示 / 筛选+排序 / 编辑抽屉 / 创建抽屉
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ══ 常量 & 状态 ══════════════════════════════════════════ */
  var WM_PROXY_BASE = 'https://wm.wfspeed.run';
  var PROFILE_SLUG  = 'csc-2026';
  var STATUS_LABEL  = { online: '在线', ingame: '游戏中', offline: '离线', invisible: '隐身' };

  var _ordersCache = [];
  var _itemsList   = [];   // [{id, slug, zh, en, bulkTradable, maxRank, ...}]
  var _itemsById   = {};   // id -> item
  var _lang        = 'zh'; // 'zh' | 'en'

  var _filterState = {
    type:     'all',
    vis:      'all',
    priceMin: null,
    priceMax: null,
    sort:     'updated_desc',
    search:   '',
  };

  /* ══ 工具函数 ════════════════════════════════════════════ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    var diff = Date.now() - new Date(dateStr).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1)  return '刚刚';
    if (m < 60) return m + '分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + '小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + '天前';
    return Math.floor(d / 30) + '个月前';
  }

  function apiFetch(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
  }

  function fetchProxyOnce(path) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(WM_PROXY_BASE + path, { signal: ctrl.signal })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j && j.error) throw new Error(JSON.stringify(j.error)); return j && j.data; });
  }
  function fetchProxy(path, attempt) {
    attempt = attempt || 0;
    return fetchProxyOnce(path).catch(function (err) {
      if (attempt >= 2) throw err;
      return new Promise(function (r) { setTimeout(r, attempt === 0 ? 500 : 1200); })
        .then(function () { return fetchProxy(path, attempt + 1); });
    });
  }

  /* ══ 渲染：资料卡 ════════════════════════════════════════ */
  function avatarChain(user) {
    var custom = 'picture/avatar-' + encodeURIComponent(PROFILE_SLUG) + '.png';
    var av = user.avatar || (user.profile && user.profile.avatar);
    var wmProxy  = av ? WM_PROXY_BASE + '/static/' + av : null;
    var wmDirect = av ? 'https://warframe.market/static/' + av : null;
    return [custom, wmProxy, wmDirect].filter(Boolean);
  }

  function renderProfile(user) {
    var card = document.getElementById('bw-profile-card');
    if (!user) { card.innerHTML = '<div class="bw-empty">未能获取账号资料。</div>'; return; }
    // WM API v2 可能返回 snake_case 或 camelCase，兼容两种
    var profile     = user.profile || user;
    var ingameName  = profile.ingame_name || profile.ingameName || profile.inGameName || PROFILE_SLUG;
    var statusKey   = profile.status || 'offline';
    var masteryRank = profile.mastery_rank || profile.masteryRank;
    var reputation  = profile.reputation;
    var chain = avatarChain(profile);
    var src = chain.shift() || '';
    var fallbacks = chain.slice();
    var fbAttr = fallbacks.length
      ? ' onerror="(function(el){var f=' + JSON.stringify(fallbacks) + ';var n=el.getAttribute(\'data-fi\')||0;el.setAttribute(\'data-fi\',+n+1);var s=f[+n];if(s){el.onerror=null;el.src=s;}else{el.style.visibility=\'hidden\';}})(this);"'
      : ' onerror="this.style.visibility=\'hidden\';"';
    var status = STATUS_LABEL[statusKey] || statusKey || '';
    card.innerHTML =
      '<img class="bw-avatar" src="' + esc(src) + '" alt=""' + fbAttr + '>' +
      '<div class="bw-profile-info">' +
        '<div class="bw-ign">' + esc(ingameName) + '</div>' +
        '<div class="bw-meta">' +
          '<span><span class="bw-status-dot ' + esc(statusKey) + '"></span>' + esc(status) + '</span>' +
          (masteryRank ? '<span>段位 MR' + esc(masteryRank) + '</span>' : '') +
          (typeof reputation === 'number' ? '<span>声望 ' + esc(reputation) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  /* ══ 筛选 & 排序 ════════════════════════════════════════ */
  function applyFilters() {
    var list = _ordersCache.slice();

    if (_filterState.type !== 'all')
      list = list.filter(function (o) { return o.type === _filterState.type; });

    if (_filterState.vis === 'visible')
      list = list.filter(function (o) { return o.visible !== false; });
    else if (_filterState.vis === 'hidden')
      list = list.filter(function (o) { return o.visible === false; });

    if (_filterState.priceMin !== null)
      list = list.filter(function (o) { return o.platinum >= _filterState.priceMin; });
    if (_filterState.priceMax !== null)
      list = list.filter(function (o) { return o.platinum <= _filterState.priceMax; });

    if (_filterState.search) {
      var sq = _filterState.search.toLowerCase();
      list = list.filter(function (o) {
        var zh = o.item && o.item.zh ? o.item.zh.toLowerCase() : '';
        var en = o.item && o.item.en ? o.item.en.toLowerCase() : '';
        var id = (o.itemId || '').toLowerCase();
        return zh.indexOf(sq) !== -1 || en.indexOf(sq) !== -1 || id.indexOf(sq) !== -1;
      });
    }

    var s = _filterState.sort;
    list.sort(function (a, b) {
      if (s === 'price_asc')    return a.platinum - b.platinum;
      if (s === 'price_desc')   return b.platinum - a.platinum;
      if (s === 'updated_asc')  return new Date(a.updatedAt) - new Date(b.updatedAt);
      if (s === 'created_asc')  return new Date(a.createdAt) - new Date(b.createdAt);
      if (s === 'created_desc') return new Date(b.createdAt) - new Date(a.createdAt);
      if (s === 'qty_asc')      return a.quantity - b.quantity;
      if (s === 'qty_desc')     return b.quantity - a.quantity;
      return new Date(b.updatedAt) - new Date(a.updatedAt); // updated_desc default
    });

    return list;
  }

  /* ══ 渲染：订单行 ════════════════════════════════════════ */
  function orderRow(o) {
    var item = _lang === 'en'
      ? ((o.item && (o.item.en || o.item.zh)) || o.itemId || '—')
      : ((o.item && (o.item.zh || o.item.en)) || o.itemId || '—');
    var hidden = o.visible === false;
    var extras = [];
    if (o.rank != null) extras.push('R' + o.rank);
    if (o.subtype)      extras.push(o.subtype);
    var extraStr = extras.length ? ' (' + extras.join(' · ') + ')' : '';
    var perStr   = o.perTrade ? '<span class="bw-per-trade">×' + o.perTrade + '/批</span>' : '';
    var qtyStr   = '×' + (o.quantity || 0);
    var ago      = timeAgo(o.updatedAt);

    return (
      '<div class="bw-order-row' + (hidden ? ' bw-order-hidden' : '') + '" data-id="' + esc(o.id) + '">' +
        '<div class="bw-order-main">' +
          '<span class="bw-order-item">' + esc(item) + '<span class="bw-order-extra">' + esc(extraStr) + '</span></span>' +
          '<div class="bw-order-submeta">' +
            esc(qtyStr) + perStr +
            (ago ? '<span class="bw-order-ago"> · ' + esc(ago) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="bw-order-right">' +
          '<span class="bw-order-price">' + esc(o.platinum) + 'p</span>' +
          (hidden ? '<span class="bw-hidden-badge">隐藏</span>' : '') +
          '<div class="bw-order-actions">' +
            '<button class="bw-act-btn bw-act-vis' + (hidden ? ' is-hidden' : '') +
              '" data-id="' + esc(o.id) + '" data-visible="' + (!hidden) + '">' +
              esc(hidden ? '显示' : '隐藏') + '</button>' +
            '<button class="bw-act-btn bw-act-edit" data-id="' + esc(o.id) + '">编辑</button>' +
            '<button class="bw-act-btn bw-act-del"  data-id="' + esc(o.id) + '">删除</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ══ 渲染：订单列表 ══════════════════════════════════════ */
  function renderFiltered() {
    var filtered = applyFilters();
    var sell = filtered.filter(function (o) { return o.type === 'sell'; });
    var buy  = filtered.filter(function (o) { return o.type === 'buy'; });

    var statsEl = document.getElementById('bw-order-stats');
    if (statsEl) statsEl.textContent = filtered.length + ' / ' + _ordersCache.length + ' 条';

    document.getElementById('bw-sell-count').textContent =
      sell.length ? '(' + sell.filter(function(o){ return o.visible !== false; }).length + '/' + sell.length + ')' : '';
    document.getElementById('bw-buy-count').textContent =
      buy.length  ? '(' + buy.filter(function(o){ return o.visible !== false; }).length + '/' + buy.length  + ')' : '';

    var sellEl = document.getElementById('bw-sell-list');
    var buyEl  = document.getElementById('bw-buy-list');
    sellEl.innerHTML = sell.length ? sell.map(orderRow).join('') : '<div class="bw-empty">无匹配的出售挂单</div>';
    buyEl.innerHTML  = buy.length  ? buy.map(orderRow).join('')  : '<div class="bw-empty">无匹配的求购挂单</div>';

    [].slice.call(document.querySelectorAll('.bw-order-row')).forEach(function (el, i) {
      el.style.animationDelay = Math.min(i * 0.022, 0.45) + 's';
    });

    bindOrderActions();
  }

  function renderOrders(orders) {
    _ordersCache = orders || [];
    renderFiltered();
  }

  function showOrdersError(msg) {
    var html = '<div class="bw-empty">' + esc(msg || '获取失败。') + '</div>';
    document.getElementById('bw-sell-list').innerHTML = html;
    document.getElementById('bw-buy-list').innerHTML  = html;
  }

  /* ══ 工具栏绑定 ══════════════════════════════════════════ */
  function bindToolbar() {
    [].slice.call(document.querySelectorAll('.bw-type-pill')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        [].slice.call(document.querySelectorAll('.bw-type-pill')).forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        _filterState.type = btn.dataset.type;
        renderFiltered();
      });
    });

    [].slice.call(document.querySelectorAll('.bw-vis-f-btn')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        [].slice.call(document.querySelectorAll('.bw-vis-f-btn')).forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        _filterState.vis = btn.dataset.vis;
        renderFiltered();
      });
    });

    var priceMinEl = document.getElementById('bw-price-min');
    var priceMaxEl = document.getElementById('bw-price-max');
    function onPriceChange() {
      var mn = parseInt(priceMinEl.value, 10);
      var mx = parseInt(priceMaxEl.value, 10);
      _filterState.priceMin = isNaN(mn) ? null : mn;
      _filterState.priceMax = isNaN(mx) ? null : mx;
      renderFiltered();
    }
    if (priceMinEl) priceMinEl.addEventListener('input', onPriceChange);
    if (priceMaxEl) priceMaxEl.addEventListener('input', onPriceChange);

    var sortSel = document.getElementById('bw-sort-sel');
    if (sortSel) sortSel.addEventListener('change', function () {
      _filterState.sort = sortSel.value;
      renderFiltered();
    });

    var searchEl = document.getElementById('bw-search-q');
    var searchTimer = null;
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          _filterState.search = searchEl.value.trim().toLowerCase();
          renderFiltered();
        }, 180);
      });
    }

    var langBtn = document.getElementById('bw-lang-btn');
    if (langBtn) {
      langBtn.addEventListener('click', function () {
        _lang = (_lang === 'zh') ? 'en' : 'zh';
        langBtn.textContent = _lang === 'zh' ? '中' : 'EN';
        langBtn.classList.toggle('is-en', _lang === 'en');
        renderFiltered();
      });
    }

    var createBtn = document.getElementById('bw-create-btn');
    if (createBtn) createBtn.addEventListener('click', openCreateDrawer);
  }

  /* ══ 订单行动作 ══════════════════════════════════════════ */
  function setRowLoading(id, loading) {
    var row = document.querySelector('.bw-order-row[data-id="' + id + '"]');
    if (!row) return;
    row.classList.toggle('bw-row-loading', loading);
    [].slice.call(row.querySelectorAll('.bw-act-btn')).forEach(function (b) { b.disabled = loading; });
  }

  function patchOrder(id, payload) {
    setRowLoading(id, true);
    return apiFetch('/api/wm/orders/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      return r.json();
    }).then(function (j) {
      var updated = j && (j.data || (j.payload && j.payload.order));
      _ordersCache = _ordersCache.map(function (o) {
        if (o.id !== id) return o;
        return Object.assign({}, o, updated || payload);
      });
      renderFiltered();
    }).catch(function (err) {
      setRowLoading(id, false);
      throw err;
    });
  }

  function bindOrderActions() {
    [].slice.call(document.querySelectorAll('.bw-act-vis')).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        patchOrder(btn.dataset.id, { visible: btn.dataset.visible === 'true' })
          .catch(function (err) { alert('操作失败：' + err.message); });
      });
    });
    [].slice.call(document.querySelectorAll('.bw-act-edit')).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var order = _ordersCache.find(function (o) { return o.id === btn.dataset.id; });
        if (order) openEditDrawer(order);
      });
    });
    [].slice.call(document.querySelectorAll('.bw-act-del')).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var order = _ordersCache.find(function (o) { return o.id === btn.dataset.id; });
        if (order) { openEditDrawer(order); _confirmDel.classList.add('is-open'); _btnDelete.style.display = 'none'; }
      });
    });
  }

  /* ══ 编辑抽屉 ════════════════════════════════════════════ */
  var _drawerOrderId = null;
  var _drawerEl      = document.getElementById('bw-edit-drawer');
  var _overlayEl     = document.getElementById('bw-drawer-overlay');
  var _drawerName    = document.getElementById('bw-drawer-item-name');
  var _drawerBadge   = document.getElementById('bw-drawer-type-badge');
  var _pillVisible   = document.getElementById('bw-pill-visible');
  var _pillHidden    = document.getElementById('bw-pill-hidden');
  var _drawerPrice   = document.getElementById('bw-drawer-price');
  var _drawerQty     = document.getElementById('bw-drawer-qty');
  var _drawerPTWrap  = document.getElementById('bw-drawer-per-trade-wrap');
  var _drawerPT      = document.getElementById('bw-drawer-per-trade');
  var _btnUpdate     = document.getElementById('bw-drawer-update');
  var _btnDelete     = document.getElementById('bw-drawer-delete');
  var _confirmDel    = document.getElementById('bw-drawer-confirm-del');
  var _btnConfNo     = document.getElementById('bw-drawer-confirm-no');
  var _btnConfYes    = document.getElementById('bw-drawer-confirm-yes');
  var _drawerMsg     = document.getElementById('bw-drawer-msg');
  var _btnClose      = document.getElementById('bw-drawer-close');

  function drawerMsg(text, type) {
    _drawerMsg.textContent = text || '';
    _drawerMsg.className = 'bw-drawer-msg' + (type ? ' ' + type : '');
  }

  function drawerSetLoading(loading) {
    [_btnUpdate, _btnDelete, _drawerPrice, _drawerQty, _pillVisible, _pillHidden].forEach(function (el) {
      if (el) el.disabled = loading;
    });
    if (_drawerPT) _drawerPT.disabled = loading;
  }

  function openEditDrawer(order) {
    _drawerOrderId = order.id;
    drawerMsg('');
    _confirmDel.classList.remove('is-open');
    _btnDelete.style.display = '';

    var item = (order.item && (order.item.zh || order.item.en)) || order.itemId || '—';
    _drawerName.textContent = item;
    _drawerBadge.textContent = order.type === 'sell' ? '出售' : '求购';
    _drawerBadge.className = 'bw-drawer-type-badge ' + (order.type === 'sell' ? 'is-sell' : 'is-buy');

    var isVisible = order.visible !== false;
    _pillVisible.classList.toggle('active', isVisible);
    _pillHidden.classList.toggle('active', !isVisible);

    _drawerPrice.value = order.platinum || '';
    _drawerQty.value   = order.quantity || '';

    var itemMeta = _itemsById[order.itemId];
    if (_drawerPTWrap) {
      var showPT = !!(itemMeta && itemMeta.bulkTradable);
      _drawerPTWrap.style.display = showPT ? '' : 'none';
      if (showPT && _drawerPT) _drawerPT.value = order.perTrade || 1;
    }

    drawerSetLoading(false);
    _drawerEl.classList.add('is-open');
    _overlayEl.classList.add('is-open');
    setTimeout(function () { _drawerPrice.focus(); }, 50);
  }

  function closeEditDrawer() {
    _drawerEl.classList.remove('is-open');
    _overlayEl.classList.remove('is-open');
    _confirmDel.classList.remove('is-open');
    _drawerOrderId = null;
  }

  _btnClose.addEventListener('click', closeEditDrawer);
  _overlayEl.addEventListener('click', function (e) { if (e.target === _overlayEl) closeEditDrawer(); });

  [_pillVisible, _pillHidden].forEach(function (pill) {
    pill.addEventListener('click', function () {
      _pillVisible.classList.toggle('active', pill === _pillVisible);
      _pillHidden.classList.toggle('active',  pill === _pillHidden);
    });
  });

  _btnUpdate.addEventListener('click', function () {
    var id = _drawerOrderId;
    if (!id) return;
    var price = parseInt(_drawerPrice.value, 10);
    var qty   = parseInt(_drawerQty.value,   10);
    if (!price || price < 1) { drawerMsg('请输入有效价格（≥1）', 'err'); return; }
    if (!qty   || qty < 1)   { drawerMsg('请输入有效数量（≥1）', 'err'); return; }

    var visible = _pillVisible.classList.contains('active');
    var payload = { platinum: price, quantity: qty, visible: visible };

    var currentOrder = _ordersCache.find(function (o) { return o.id === id; });
    var itemMeta = _itemsById[(currentOrder || {}).itemId];
    if (itemMeta && itemMeta.bulkTradable && _drawerPT) {
      var pt = parseInt(_drawerPT.value, 10);
      if (pt && pt >= 1 && pt <= 6) payload.perTrade = pt;
    }

    drawerSetLoading(true);
    drawerMsg('更新中…');
    patchOrder(id, payload)
      .then(function () { drawerMsg('更新成功！', 'ok'); setTimeout(closeEditDrawer, 600); })
      .catch(function (err) { drawerSetLoading(false); drawerMsg('更新失败：' + err.message, 'err'); });
  });

  _btnDelete.addEventListener('click', function () {
    _confirmDel.classList.add('is-open');
    _btnDelete.style.display = 'none';
  });
  _btnConfNo.addEventListener('click', function () {
    _confirmDel.classList.remove('is-open');
    _btnDelete.style.display = '';
  });
  _btnConfYes.addEventListener('click', function () {
    var id = _drawerOrderId;
    if (!id) return;
    drawerSetLoading(true);
    drawerMsg('删除中…');
    apiFetch('/api/wm/orders/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 204 || r.ok) {
          _ordersCache = _ordersCache.filter(function (o) { return o.id !== id; });
          renderFiltered();
          closeEditDrawer();
        } else {
          return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
        }
      }).catch(function (err) {
        drawerSetLoading(false);
        drawerMsg('删除失败：' + err.message, 'err');
        _confirmDel.classList.remove('is-open');
        _btnDelete.style.display = '';
      });
  });

  /* ══ 创建挂单抽屉 ════════════════════════════════════════ */
  var _createOpen    = false;
  var _createItemSel = null;

  var _createOverlay  = document.getElementById('bw-create-overlay');
  var _createDrawer   = document.getElementById('bw-create-drawer');
  var _createClose    = document.getElementById('bw-create-close');
  var _createItemQ    = document.getElementById('bw-create-item-q');
  var _createItemDrop = document.getElementById('bw-item-dropdown');
  var _createItemId   = document.getElementById('bw-create-item-id');
  var _cTypeSell      = document.getElementById('bw-create-type-sell');
  var _cTypeBuy       = document.getElementById('bw-create-type-buy');
  var _cVisOn         = document.getElementById('bw-create-vis-on');
  var _cVisOff        = document.getElementById('bw-create-vis-off');
  var _createPrice    = document.getElementById('bw-create-price');
  var _createQty      = document.getElementById('bw-create-qty');
  var _cPTWrap        = document.getElementById('bw-create-per-trade-wrap');
  var _createPT       = document.getElementById('bw-create-per-trade');
  var _cRankWrap      = document.getElementById('bw-create-rank-wrap');
  var _createRank     = document.getElementById('bw-create-rank');
  var _cRankLabel     = document.getElementById('bw-create-rank-label');
  var _cSubWrap       = document.getElementById('bw-create-subtype-wrap');
  var _createSub      = document.getElementById('bw-create-subtype');
  var _createSubmit   = document.getElementById('bw-create-submit');
  var _createMsg      = document.getElementById('bw-create-msg');

  function createMsg(text, type) {
    if (!_createMsg) return;
    _createMsg.textContent = text || '';
    _createMsg.className = 'bw-drawer-msg' + (type ? ' ' + type : '');
  }

  function openCreateDrawer() {
    _createItemSel = null;
    if (_createItemQ)    _createItemQ.value = '';
    if (_createItemId)   _createItemId.value = '';
    if (_createItemDrop) _createItemDrop.innerHTML = '';
    if (_createPrice)    _createPrice.value = '';
    if (_createQty)      _createQty.value = '1';
    if (_createRank)     _createRank.value = '0';
    if (_createPT)       _createPT.value = '1';
    if (_cTypeSell)      _cTypeSell.classList.add('active');
    if (_cTypeBuy)       _cTypeBuy.classList.remove('active');
    if (_cVisOn)         _cVisOn.classList.add('active');
    if (_cVisOff)        _cVisOff.classList.remove('active');
    if (_cPTWrap)        _cPTWrap.style.display  = 'none';
    if (_cRankWrap)      _cRankWrap.style.display = 'none';
    if (_cSubWrap)       _cSubWrap.style.display  = 'none';
    if (_createSubmit)   _createSubmit.disabled = false;
    createMsg('');

    _createOpen = true;
    if (_createDrawer)  _createDrawer.classList.add('is-open');
    if (_createOverlay) _createOverlay.classList.add('is-open');
    setTimeout(function () { if (_createItemQ) _createItemQ.focus(); }, 50);
  }

  function closeCreateDrawer() {
    _createOpen = false;
    if (_createDrawer)   _createDrawer.classList.remove('is-open');
    if (_createOverlay)  _createOverlay.classList.remove('is-open');
    if (_createItemDrop) _createItemDrop.innerHTML = '';
  }

  if (_createClose)   _createClose.addEventListener('click', closeCreateDrawer);
  if (_createOverlay) _createOverlay.addEventListener('click', function (e) {
    if (e.target === _createOverlay) closeCreateDrawer();
  });

  // ESC 关闭任一打开的抽屉
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (_createOpen) closeCreateDrawer();
    else if (_drawerOrderId) closeEditDrawer();
  });

  // 物品搜索
  var _searchTimer = null;
  if (_createItemQ) {
    _createItemQ.addEventListener('input', function () {
      clearTimeout(_searchTimer);
      var q = _createItemQ.value.trim();
      if (!q) { _createItemDrop.innerHTML = ''; _createItemSel = null; if (_createItemId) _createItemId.value = ''; return; }
      _searchTimer = setTimeout(function () { showItemDropdown(q); }, 150);
    });
  }

  document.addEventListener('click', function (e) {
    if (_createItemDrop && !_createItemDrop.contains(e.target) && e.target !== _createItemQ)
      _createItemDrop.innerHTML = '';
  });

  function showItemDropdown(q) {
    q = q.toLowerCase();
    var matches = _itemsList.filter(function (it) {
      return (it.zh && it.zh.toLowerCase().indexOf(q) !== -1) ||
             (it.en && it.en.toLowerCase().indexOf(q) !== -1);
    }).slice(0, 18);

    if (!matches.length) {
      _createItemDrop.innerHTML = '<div class="bw-item-drop-empty">无匹配物品</div>';
      return;
    }
    _createItemDrop.innerHTML = matches.map(function (it) {
      return '<div class="bw-item-drop-row" data-id="' + esc(it.id) + '">' +
        '<span class="bw-item-drop-zh">' + esc(it.zh) + '</span>' +
        '<span class="bw-item-drop-en">' + esc(it.en) + '</span>' +
      '</div>';
    }).join('');

    [].slice.call(_createItemDrop.querySelectorAll('.bw-item-drop-row')).forEach(function (row) {
      row.addEventListener('click', function () {
        var item = _itemsById[row.dataset.id];
        if (item) selectCreateItem(item);
      });
    });
  }

  function selectCreateItem(item) {
    _createItemSel = item;
    if (_createItemQ)  _createItemQ.value  = item.zh || item.en;
    if (_createItemId) _createItemId.value = item.id;
    if (_createItemDrop) _createItemDrop.innerHTML = '';

    // 批量出售
    if (_cPTWrap) _cPTWrap.style.display = item.bulkTradable ? '' : 'none';

    // 等级
    if (_cRankWrap) {
      var hasRank = item.maxRank != null && item.maxRank > 0;
      _cRankWrap.style.display = hasRank ? '' : 'none';
      if (hasRank) {
        if (_cRankLabel) _cRankLabel.textContent = '等级 (0–' + item.maxRank + ')';
        if (_createRank) { _createRank.max = item.maxRank; _createRank.value = '0'; }
      }
    }

    // 子类型
    if (_cSubWrap) {
      var hasSub = item.subtypes && item.subtypes.length;
      _cSubWrap.style.display = hasSub ? '' : 'none';
      if (hasSub && _createSub) {
        _createSub.innerHTML = item.subtypes.map(function (s) {
          return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
        }).join('');
      }
    }
  }

  // 类型 & 可见性 pill
  if (_cTypeSell && _cTypeBuy) {
    [_cTypeSell, _cTypeBuy].forEach(function (btn) {
      btn.addEventListener('click', function () {
        _cTypeSell.classList.toggle('active', btn === _cTypeSell);
        _cTypeBuy.classList.toggle('active',  btn === _cTypeBuy);
      });
    });
  }
  if (_cVisOn && _cVisOff) {
    [_cVisOn, _cVisOff].forEach(function (btn) {
      btn.addEventListener('click', function () {
        _cVisOn.classList.toggle('active',  btn === _cVisOn);
        _cVisOff.classList.toggle('active', btn === _cVisOff);
      });
    });
  }

  // 提交创建
  if (_createSubmit) {
    _createSubmit.addEventListener('click', function () {
      if (!_createItemId || !_createItemId.value) { createMsg('请先搜索并选择物品', 'err'); return; }
      var price = parseInt(_createPrice && _createPrice.value, 10);
      var qty   = parseInt(_createQty   && _createQty.value,   10);
      if (!price || price < 1) { createMsg('请输入有效价格（≥1）', 'err'); return; }
      if (!qty   || qty < 1)   { createMsg('请输入有效数量（≥1）', 'err'); return; }

      var type    = (_cTypeBuy && _cTypeBuy.classList.contains('active')) ? 'buy' : 'sell';
      var visible = !(_cVisOff && _cVisOff.classList.contains('active'));

      var body = { itemId: _createItemId.value, type: type, platinum: price, quantity: qty, visible: visible };

      if (_createItemSel && _createItemSel.bulkTradable && _createPT) {
        var pt = parseInt(_createPT.value, 10);
        if (pt >= 1 && pt <= 6) body.perTrade = pt;
      }
      if (_createItemSel && _createItemSel.maxRank != null && _createRank) {
        var rank = parseInt(_createRank.value, 10);
        if (!isNaN(rank)) body.rank = rank;
      }
      if (_createItemSel && _createItemSel.subtypes && _createItemSel.subtypes.length && _createSub) {
        body.subtype = _createSub.value;
      }

      _createSubmit.disabled = true;
      createMsg('创建中…');

      apiFetch('/api/wm/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      }).then(function (res) {
        if (!res.ok) throw new Error((res.body && res.body.error) || 'HTTP ' + res.status);
        createMsg('挂单创建成功！', 'ok');
        var newOrder = res.body && res.body.data;
        if (newOrder) {
          var meta = _itemsById[newOrder.itemId];
          if (meta) newOrder.item = { zh: meta.zh, en: meta.en };
          _ordersCache = [newOrder].concat(_ordersCache);
          renderFiltered();
        } else {
          apiFetch('/api/wm/orders').then(function (r2) { return r2.json(); })
            .then(function (j2) { renderOrders((j2 && j2.data) || []); });
        }
        setTimeout(closeCreateDrawer, 700);
      }).catch(function (err) {
        _createSubmit.disabled = false;
        createMsg('创建失败：' + err.message, 'err');
      });
    });
  }

  /* ══ 登出 ════════════════════════════════════════════════ */
  function bindLogout() {
    var btn = document.getElementById('bw-logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      apiFetch('/api/auth/logout', { method: 'POST' }).then(function () { location.href = 'login.html'; });
    });
  }

  /* ══ 星空背景 ════════════════════════════════════════════ */
  (function initStars() {
    var c = document.getElementById('star-canvas');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d'), stars = [];
    function resize() {
      c.width = window.innerWidth; c.height = window.innerHeight; stars = [];
      var n = Math.floor(c.width * c.height / 9000);
      for (var i = 0; i < n; i++)
        stars.push({ x: Math.random() * c.width, y: Math.random() * c.height,
          r: Math.random() * 1.2 + 0.2, a: Math.random() * 0.6 + 0.2, da: (Math.random() - 0.5) * 0.005 });
    }
    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      stars.forEach(function (s) {
        s.a += s.da; if (s.a > 0.85 || s.a < 0.1) s.da *= -1;
        ctx.globalAlpha = s.a; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    }
    window.addEventListener('resize', function () { resize(); });
    resize(); draw();
  })();

  /* ══ 启动 ════════════════════════════════════════════════ */
  apiFetch('/api/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.authenticated) { location.replace('login.html'); return; }

      bindLogout();
      bindToolbar();

      Promise.all([
        // 公开资料
        fetchProxy('/v2/user/' + encodeURIComponent(PROFILE_SLUG))
          .then(renderProfile)
          .catch(function () {
            document.getElementById('bw-profile-card').innerHTML = '<div class="bw-empty">资料获取失败。</div>';
          }),

        // 物品总表（用于创建抽屉搜索）
        apiFetch('/api/wm/items')
          .then(function (r) { return r.ok ? r.json() : { data: [] }; })
          .then(function (j) {
            _itemsList = (j.data || []).filter(function (it) { return it.id && (it.zh || it.en); });
            _itemsList.forEach(function (it) { _itemsById[it.id] = it; });
          })
          .catch(function () {}),

        // 全部订单
        apiFetch('/api/wm/orders')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (j) { renderOrders((j && j.data) || []); })
          .catch(function (err) { showOrdersError('挂单数据获取失败：' + err.message); }),
      ]);
    })
    .catch(function () { location.replace('login.html'); });
})();
