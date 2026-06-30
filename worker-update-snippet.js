/* war-frame.com Cloudflare Worker —— 更新版
 * 改动说明：原先 "war-frame.com"/"www.war-frame.com" 走 redirectMap 302 跳转到
 * https://wfspeed.run；现在改为反代直出 BossTool 的 Cloudflare Pages 部署产物，
 * 让用户访问 war-frame.com 时看到的就是 BossTool 页面本身（不再跳转/不再换地址栏），
 * 其余所有跳转条目原样保留，逻辑不受影响。
 *
 * 使用前：把下面 BOSSTOOL_ORIGIN 换成你 Cloudflare Pages 项目实际分配到的
 * *.pages.dev 地址（或你后续换的自定义源站地址）。
 */
const BOSSTOOL_ORIGIN = 'https://REPLACE-ME.pages.dev'; // ← 改成 Private-WM 的 Pages 部署地址

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase(); // 统一转小写，解决大小写匹配问题

    // --- 你的专属跳转清单 ---
    const redirectMap = {
      // 主域名与氏族
      "qiankun.war-frame.com": "https://qcnye09jdqm2.feishu.cn/docx/0C1ddc4kOoVJCOx4520C3r3znEf",
      "clan.war-frame.com":    "https://qcnye09jdqm2.feishu.cn/docx/0C1ddc4kOoVJCOx4520C3r3znEf",

      // 攻略/交易/计算器/文档（合并跳转）
      "www.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",
      "trade.war-frame.com":"https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",
      "roc.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",
      "doc.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XznXdm7N8oHeHLxMJgQcOXQJnuh",

      // 独立模块
      "rule.war-frame.com":  "https://qcnye09jdqm2.feishu.cn/docx/XIJNdmlLAobtRhxRYy7cvRbOnBb",
      "csc.war-frame.com":   "https://qcnye09jdqm2.feishu.cn/docx/LC0xdSJsCo5Oqhxkwoqc8FoAnUb",
      "lh.war-frame.com":    "https://space.bilibili.com/36873261",
      "dojo.war-frame.com":  "https://space.bilibili.com/91933543",
      "fy.war-frame.com":    "https://browse.wf/glyphs",
      "kappa.war-frame.com": "https://wfspeed.run/disruption-multi.html",
      "name.war-frame.com":  "https://wfspeed.run/item.html",
      "wj.war-frame.com":    "https://wj.qq.com/s2/23001714/c276/",
    };

    // ── war-frame.com / www.war-frame.com 单独移出 redirectMap：改为反代直出 ──
    // 注：www.war-frame.com 原本在 redirectMap 里跳去合并文档站，现按你这次的
    // 要求，只有它和裸域 war-frame.com 这两个改接 BossTool，其它子域名维持原样。
    if (hostname === "war-frame.com" || hostname === "www.war-frame.com") {
      const upstreamUrl = BOSSTOOL_ORIGIN + url.pathname + url.search;
      const upstreamReq = new Request(upstreamUrl, request);
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
