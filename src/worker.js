/* CSC·Alliance：Boss Tool —— Worker 入口
 * 职责：
 *   ① /api/auth/* —— 我方站点自己的白名单登录系统（与 WM 账号无关）。
 *      白名单邮箱 + 口令校验 → 单会话 cookie，新登录挤掉旧会话。
 *   ② 其余路径 → 落到 Workers Static Assets（index.html/css/js/picture），
 *      与之前纯静态部署行为完全一致，不影响已上线的 Phase 1 页面。
 *
 * 安全要点：
 *   - 口令只比对 SHA-256 摘要，仓库/Secret 里都不出现明文口令。
 *   - 会话 token 是随机生成的不透明字符串，存 KV，cookie 设
 *     HttpOnly + Secure + SameSite=Strict，前端 JS 拿不到也读不到。
 *   - 同一时间只允许一个会话存活：登录成功时记录"当前有效 token"，
 *     校验时若 cookie 里的 token 不等于 KV 记录的最新 token，视为已被
 *     新登录挤掉，直接判失效——不需要额外维护会话列表。
 *
 * 账号管理（2026-06-30 改版）：
 *   白名单与口令合并成单个 Secret BW_ACCOUNTS_JSON，格式为
 *   { "邮箱(全小写)": "该账号专属口令的SHA-256哈希", ... }。
 *   以后新增一个允许登录的账号，只需要在这一个 JSON 里加一条 key-value，
 *   不必再像旧版那样同时改两个独立的 Secret（白名单数组 + 共享口令哈希）。
 *   旧版 BW_WHITELIST_JSON / BW_PASSWORD_HASH 已废弃，可以从 Cloudflare
 *   Secret 配置里删除。
 */

const SESSION_COOKIE = 'bw_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

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

function sessionCookieHeader(token, maxAgeSeconds) {
  // maxAgeSeconds=0 用于登出时立即过期清除。
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAgeSeconds;
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: '请求格式错误' }, 400);
  }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  if (!email || !password) return jsonResponse({ error: '请输入邮箱和口令' }, 400);

  let accounts = {};
  try {
    accounts = JSON.parse(env.BW_ACCOUNTS_JSON || '{}');
  } catch (e) { /* 配置异常按空白名单处理，全部拒绝 */ }
  // key 统一按小写匹配，避免大小写导致"明明加了白名单却登不进去"。
  var expectedHash = null;
  Object.keys(accounts).forEach(function (k) {
    if (k.trim().toLowerCase() === email) expectedHash = accounts[k];
  });
  if (!expectedHash) {
    // 不区分"邮箱不在白名单"和"口令错误"，避免给攻击者枚举白名单的信息。
    return jsonResponse({ error: '账号或口令不正确' }, 401);
  }

  const hash = await sha256Hex(password);
  if (hash !== expectedHash) {
    return jsonResponse({ error: '账号或口令不正确' }, 401);
  }

  // 生成新 token，写入 KV 作为"当前唯一有效会话"——旧 token 自然失效
  // （校验时只认这一个最新值，不需要显式删除旧记录）。
  const token = randomToken();
  await env.BW_SESSIONS.put('current_session', JSON.stringify({ token, email, loginAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  const resp = jsonResponse({ ok: true, email: email });
  resp.headers.set('Set-Cookie', sessionCookieHeader(token, SESSION_TTL_SECONDS));
  return resp;
}

async function handleLogout(request, env) {
  // 直接清掉"当前唯一有效会话"记录即可，cookie 同步置空过期。
  await env.BW_SESSIONS.delete('current_session');
  const resp = jsonResponse({ ok: true });
  resp.headers.set('Set-Cookie', sessionCookieHeader('', 0));
  return resp;
}

async function getSessionEmail(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const raw = await env.BW_SESSIONS.get('current_session');
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  if (!rec || rec.token !== token) return null; // 被新登录挤掉或已过期
  return rec.email;
}

async function handleMe(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ authenticated: false }, 200);
  return jsonResponse({ authenticated: true, email: email }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env);
    }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      return handleMe(request, env);
    }

    // 其余一律落到静态资源（index.html/css/js/picture），
    // 与之前纯静态部署行为保持一致。
    return env.ASSETS.fetch(request);
  },
};
