/* ════════════════════════════════════════════════════════════
   main.js —— Phase 1：个人档案页视觉还原（只读，公开端点，零凭据）
   全部请求经 wm.wfspeed.run 边缘代理转发，前端不直连 api.warframe.market。
   代理已是通用 /v2/* GET 透传（见 Ws-Web-core/cloudflare-worker-wm/
   edgeone-function.js），公开端点无需任何改动即可直接使用。
   ════════════════════════════════════════════════════════════ */
(function () {
  var WM_PROXY_BASE = 'https://wm.wfspeed.run';
  var PROFILE_SLUG = 'csc-2026';

  var STATUS_LABEL = { online: '在线', ingame: '游戏中', offline: '离线', invisible: '隐身' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fetchProxy(path) {
    var url = WM_PROXY_BASE.replace(/\/$/, '') + path;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j && j.error) throw new Error(JSON.stringify(j.error));
      return j && j.data;
    });
  }

  /* 自定义头像兜底：用户可指定自己的 logo 图，按主页路径存放在仓库里
     picture/avatar-{slug}.png，优先级高于 WM 自带头像（WM 头像经常裂图/
     读取失败，自定义图稳定、自托管、零外部依赖）。文件不存在时 onerror
     自动回退到 WM 头像，WM 头像也失败则隐藏图片。 */
  function avatarChain(user) {
    var custom = 'picture/avatar-' + encodeURIComponent(PROFILE_SLUG) + '.png';
    var wm = user.avatar
      ? WM_PROXY_BASE.replace(/\/$/, '') + '/static/' + user.avatar
      : null;
    return [custom, wm].filter(Boolean);
  }

  function renderProfile(user) {
    var card = document.getElementById('bw-profile-card');
    if (!user) {
      card.innerHTML = '<div class="bw-empty">未能获取该账号资料，请稍后重试。</div>';
      return;
    }
    var chain = avatarChain(user);
    var avatarUrl = chain.shift() || 'https://warframe.market/static/assets/user/default-avatar.png';
    var fallbackAttr = chain.length
      ? ' onerror="this.onerror=null;this.src=\'' + esc(chain[0]) + '\';this.dataset.bwFallback=1;"'
      : ' onerror="this.style.visibility=\'hidden\'"';
    var status = STATUS_LABEL[user.status] || user.status || '';
    card.innerHTML =
      '<img class="bw-avatar" src="' + esc(avatarUrl) + '" alt="" ' + fallbackAttr + '>' +
      '<div class="bw-profile-info">' +
        '<div class="bw-ign">' + esc(user.ingameName || PROFILE_SLUG) + '</div>' +
        '<div class="bw-meta">' +
          '<span><span class="bw-status-dot ' + esc(user.status || 'offline') + '"></span>' + esc(status) + '</span>' +
          (user.masteryRank ? '<span>段位 MR' + esc(user.masteryRank) + '</span>' : '') +
          (typeof user.reputation === 'number' ? '<span>声望 ' + esc(user.reputation) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  function orderRow(o) {
    var item = (o.item && (o.item.en || o.item.zh)) || o.itemId || '';
    var qty = o.quantity ? ('×' + o.quantity) : '';
    return '<div class="bw-order-row">' +
      '<span class="bw-order-item">' + esc(item) + '</span>' +
      '<span class="bw-order-qty">' + esc(qty) + '</span>' +
      '<span class="bw-order-price">' + esc(o.platinum) + 'p</span>' +
      '</div>';
  }

  function renderOrders(orders) {
    var sellEl = document.getElementById('bw-sell-list');
    var buyEl = document.getElementById('bw-buy-list');
    var sellCountEl = document.getElementById('bw-sell-count');
    var buyCountEl = document.getElementById('bw-buy-count');
    if (!orders) orders = [];
    var sell = orders.filter(function (o) { return o.type === 'sell' && o.visible !== false; });
    var buy = orders.filter(function (o) { return o.type === 'buy' && o.visible !== false; });

    sellCountEl.textContent = sell.length ? ('(' + sell.length + ')') : '';
    buyCountEl.textContent = buy.length ? ('(' + buy.length + ')') : '';

    sellEl.innerHTML = sell.length
      ? sell.map(orderRow).join('')
      : '<div class="bw-empty">暂无出售挂单</div>';
    buyEl.innerHTML = buy.length
      ? buy.map(orderRow).join('')
      : '<div class="bw-empty">暂无求购挂单</div>';

    // 逐行错开入场，复用 bwRowIn 动画。
    [].slice.call(document.querySelectorAll('.bw-order-row')).forEach(function (el, i) {
      el.style.animationDelay = (i * 0.045) + 's';
    });
  }

  function showOrdersError() {
    var msg = '<div class="bw-empty">挂单数据获取失败，请稍后重试。</div>';
    document.getElementById('bw-sell-list').innerHTML = msg;
    document.getElementById('bw-buy-list').innerHTML = msg;
  }

  function showProfileError() {
    document.getElementById('bw-profile-card').innerHTML =
      '<div class="bw-empty">资料获取失败，请稍后重试。</div>';
  }

  fetchProxy('/v2/user/' + encodeURIComponent(PROFILE_SLUG))
    .then(renderProfile)
    .catch(showProfileError);

  fetchProxy('/v2/orders/user/' + encodeURIComponent(PROFILE_SLUG))
    .then(renderOrders)
    .catch(showOrdersError);

  // ─── 星空背景（与主站一致的轻量装饰，非必需功能，失败不影响主体内容） ───
  (function initStars() {
    var c = document.getElementById('star-canvas');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d');
    var stars = [];
    function resize() {
      c.width = window.innerWidth; c.height = window.innerHeight;
      stars = [];
      var n = Math.floor((c.width * c.height) / 9000);
      for (var i = 0; i < n; i++) {
        stars.push({ x: Math.random() * c.width, y: Math.random() * c.height, r: Math.random() * 1.2 + 0.2, a: Math.random() * 0.6 + 0.2 });
      }
    }
    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      stars.forEach(function (s) {
        ctx.globalAlpha = s.a;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    window.addEventListener('resize', function () { resize(); draw(); });
    resize(); draw();
  })();
})();
