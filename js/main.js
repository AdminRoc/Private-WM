/* ════════════════════════════════════════════════════════════
   main.js —— Phase 2：认证门控 + 私有订单管理
   - 启动时先检查 /api/auth/me，未登录跳转 login.html
   - 公开资料（头像/IGN/声望）仍走 wm.wfspeed.run 公开代理
   - 订单数据改走 /api/wm/orders（后端代理，含隐藏单）
   - 支持：可见性切换 / 改价 / 删除
   ════════════════════════════════════════════════════════════ */
(function () {
  var WM_PROXY_BASE = 'https://wm.wfspeed.run';
  var PROFILE_SLUG  = 'csc-2026';

  var STATUS_LABEL = { online: '在线', ingame: '游戏中', offline: '离线', invisible: '隐身' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── 公开资料代理（wm.wfspeed.run，带重试） ── */
  function fetchProxyOnce(path) {
    var url  = WM_PROXY_BASE + path;
    var ctrl = new AbortController();
    var t    = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j && j.error) throw new Error(JSON.stringify(j.error)); return j && j.data; });
  }
  function fetchProxy(path, attempt) {
    attempt = attempt || 0;
    return fetchProxyOnce(path).catch(function (err) {
      if (attempt >= 2) throw err;
      return new Promise(function (res) { setTimeout(res, attempt === 0 ? 500 : 1200); })
        .then(function () { return fetchProxy(path, attempt + 1); });
    });
  }

  /* ── 我方后端 API ── */
  function apiFetch(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
  }

  /* ── 头像兜底链 ── */
  function avatarChain(user) {
    var custom = 'picture/avatar-' + encodeURIComponent(PROFILE_SLUG) + '.png';
    var wm     = user.avatar ? WM_PROXY_BASE + '/static/' + user.avatar : null;
    return [custom, wm].filter(Boolean);
  }

  /* ══════════════════════════════════════════════
     渲染：资料卡
  ══════════════════════════════════════════════ */
  function renderProfile(user) {
    var card = document.getElementById('bw-profile-card');
    if (!user) { card.innerHTML = '<div class="bw-empty">未能获取账号资料。</div>'; return; }
    var chain    = avatarChain(user);
    var src      = chain.shift() || '';
    var fbAttr   = chain.length
      ? ' onerror="this.onerror=null;this.src=\'' + esc(chain[0]) + '\';"'
      : ' onerror="this.style.visibility=\'hidden\';"';
    var status   = STATUS_LABEL[user.status] || user.status || '';
    card.innerHTML =
      '<img class="bw-avatar" src="' + esc(src) + '" alt=""' + fbAttr + '>' +
      '<div class="bw-profile-info">' +
        '<div class="bw-ign">' + esc(user.ingameName || PROFILE_SLUG) + '</div>' +
        '<div class="bw-meta">' +
          '<span><span class="bw-status-dot ' + esc(user.status || 'offline') + '"></span>' + esc(status) + '</span>' +
          (user.masteryRank ? '<span>段位 MR' + esc(user.masteryRank) + '</span>' : '') +
          (typeof user.reputation === 'number' ? '<span>声望 ' + esc(user.reputation) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  /* ══════════════════════════════════════════════
     渲染：订单列表（含管理控件）
  ══════════════════════════════════════════════ */
  var _ordersCache = [];   // 当前全量订单，供操作后局部刷新用

  function orderRow(o) {
    var item    = (o.item && (o.item.en || o.item.zh || o.item.en_name || o.item.slug)) || o.itemId || '—';
    var qty     = o.quantity ? '×' + o.quantity : '';
    var hidden  = o.visible === false;
    var visIcon = hidden ? '👁' : '👁';
    var visTip  = hidden ? '当前隐藏，点击显示' : '当前显示，点击隐藏';

    return '<div class="bw-order-row' + (hidden ? ' bw-order-hidden' : '') + '" data-id="' + esc(o.id) + '">' +
      '<span class="bw-order-item">' + esc(item) + '</span>' +
      '<span class="bw-order-qty">' + esc(qty) + '</span>' +
      '<span class="bw-order-price-wrap">' +
        '<span class="bw-order-price" data-price="' + esc(o.platinum) + '">' + esc(o.platinum) + 'p</span>' +
      '</span>' +
      (hidden ? '<span class="bw-hidden-badge">隐藏</span>' : '') +
      '<div class="bw-order-actions">' +
        '<button class="bw-act-btn bw-act-vis' + (hidden ? ' is-hidden' : '') + '" data-id="' + esc(o.id) + '" data-visible="' + (!hidden) + '" title="' + visTip + '">' + visIcon + '</button>' +
        '<button class="bw-act-btn bw-act-edit" data-id="' + esc(o.id) + '" data-price="' + esc(o.platinum) + '" title="修改价格">✏</button>' +
        '<button class="bw-act-btn bw-act-del" data-id="' + esc(o.id) + '" title="删除">✕</button>' +
      '</div>' +
    '</div>';
  }

  function renderOrders(orders) {
    _ordersCache = orders || [];
    var sellEl = document.getElementById('bw-sell-list');
    var buyEl  = document.getElementById('bw-buy-list');
    var scEl   = document.getElementById('bw-sell-count');
    var bcEl   = document.getElementById('bw-buy-count');

    var sell = _ordersCache.filter(function (o) { return o.type === 'sell'; });
    var buy  = _ordersCache.filter(function (o) { return o.type === 'buy'; });

    // 可见单在前，隐藏单在后
    function sortOrders(arr) {
      return arr.slice().sort(function (a, b) {
        if (a.visible === false && b.visible !== false) return 1;
        if (a.visible !== false && b.visible === false) return -1;
        return 0;
      });
    }

    var sortedSell = sortOrders(sell);
    var sortedBuy  = sortOrders(buy);

    var visibleSell = sell.filter(function (o) { return o.visible !== false; }).length;
    var visibleBuy  = buy.filter(function (o) { return o.visible !== false; }).length;

    scEl.textContent = sell.length ? ('(' + visibleSell + '/' + sell.length + ')') : '';
    bcEl.textContent = buy.length  ? ('(' + visibleBuy  + '/' + buy.length  + ')') : '';

    sellEl.innerHTML = sortedSell.length ? sortedSell.map(orderRow).join('') : '<div class="bw-empty">暂无出售挂单</div>';
    buyEl.innerHTML  = sortedBuy.length  ? sortedBuy.map(orderRow).join('')  : '<div class="bw-empty">暂无求购挂单</div>';

    [].slice.call(document.querySelectorAll('.bw-order-row')).forEach(function (el, i) {
      el.style.animationDelay = (i * 0.04) + 's';
    });

    bindOrderActions();
  }

  function showOrdersError(msg) {
    var html = '<div class="bw-empty">' + esc(msg || '挂单数据获取失败，请稍后重试。') + '</div>';
    document.getElementById('bw-sell-list').innerHTML = html;
    document.getElementById('bw-buy-list').innerHTML  = html;
  }

  /* ══════════════════════════════════════════════
     订单操作：可见性 / 改价 / 删除
  ══════════════════════════════════════════════ */
  function setRowLoading(id, loading) {
    var row = document.querySelector('.bw-order-row[data-id="' + id + '"]');
    if (!row) return;
    row.classList.toggle('bw-row-loading', loading);
    [].slice.call(row.querySelectorAll('.bw-act-btn')).forEach(function (b) { b.disabled = loading; });
  }

  function patchOrder(id, payload) {
    setRowLoading(id, true);
    return apiFetch('/api/wm/orders/' + id, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      return r.json();
    }).then(function (j) {
      // 用服务器返回值更新本地缓存
      var updated = j && (j.data || j.payload && j.payload.order);
      if (updated) {
        _ordersCache = _ordersCache.map(function (o) { return o.id === id ? Object.assign({}, o, updated) : o; });
      } else {
        _ordersCache = _ordersCache.map(function (o) { return o.id === id ? Object.assign({}, o, payload) : o; });
      }
      renderOrders(_ordersCache);
    }).catch(function (err) {
      setRowLoading(id, false);
      alert('操作失败：' + err.message);
    });
  }

  function deleteOrder(id) {
    if (!confirm('确认删除该挂单？')) return;
    setRowLoading(id, true);
    apiFetch('/api/wm/orders/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 204 || r.ok) {
          _ordersCache = _ordersCache.filter(function (o) { return o.id !== id; });
          renderOrders(_ordersCache);
        } else {
          return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
        }
      }).catch(function (err) {
        setRowLoading(id, false);
        alert('删除失败：' + err.message);
      });
  }

  function editPrice(id, currentPrice) {
    var input = prompt('输入新价格（铂金）：', currentPrice);
    if (input === null) return;
    var price = parseInt(input, 10);
    if (!price || price < 1) { alert('价格无效。'); return; }
    patchOrder(id, { platinum: price });
  }

  function bindOrderActions() {
    // 可见性切换
    [].slice.call(document.querySelectorAll('.bw-act-vis')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id      = btn.dataset.id;
        var visible = btn.dataset.visible === 'true';
        patchOrder(id, { visible: visible });
      });
    });
    // 改价
    [].slice.call(document.querySelectorAll('.bw-act-edit')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        editPrice(btn.dataset.id, btn.dataset.price);
      });
    });
    // 删除
    [].slice.call(document.querySelectorAll('.bw-act-del')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        deleteOrder(btn.dataset.id);
      });
    });
  }

  /* ══════════════════════════════════════════════
     登出按钮
  ══════════════════════════════════════════════ */
  function bindLogout() {
    var btn = document.getElementById('bw-logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      apiFetch('/api/auth/logout', { method: 'POST' }).then(function () {
        location.href = 'login.html';
      });
    });
  }

  /* ══════════════════════════════════════════════
     启动：鉴权检查 → 加载数据
  ══════════════════════════════════════════════ */
  apiFetch('/api/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.authenticated) {
        location.replace('login.html');
        return;
      }

      bindLogout();

      // 公开资料走代理（头像/IGN/声望）
      fetchProxy('/v2/user/' + encodeURIComponent(PROFILE_SLUG))
        .then(renderProfile)
        .catch(function () {
          document.getElementById('bw-profile-card').innerHTML = '<div class="bw-empty">资料获取失败。</div>';
        });

      // 私有订单走我方后端（含隐藏单）
      apiFetch('/api/wm/orders')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          // WM v2 返回格式：{ data: [...] }
          var orders = (j && j.data) || [];
          renderOrders(orders);
        })
        .catch(function (err) {
          showOrdersError('挂单数据获取失败：' + err.message);
        });
    })
    .catch(function () {
      location.replace('login.html');
    });

  /* ── 星空背景 ── */
  (function initStars() {
    var c = document.getElementById('star-canvas');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d'), stars = [];
    function resize() {
      c.width = window.innerWidth; c.height = window.innerHeight; stars = [];
      var n = Math.floor(c.width * c.height / 9000);
      for (var i = 0; i < n; i++)
        stars.push({ x: Math.random() * c.width, y: Math.random() * c.height, r: Math.random() * 1.2 + 0.2, a: Math.random() * 0.6 + 0.2 });
    }
    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      stars.forEach(function (s) { ctx.globalAlpha = s.a; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1;
    }
    window.addEventListener('resize', function () { resize(); draw(); });
    resize(); draw();
  })();
})();
