/* war-frame.com Cloudflare Worker —— 更新版
 * 改动说明：原先 "war-frame.com"/"www.war-frame.com" 走 redirectMap 302 跳转到
 * https://wfspeed.run；现在改为反代直出 BossTool 的 Cloudflare Pages 部署产物，
 * 让用户访问 war-frame.com 时看到的就是 BossTool 页面本身（不再跳转/不再换地址栏），
 * 其余所有跳转条目原样保留，逻辑不受影响。
 *
 * 使用前：把下面 BOSSTOOL_ORIGIN 换成你 Cloudflare Pages 项目实际分配到的
 * *.pages.dev 地址（或你后续换的自定义源站地址）。
 */
const BOSSTOOL_ORIGIN = 'https://privatewm.xiang-kun.workers.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase(); // 统一转小写，解决大小写匹配问题

    // --- 你的专属跳转清单 ---
    const redirectMap = {
      // 主域名与氏族
      "qiankun.war-frame.com": "https://qcnye09jdqm2.feishu.cn/docx/OC1ddc4kOoVJCOx452Oc3r3znEf",
      "clan.war-frame.com":    "https://qcnye09jdqm2.feishu.cn/docx/OC1ddc4kOoVJCOx452Oc3r3znEf",

      // 攻略/交易/计算器/文档（合并跳转）
      "trade.war-frame.com":"https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",
      "roc.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",
      "doc.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",

      // 独立模块
      "rule.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XIJNdmlLAobtRhxRYy7cvRbOnBb",
      "csc.war-frame.com":   "https://qcnye09jdqm2.feishu.cn/docx/LC0xdSJsCo50qhxkwoqc8FoAnUb",
      "lh.war-frame.com":    "https://space.bilibili.com/36873261",
      "dojo.war-frame.com":  "https://space.bilibili.com/91933543",
      "fy.war-frame.com":    "https://browse.wf/glyphs",
      "kappa.war-frame.com": "https://wfspeed.run/disruption-multi.html",
      "name.war-frame.com":  "https://wfspeed.run/item.html",
      "wj.war-frame.com":    "https://wj.qq.com/s2/23001714/c276/",
    };

    // ── war-frame.com / www.war-frame.com 单独移出 redirectMap：改为反代直出 ──
    if (hostname === "war-frame.com" || hostname === "www.war-frame.com") {
      const upstreamUrl = BOSSTOOL_ORIGIN + url.pathname + url.search;
      // 必须重建 Headers 并删掉原始 Host，否则 Cloudflare 看到
      // Host: war-frame.com 与目标 workers.dev 不匹配，直接报 1101。
      const headers = new Headers(request.headers);
      headers.delete('host');
      const upstreamReq = new Request(upstreamUrl, {
        method:  request.method,
        headers,
        body:    (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
        redirect: 'follow',
      });
      return fetch(upstreamReq);
    }

    // 逻辑：命中清单则跳，否则默认跳主站
    if (redirectMap[hostname]) {
      return Response.redirect(redirectMap[hostname], 302);
    } else {
      return Response.redirect("https://war-frame.com", 302);
    }
  },
};
