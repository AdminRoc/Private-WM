/* CSC·Alliance：Boss Tool —— Worker 入口
 *
 * 职责：
 *   ① /api/auth/*   —— 我方站点白名单登录（与 WM 账号无关）。
 *   ② /api/wm/*     —— 后端代理 WM 私有 API（需通过 ① 验证才可调用）。
 *                      Worker 用存储的 WM 凭据在后端完成 WM 登录并缓存 JWT，
 *                      前端不直接接触 WM 凭据或 JWT。
 *   ③ 其余路径      —— 落到 Workers Static Assets（index.html/css/js/picture）。
 *
 * 安全要点：
 *   - 我方口令只比对 SHA-256 摘要，不存明文。
 *   - WM 凭据（WM_EMAIL / WM_PASSWORD）存 Cloudflare Secret，不进仓库。
 *   - WM JWT 存 KV，12h TTL；过期或 401 时自动用存储凭据重新签入。
 *   - 我方会话 cookie：HttpOnly + Secure + SameSite=Strict，JS 不可读。
 *   - 同一时间只允许一个我方会话（新登录挤掉旧会话）。
 */

/* ══════════════════════════════════════════════
   常量
══════════════════════════════════════════════ */
const SESSION_COOKIE     = 'bw_session';
const SESSION_TTL        = 60 * 60 * 24 * 7;   // 7 天
const WM_API             = 'https://api.warframe.market';
const WM_DEVICE_ID       = '987d81b2-8a2c-425b-ae0e-cfba824548da';
const WM_SLUG            = 'csc-2026';
const WM_JWT_KV_KEY      = 'wm_jwt';
const WM_JWT_TTL         = 60 * 60 * 12;        // 12 小时（WM JWT 通常 24h，保守取半）

/* ══════════════════════════════════════════════
   通用工具
══════════════════════════════════════════════ */
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

/* ══════════════════════════════════════════════
   我方站点：白名单登录系统
══════════════════════════════════════════════ */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

  const email    = String((body && body.email)    || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  if (!email || !password) return jsonResponse({ error: '请输入邮箱和口令' }, 400);

  let accounts = {};
  try { accounts = JSON.parse(env.BW_ACCOUNTS_JSON || '{}'); } catch { /* 全部拒绝 */ }

  let expectedHash = null;
  Object.keys(accounts).forEach((k) => {
    if (k.trim().toLowerCase() === email) expectedHash = accounts[k];
  });
  if (!expectedHash) return jsonResponse({ error: '账号或口令不正确' }, 401);

  const hash = await sha256Hex(password);
  if (hash !== expectedHash) return jsonResponse({ error: '账号或口令不正确' }, 401);

  const token = randomToken();
  await env.BW_SESSIONS.put('current_session', JSON.stringify({ token, email, loginAt: Date.now() }), {
    expirationTtl: SESSION_TTL,
  });

  const resp = jsonResponse({ ok: true, email });
  resp.headers.set('Set-Cookie', sessionCookieHeader(token, SESSION_TTL));
  return resp;
}

async function handleLogout(request, env) {
  await env.BW_SESSIONS.delete('current_session');
  const resp = jsonResponse({ ok: true });
  resp.headers.set('Set-Cookie', sessionCookieHeader('', 0));
  return resp;
}

async function getSessionEmail(request, env) {
  const cookies = parseCookies(request);
  const token   = cookies[SESSION_COOKIE];
  if (!token) return null;
  const raw = await env.BW_SESSIONS.get('current_session');
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (!rec || rec.token !== token) return null;
  return rec.email;
}

async function handleMe(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ authenticated: false });
  return jsonResponse({ authenticated: true, email });
}

/* ══════════════════════════════════════════════
   WM 后端代理：JWT 管理
══════════════════════════════════════════════ */
// 从 Set-Cookie 响应头里提取指定 cookie 的值
function extractCookieValue(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  // Set-Cookie 可能是多条，Cloudflare Workers 会把它们合并为逗号分隔
  // 逐段匹配 name=value
  const re = new RegExp('(?:^|,\\s*)' + name + '=([^;,]+)');
  const m  = re.exec(setCookieHeader);
  return m ? m[1] : null;
}

async function wmSignin(env) {
  // ① GET 登录页 HTML，同时收集 session cookie 和 CSRF token
  //    WM 服务器把 CSRF token 嵌在 <meta name="csrf-token"> 中，
  //    且 token 与本次 GET 建立的 server-side session 绑定，
  //    所以 POST 时必须带回同一批 Set-Cookie 才能通过验证。
  const pageResp = await fetch('https://warframe.market/auth/signin', {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await pageResp.text();

  // 从 meta 标签提取 CSRF token
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  const csrfToken = metaMatch ? metaMatch[1] : null;
  if (!csrfToken) throw new Error('WM signin: csrf-token meta not found in page');

  // 从 Set-Cookie 里提取 JWT（WM 在 GET /auth/signin 时就下发匿名预认证 JWT，
  // CSRF token 与该 JWT 标识的服务端 session 绑定，POST 必须带回此 cookie）
  const rawSetCookie = pageResp.headers.get('Set-Cookie') || '';
  const jwtMatch = rawSetCookie.match(/JWT=([^;,\s]+)/);
  const preJwt = jwtMatch ? jwtMatch[1] : null;

  // ② POST signin
  //    实际 header 名（WM 前端代码）：x-csrftoken（全小写，无连字符）
  const postHeaders = {
    'Content-Type':    'application/json',
    'Accept':          'application/json',
    'Origin':          'https://warframe.market',
    'Referer':         'https://warframe.market/auth/signin',
    'Platform':        'pc',
    'Language':        'en',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-csrftoken':     csrfToken,
  };
  if (preJwt) {
    postHeaders['Cookie'] = 'JWT=' + preJwt;
  }

  const resp = await fetch(`${WM_API}/v1/auth/signin`, {
    method:  'POST',
    headers: postHeaders,
    body: JSON.stringify({
      email:     env.WM_EMAIL,
      password:  env.WM_PASSWORD,
      device_id: WM_DEVICE_ID,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`WM signin failed: ${resp.status} — ${errText.slice(0, 300)}`);
  }

  // WM 在 POST 响应的 Set-Cookie 里返回已认证的新 JWT
  const postSetCookie = resp.headers.get('Set-Cookie') || '';
  const jwtResult     = postSetCookie.match(/JWT=([^;,\s]+)/);
  const jwt           = jwtResult ? jwtResult[1] : null;
  if (!jwt) throw new Error(`WM signin: JWT not in POST response Set-Cookie. raw=${postSetCookie.slice(0, 200)}`);

  await env.BW_SESSIONS.put(WM_JWT_KV_KEY, jwt, { expirationTtl: WM_JWT_TTL });
  return jwt;
}

async function getWmJwt(env) {
  const cached = await env.BW_SESSIONS.get(WM_JWT_KV_KEY);
  if (cached) return cached;
  return wmSignin(env);
}

// 带自动重试（JWT 过期时重新签入一次）的 WM 请求
async function wmFetch(env, path, options) {
  const jwt  = await getWmJwt(env);
  const opts = Object.assign({ method: 'GET' }, options || {});
  opts.headers = Object.assign({
    'Cookie':   'JWT=' + jwt,
    'Platform': 'pc',
    'Language': 'en',
  }, opts.headers || {});

  let resp = await fetch(WM_API + path, opts);

  if (resp.status === 401) {
    // JWT 失效，清缓存、重新签入、重试一次
    await env.BW_SESSIONS.delete(WM_JWT_KV_KEY);
    const newJwt = await wmSignin(env);
    opts.headers['Cookie'] = 'JWT=' + newJwt;
    resp = await fetch(WM_API + path, opts);
  }

  return resp;
}

/* ══════════════════════════════════════════════
   WM 后端代理：路由处理函数
   全部需要先通过我方 session 鉴权
══════════════════════════════════════════════ */

function wmJsonProxy(resp, text) {
  return new Response(text, {
    status:  resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/wm/orders —— 获取全部挂单（含隐藏），仅本账号可见
// 策略：
//   ① 认证端点取全部订单（含隐藏），只含 itemId
//   ② 并发拉 /v1/items 物品总表，建立 id → en/zh 名称映射
//   ③ 合并，用名称填充每条订单的 item.en 字段
async function handleWmOrders(request, env) {
  if (!await getSessionEmail(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const [authResp, itemsResp] = await Promise.all([
      wmFetch(env, `/v2/orders/user/${WM_SLUG}`, {}),
      fetch(`${WM_API}/v2/items`, { headers: { 'Platform': 'pc', 'Language': 'en' } }),
    ]);

    const authJson  = authResp.ok  ? await authResp.json()  : { data: [] };
    const itemsJson = itemsResp.ok ? await itemsResp.json() : {};

    // v2/items 返回格式：{data: [{id, slug, i18n: {"zh-hans": {name}, "en": {name}}}]}
    const itemMap = {};
    const itemsList = itemsJson.data || [];
    itemsList.forEach(function (it) {
      if (!it.id) return;
      const zhName = it.i18n && it.i18n['zh-hans'] && it.i18n['zh-hans'].name;
      const enName = it.i18n && it.i18n['en']      && it.i18n['en'].name;
      itemMap[it.id] = { zh: zhName || enName || it.slug, en: enName || it.slug };
    });

    const merged = (authJson.data || []).map(function (o) {
      const names = itemMap[o.itemId];
      return names ? Object.assign({}, o, { item: names }) : o;
    });

    return jsonResponse({ data: merged });
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// POST /api/wm/orders —— 创建新挂单
async function handleWmOrderCreate(request, env) {
  if (!await getSessionEmail(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const body = await request.text();
    const resp = await wmFetch(env, '/v2/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// PATCH /api/wm/orders/:id —— 修改挂单（改价 / 切换可见性 / 改数量）
async function handleWmOrderPatch(request, env, orderId) {
  if (!await getSessionEmail(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const body = await request.text();
    const resp = await wmFetch(env, `/v2/orders/${orderId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

// DELETE /api/wm/orders/:id —— 删除挂单
async function handleWmOrderDelete(request, env, orderId) {
  if (!await getSessionEmail(request, env)) return jsonResponse({ error: '请先登录' }, 401);
  try {
    const resp = await wmFetch(env, `/v2/orders/${orderId}`, { method: 'DELETE' });
    if (resp.status === 204) return new Response(null, { status: 204 });
    return wmJsonProxy(resp, await resp.text());
  } catch (e) {
    return jsonResponse({ error: 'WM API 错误：' + e.message }, 502);
  }
}

/* ══════════════════════════════════════════════
   主路由
══════════════════════════════════════════════ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p   = url.pathname;

    // ── 我方鉴权 ──────────────────────────────
    if (p === '/api/auth/login'  && request.method === 'POST') return handleLogin(request, env);
    if (p === '/api/auth/logout' && request.method === 'POST') return handleLogout(request, env);
    if (p === '/api/auth/me'     && request.method === 'GET')  return handleMe(request, env);

    // ── WM 私有 API 代理 ──────────────────────
    if (p === '/api/wm/orders') {
      if (request.method === 'GET')  return handleWmOrders(request, env);
      if (request.method === 'POST') return handleWmOrderCreate(request, env);
    }
    const orderMatch = p.match(/^\/api\/wm\/orders\/([^/]+)$/);
    if (orderMatch) {
      if (request.method === 'PATCH')  return handleWmOrderPatch(request, env, orderMatch[1]);
      if (request.method === 'DELETE') return handleWmOrderDelete(request, env, orderMatch[1]);
    }

    // ── 调试：检查 WM 登录页返回的 Cookie（排查 CSRF，上线前删除） ──
    if (p === '/api/debug/wm-csrf' && request.method === 'GET') {
      if (!await getSessionEmail(request, env)) return jsonResponse({ error: '请先登录' }, 401);
      try {
        const r = await fetch('https://warframe.market/auth/signin', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const allHeaders = [];
        for (const [k, v] of r.headers.entries()) {
          allHeaders.push([k, v]);
        }
        const setCookieRaw = r.headers.get('set-cookie') || '';
        const html = await r.text();
        const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
                       || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
        // base64 编码 Set-Cookie 原始值，避免特殊字符问题
        const enc = [...setCookieRaw].map(c => c.charCodeAt(0));
        return jsonResponse({
          status: r.status,
          setCookieLen: setCookieRaw.length,
          setCookieChars: enc.slice(0, 200),
          csrfToken: metaMatch ? metaMatch[1].slice(0, 30) + '…' : null,
          allHeaderNames: allHeaders.map(([k]) => k),
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── 静态资源（index.html / css / js / picture） ──
    return env.ASSETS.fetch(request);
  },
};
