/* CSC·Alliance：Boss Tool —— Worker 入口
 *
 * 认证模型（v2）：
 *   用户用自己的 WM 邮箱+密码登录，Worker 代为做 WM signin，
 *   把用户自己的 WM JWT 存入 KV（key = wm_jwt_{sessionToken}），
 *   每个用户独立 JWT、独立订单视图，白名单只控制"谁能进来"。
 *
 *   BW_ACCOUNTS_JSON 支持两种格式：
 *     数组：["a@b.com", "c@d.com"]
 *     对象：{"a@b.com": "任意值", ...}（只看 key 是否存在）
 */

const SESSION_COOKIE  = 'bw_session';
const SESSION_TTL     = 60 * 60 * 12;   // 12h，与 WM JWT 同步
const WM_API          = 'https://api.warframe.market';
const WM_DEVICE_ID    = '987d81b2-8a2c-425b-ae0e-cfba824548da';
const WM_JWT_TTL      = 60 * 60 * 12;
const WM_ITEMS_KV_KEY = 'wm_items_cache';
const WM_ITEMS_TTL    = 60 * 60;
const WM_PRICE_TTL    = 60 * 5;

/* ══ 通用工具 ═══════════════════════════════════════════════ */
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function sessionCookieHeader(token, maxAge) {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}

/* 检查邮箱是否在白名单内
 * BW_ACCOUNTS_JSON 支持数组 ["a@b.com"] 或对象 {"a@b.com": "任意值"} */
function isWhitelisted(email, env) {
  try {
    const raw = JSON.parse(env.BW_ACCOUNTS_JSON || '[]');
    if (Array.isArray(raw)) return raw.map(e => String(e).trim().toLowerCase()).includes(email);
    return Object.keys(raw).some(k => k.trim().toLowerCase() === email);
  } catch { return false; }
}

/* ══ WM signin：用用户自己的凭据换取 WM JWT ══════════════ */
async function wmSigninWithCredentials(email, password) {
  const pageResp = await fetch('https://warframe.market/auth/signin', {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await pageResp.text();
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  const csrfToken = metaMatch ? metaMatch[1] : null;
  if (!csrfToken) throw new Error('无法获取 CSRF token，请稍后重试');

  const rawSetCookie = pageResp.headers.get('Set-Cookie') || '';
  const preJwtMatch  = rawSetCookie.match(/JWT=([^;,\s]+)/);
  const postHeaders  = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'Origin':       'https://warframe.market',
    'Referer':      'https://warframe.market/auth/signin',
    'Platform':     'pc',
    'Language':     'en',
    'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'x-csrftoken':  csrfToken,
  };
  if (preJwtMatch) postHeaders['Cookie'] = 'JWT=' + preJwtMatch[1];

  const resp = await fetch(`${WM_API}/v1/auth/signin`, {
    method: 'POST', headers: postHeaders,
    body: JSON.stringify({ email, password, device_id: WM_DEVICE_ID }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(resp.status === 401 ? 'WM 邮箱或密码错误' : `WM 登录失败(${resp.status})`);
  }
  const postCookie = resp.headers.get('Set-Cookie') || '';
  const jwtMatch   = postCookie.match(/JWT=([^;,\s]+)/);
  if (!jwtMatch) throw new Error('WM 未返回 JWT，请重试');
  return jwtMatch[1];
}

/* ══ 白名单登录：用 WM 账号验证身份 ═════════════════════ */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

  const email    = String((body && body.email)    || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  if (!email || !password) return jsonResponse({ error: '请输入邮箱和密码' }, 400);

  if (!isWhitelisted(email, env)) return jsonResponse({ error: '该账号不在白名单内' }, 401);

  let wmJwt;
  try { wmJwt = await wmSigninWithCredentials(email, password); }
  catch(e) { return jsonResponse({ error: e.message }, 401); }

  const token = randomToken();
  await Promise.all([
    env.BW_SESSIONS.put('sess_' + token,   JSON.stringify({ email, loginAt: Date.now() }), { expirationTtl: SESSION_TTL }),
    env.BW_SESSIONS.put('wm_jwt_' + token, wmJwt, { expirationTtl: WM_JWT_TTL }),
  ]);

  const resp = jsonResponse({ ok: true, email });
  resp.headers.set('Set-Cookie', sessionCookieHeader(token, SESSION_TTL));
  return resp;
}

async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  const token   = cookies[SESSION_COOKIE];
  if (token) {
    await Promise.all([
      env.BW_SESSIONS.delete('sess_' + token),
      env.BW_SESSIONS.delete('wm_jwt_' + token),
    ]);
  }
  const resp = jsonResponse({ ok: true });
  resp.headers.set('Set-Cookie', sessionCookieHeader('', 0));
  return resp;
}

/* 返回 { email, token } 或 null */
async function getSession(request, env) {
  const cookies = parseCookies(request);
  const token   = cookies[SESSION_COOKIE];
  if (!token) return null;
  const raw = await env.BW_SESSIONS.get('sess_' + token);
  if (!raw) return null;
  try { const rec = JSON.parse(raw); return rec ? { email: rec.email, token } : null; }
  catch { return null; }
}

async function handleMe(request, env) {
  const sess = await getSession(request, env);
  if (!sess) return jsonResponse({ ok: false, error: '未登录' }, 401);
  try {
    const wmJwt = await env.BW_SESSIONS.get('wm_jwt_' + sess.token);
    if (wmJwt) {
      const resp = await wmFetch(wmJwt, '/v2/profile', {});
      if (resp.ok) {
        const j       = await resp.json();
        const profile = j.data || j;
        const slug    = profile.slug || profile.ingame_name || sess.email.split('@')[0];
        const status  = profile.status || 'offline';
        const avatarPath = profile.avatar || null;
        const avatar  = avatarPath ? '/api/wm/avatar?path=' + encodeURIComponent(avatarPath) : null;
        return jsonResponse({ ok: true, session: { slug, status, email: sess.email, avatar } });
      }
    }
  } catch {}
  return jsonResponse({ ok: true, session: { slug: sess.email.split('@')[0], status: 'offline', email: sess.email, avatar: null } });
}

/* ══ WM API fetch：直接接受 JWT，不再共享 ════════════════ */
async function wmFetch(wmJwt, path, options) {
  const opts = Object.assign({ method: 'GET' }, options || {});
  opts.headers = Object.assign({
    'Cookie':   'JWT=' + wmJwt,
    'Platform': 'pc',
    'Language': 'en',
  }, opts.headers || {});
  return fetch(WM_API + path, opts);
}

/* 从 request 中取出当前用户的 WM JWT；失败则返回 null */
async function getWmJwt(request, env) {
  const sess = await getSession(request, env);
  if (!sess) return null;
  return env.BW_SESSIONS.get('wm_jwt_' + sess.token);
}

function wmJsonProxy(resp, text) {
  return new Response(text, {
    status:  resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ══ 物品总表缓存（KV，1h TTL，Cron 主动刷新） ═══════════ */
async function refreshItemsCache(env) {
  const [resp, zhResp] = await Promise.all([
    fetch(`${WM_API}/v2/items`, { headers: { 'Platform': 'pc', 'Language': 'en' } }),
    fetch('https://wfspeed.run/data/item-i18n-harvest.json').catch(() => null),
  ]);
  if (!resp.ok) return null;
  const json = await resp.json();
  let zhMap = {};
  if (zhResp && zhResp.ok) {
    try { zhMap = await zhResp.json(); } catch {}
  }
  const items = (json.data || []).map(function (it) {
    if (!it.id) return null;
    const en    = (it.i18n && it.i18n['en'] && it.i18n['en'].name) || it.slug;
    const zhApi = it.i18n && it.i18n['zh-hans'] && it.i18n['zh-hans'].name;
    const zh    = zhApi || zhMap[en] || null;
    // 缩略图路径（优先 i18n.en.thumb，否则顶层 thumb）
    const thumb = (it.i18n && it.i18n['en'] && it.i18n['en'].thumb) || it.thumb || null;
    const icon  = (it.i18n && it.i18n['en'] && it.i18n['en'].icon)  || it.icon  || null;
    return {
      id:           it.id,
      slug:         it.slug,
      zh:           zh || en,
      en:           en,
      thumb:        thumb,
      icon:         icon,
      bulkTradable: it.bulkTradable  || false,
      maxRank:      it.maxRank       || null,
      maxCharges:   it.maxCharges    || null,
      subtypes:     it.subtypes      || null,
      maxAmberStars: it.maxAmberStars || null,
      maxCyanStars:  it.maxCyanStars  || null,
      rarity:       it.rarity        || null,
      tradingTax:   it.trading_tax   || null,
    };
  }).filter(Boolean);
  await env.BW_SESSIONS.put(WM_ITEMS_KV_KEY, JSON.stringify(items), { expirationTtl: WM_ITEMS_TTL });
  return items;
}

async function getItemsData(env) {
  const cached = await env.BW_SESSIONS.get(WM_ITEMS_KV_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }
  return refreshItemsCache(env);
}

/* ══ WM API 代理：路由处理函数 ════════════════════════════ */

// GET /api/wm/orders —— 我方全部订单（含隐藏），使用 /v2/orders/my
async function handleWmOrders(request, env) {
  const wmJwt = await getWmJwt(request, env);
  if (!wmJwt) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const [authResp, itemsList] = await Promise.all([
      wmFetch(wmJwt, '/v2/orders/my', {}),
      getItemsData(env),
    ]);

    const authJson = authResp.ok ? await authResp.json() : { data: [] };

    const itemMap = {};
    (itemsList || []).forEach(function (it) { itemMap[it.id] = it; });

    const merged = (authJson.data || []).map(function (o) {
      const it = itemMap[o.itemId];
      if (!it) return o;
      return Object.assign({}, o, {
        /* 前端依赖 item.url_name 提取 slug，统一放进去 */
        item:  { zh: it.zh, en: it.en, url_name: it.slug },
        thumb: it.thumb || null,
        slug:  it.slug  || null,
        rarity:     it.rarity     || null,
        tradingTax: it.tradingTax || null,
        maxRank:    it.maxRank    || null,
      });
    });

    return jsonResponse({ data: merged });
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// GET /api/wm/items
async function handleWmItems(request, env) {
  if (!await getSession(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const items = await getItemsData(env);
    return jsonResponse({ data: items || [] });
  } catch (e) {
    return jsonResponse({ error: '获取物品列表失败：' + e.message }, 502);
  }
}

// POST /api/wm/refresh-items —— 手动触发物品缓存刷新
async function handleWmRefreshItems(request, env) {
  if (!await getSession(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    await env.BW_SESSIONS.delete(WM_ITEMS_KV_KEY);
    const items = await refreshItemsCache(env);
    return jsonResponse({ ok: true, count: (items || []).length });
  } catch (e) {
    return jsonResponse({ error: '刷新失败：' + e.message }, 502);
  }
}

// POST /api/wm/orders —— 创建订单
async function handleWmOrderCreate(request, env) {
  const wmJwt = await getWmJwt(request, env);
  if (!wmJwt) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const body = await request.text();
    const resp = await wmFetch(wmJwt, '/v2/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// PATCH /api/wm/orders/:id
async function handleWmOrderPatch(request, env, orderId) {
  const wmJwt = await getWmJwt(request, env);
  if (!wmJwt) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const body = await request.text();
    const resp = await wmFetch(wmJwt, `/v2/orders/${orderId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// DELETE /api/wm/orders/:id
async function handleWmOrderDelete(request, env, orderId) {
  const wmJwt = await getWmJwt(request, env);
  if (!wmJwt) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const resp = await wmFetch(wmJwt, `/v2/orders/${orderId}`, { method: 'DELETE' });
    if (resp.status === 204) return new Response(null, { status: 204 });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// GET /api/wm/price/:slug —— 计算物品"均价"（WM v1 公开端点，无需 JWT）
async function handleWmPrice(request, env, slug) {
  if (!await getSession(request, env)) return jsonResponse({ error: '请先登录' }, 401);

  const cacheKey = 'avg_price_' + slug;
  const cached = await env.BW_SESSIONS.get(cacheKey);
  if (cached) {
    try { return jsonResponse({ data: JSON.parse(cached) }); } catch {}
  }

  try {
    /* v1 公开接口，不需要 JWT，响应格式：{ payload: { sell_orders: [...] } } */
    const resp = await fetch(
      `${WM_API}/v1/items/${encodeURIComponent(slug)}/orders`,
      { headers: { 'Platform': 'pc', 'Language': 'en', 'Accept': 'application/json' } }
    );
    if (!resp.ok) return jsonResponse({ data: { avg: null, count: 0, used: 0 } });

    const json = await resp.json();
    /* v1: payload.sell_orders；兼容 v2: data */
    const allOrders = (json.payload && json.payload.sell_orders)
                   || (json.payload && json.payload.orders)
                   || json.data || [];

    const prices = allOrders
      .filter(function(o) {
        const type   = o.order_type || o.orderType || '';
        const status = (o.user && (o.user.status || o.user.ingame_status)) || '';
        return type === 'sell' && status === 'ingame' && o.visible !== false;
      })
      .map(function(o) { return o.platinum; })
      .sort(function(a, b) { return a - b; });

    let avg = null;
    const count = prices.length;
    let used = 0;

    if (count > 0) {
      const lo = Math.min(3, Math.floor(count / 5));
      const hi = Math.min(5, Math.floor(count / 4));
      const end = count - hi > lo ? count - hi : count;
      const trimmed = prices.slice(lo, end);
      used = trimmed.length;
      avg = used > 0
        ? Math.round(trimmed.reduce(function(s, v) { return s + v; }, 0) / used)
        : Math.round(prices.reduce(function(s, v) { return s + v; }, 0) / count);
    }

    const result = { avg, count, used };
    await env.BW_SESSIONS.put(cacheKey, JSON.stringify(result), { expirationTtl: WM_PRICE_TTL });
    return jsonResponse({ data: result });
  } catch (e) {
    return jsonResponse({ data: { avg: null, count: 0, used: 0 } });
  }
}

// GET /api/wm/stats/:slug —— 物品交易统计（近90天均价趋势 + 成交量）
async function handleWmStats(request, env, slug) {
  if (!await getSession(request, env)) return jsonResponse({ error: '请先登录' }, 401);

  const cacheKey = 'stats_' + slug;
  const cached   = await env.BW_SESSIONS.get(cacheKey);
  if (cached) { try { return jsonResponse({ data: JSON.parse(cached) }); } catch {} }

  try {
    /* WM v1 统计接口（v2 尚无等效端点） */
    const resp = await fetch(
      `${WM_API}/v1/items/${encodeURIComponent(slug)}/statistics`,
      { headers: { 'Platform': 'pc', 'Language': 'en', 'Accept': 'application/json' } }
    );
    if (!resp.ok) return jsonResponse({ data: null });
    const json = await resp.json();
    const raw  = (json.payload && json.payload.statistics_closed) || [];

    /* 只保留近 90 天 sell 条目，按日期聚合（WM 可能返回重复日） */
    const cutoff = Date.now() - 90 * 86400 * 1000;
    const dayMap = {};
    raw.filter(r => r.order_type === 'sell' && new Date(r.datetime).getTime() >= cutoff)
       .forEach(r => {
         const day = r.datetime.slice(0, 10);
         if (!dayMap[day]) dayMap[day] = { day, sum: 0, volume: 0, count: 0, median: 0 };
         dayMap[day].sum    += (r.avg_price || 0) * (r.volume || 1);
         dayMap[day].volume += r.volume || 1;
         dayMap[day].count  += 1;
         dayMap[day].median  = r.median || dayMap[day].median;
       });
    const points = Object.values(dayMap)
      .map(d => ({ day: d.day, avg: d.volume > 0 ? Math.round(d.sum / d.volume) : 0, volume: d.volume, median: d.median }))
      .sort((a, b) => a.day.localeCompare(b.day));

    await env.BW_SESSIONS.put(cacheKey, JSON.stringify(points), { expirationTtl: 1800 });
    return jsonResponse({ data: points });
  } catch (e) {
    return jsonResponse({ data: null });
  }
}

// GET /api/wm/item/:slug —— 物品详情
async function handleWmItemDetail(request, env, slug) {
  if (!await getSession(request, env)) return jsonResponse({ error: '请先登录' }, 401);

  const cacheKey = 'item_detail_' + slug;
  const cached = await env.BW_SESSIONS.get(cacheKey);
  if (cached) {
    try { return jsonResponse({ data: JSON.parse(cached) }); } catch {}
  }

  try {
    const resp = await fetch(`${WM_API}/v2/item/${encodeURIComponent(slug)}`, {
      headers: { 'Platform': 'pc', 'Language': 'zh-hans' },
    });
    if (!resp.ok) return jsonResponse({ data: null });
    const json = await resp.json();
    const data = json.data || null;
    if (data) {
      await env.BW_SESSIONS.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
    }
    return jsonResponse({ data });
  } catch (e) {
    return jsonResponse({ data: null });
  }
}

/* ══ 主路由 ═══════════════════════════════════════════════ */
/* ══ 静态资源代理（缩略图/头像） ═══════════════════════════ */
async function handleThumbProxy(request) {
  const url  = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path) return new Response('missing path', { status: 400 });
  const upstream = 'https://warframe.market/static/' + path.replace(/^\/+/, '');
  const r = await fetch(upstream, { headers: { 'Referer': 'https://warframe.market/' } });
  const headers = new Headers();
  const ct = r.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  headers.set('cache-control', 'public, max-age=86400');
  return new Response(r.body, { status: r.status, headers });
}

async function handleAvatarProxy(request) {
  const url  = new URL(request.url);
  /* 优先接受 path 参数（来自 /v2/profile avatar 字段），兼容旧 slug 参数 */
  const path = url.searchParams.get('path');
  const slug = url.searchParams.get('slug');
  if (!path && !slug) return new Response('missing path/slug', { status: 400 });
  const upstream = path
    ? 'https://warframe.market/static/assets/' + path.replace(/^\/+/, '')
    : 'https://warframe.market/static/assets/user/avatars/' + slug + '.png';
  const r = await fetch(upstream, { headers: { 'Referer': 'https://warframe.market/' } });
  if (!r.ok) return new Response('not found', { status: 404 });
  const headers = new Headers();
  const ct = r.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  headers.set('cache-control', 'public, max-age=3600');
  return new Response(r.body, { status: r.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p   = url.pathname;

    /* auth 路由（旧名保留，同时支持 /api/wm/ 前缀别名）*/
    if ((p === '/api/auth/login'  || p === '/api/wm/signin')   && request.method === 'POST') return handleLogin(request, env);
    if ((p === '/api/auth/logout' || p === '/api/wm/signout')  && request.method === 'POST') return handleLogout(request, env);
    if ((p === '/api/auth/me'     || p === '/api/wm/session')  && request.method === 'GET')  return handleMe(request, env);

    /* 静态代理 */
    if (p === '/api/wm/thumb'  && request.method === 'GET') return handleThumbProxy(request);
    if (p === '/api/wm/avatar' && request.method === 'GET') return handleAvatarProxy(request);

    if (p === '/api/wm/items'         && request.method === 'GET')  return handleWmItems(request, env);
    if (p === '/api/wm/refresh-items' && request.method === 'POST') return handleWmRefreshItems(request, env);
    if (p === '/api/wm/orders'        && request.method === 'GET')  return handleWmOrders(request, env);
    if (p === '/api/wm/orders'        && request.method === 'POST') return handleWmOrderCreate(request, env);
    /* 单数别名 /api/wm/order（POST=创建，PATCH/DELETE 由下方 match 处理）*/
    if (p === '/api/wm/order' && request.method === 'POST') return handleWmOrderCreate(request, env);

    /* /api/wm/orders/:id 或 /api/wm/order/:id */
    const orderMatch = p.match(/^\/api\/wm\/orders?\/([^/]+)$/);
    if (orderMatch) {
      if (request.method === 'PATCH')  return handleWmOrderPatch(request, env, orderMatch[1]);
      if (request.method === 'DELETE') return handleWmOrderDelete(request, env, orderMatch[1]);
    }

    const priceMatch = p.match(/^\/api\/wm\/price\/([^/]+)$/);
    if (priceMatch && request.method === 'GET') return handleWmPrice(request, env, priceMatch[1]);

    const statsMatch = p.match(/^\/api\/wm\/stats\/([^/]+)$/);
    if (statsMatch && request.method === 'GET') return handleWmStats(request, env, statsMatch[1]);

    const itemDetailMatch = p.match(/^\/api\/wm\/item\/([^/]+)$/);
    if (itemDetailMatch && request.method === 'GET') return handleWmItemDetail(request, env, itemDetailMatch[1]);

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshItemsCache(env));
  },
};
