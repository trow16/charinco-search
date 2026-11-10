// GET /api/asset?url=...  切り抜き画面で使う、元サイトの CSS とフォントの中継
// 切り抜き画面はページを localhost 側で表示するため、他サイトのWebフォント（アイコンフォント含む）は
// そのままだと読み込みを拒否され、アイコンが□になったり書体が変わってレイアウトが崩れたりする。
// CSS とフォントだけをここで中継し、それ以外は元のURLへそのまま転送する。
import { assertPublicUrl } from "./clip.js";

const FONT = /\.(woff2?|ttf|otf|eot)([?#]|$)/i;
const MAX_BYTES = 5 * 1024 * 1024;
const cache = new Map();
const CACHE_MAX = 300;

const proxied = (abs) => `/api/asset?url=${encodeURIComponent(abs)}`;
const resolve = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

// CSS 内の url()：フォントと @import する CSS は中継、画像などは絶対URLに直す
export function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, href) => {
      if (/^(data|blob):/i.test(href) || href.startsWith("#")) return m;
      const abs = resolve(href.trim(), base);
      if (!abs || !/^https?:/i.test(abs)) return m;
      return `url("${FONT.test(abs) || /\.css([?#]|$)/i.test(abs) ? proxied(abs) : abs}")`;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, _q, href) => {
      const abs = resolve(href, base);
      return abs ? `@import url("${proxied(abs)}")` : m;
    });
}

// 日本のサイトには Shift_JIS や EUC-JP で書かれた CSS がある（content: "詳細はこちら" 等が文字化けする）。
// 応答ヘッダー → 先頭の @charset → UTF-8 として正しいか、の順で文字コードを決める
function decodeCss(buf, type) {
  const tryDecode = (enc, fatal) => {
    try {
      return new TextDecoder(enc, { fatal }).decode(buf);
    } catch {
      return null;
    }
  };
  const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1] || /^\s*@charset\s+["']([\w-]+)["']/i.exec(buf.subarray(0, 100).toString("latin1"))?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    const text = tryDecode(declared, false);
    if (text != null) return text.replace(/^\s*@charset\s+["'][\w-]+["']\s*;?/i, "");
  }
  return tryDecode("utf-8", true) ?? tryDecode("shift_jis", true) ?? tryDecode("euc-jp", true) ?? tryDecode("utf-8", false);
}

const respond = ({ type, body }) =>
  new Response(body, {
    headers: { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });

export const GET = async (request) => {
  let u;
  try {
    u = new URL(new URL(request.url).searchParams.get("url") || "");
    if (!/^https?:$/.test(u.protocol)) throw 0;
  } catch {
    return new Response("bad url", { status: 400 });
  }
  const original = u.href;
  // うまく中継できないときは、ブラウザに元のURLを直接読みに行かせる
  const passThrough = () => new Response(null, { status: 302, headers: { Location: original } });

  const hit = cache.get(original);
  if (hit) return respond(hit);
  try {
    let res;
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicUrl(u);
      res = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 CharincoSearch/0.1",
          Accept: "text/css,*/*;q=0.1",
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        u = new URL(res.headers.get("location"), u);
        continue;
      }
      break;
    }
    if (!res?.ok) return passThrough();
    if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) return passThrough();
    const type = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return passThrough();

    let out;
    if (/text\/css/i.test(type) || (/\.css([?#]|$)/i.test(u.pathname) && !/html/i.test(type))) {
      out = { type: "text/css; charset=utf-8", body: Buffer.from(rewriteCss(decodeCss(buf, type), u.href)) };
    } else if (/font|woff|opentype|truetype|octet-stream/i.test(type) || FONT.test(u.pathname)) {
      out = { type: type || "font/woff2", body: buf };
    } else {
      return passThrough();
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(original, out);
    return respond(out);
  } catch {
    return passThrough();
  }
};
