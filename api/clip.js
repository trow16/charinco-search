// GET /api/clip?url=...  スクラップ用にページのHTMLを取得して返す（サニタイズはブラウザ側で行う）
import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "../lib/claude.js";
import { handle, isMock } from "../lib/http.js";
import { renderEnabled, renderPage, warmUp } from "../lib/render.js";

const MAX_BYTES = 3 * 1024 * 1024;

export function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIP(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

export async function assertPublicUrl(u) {
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "http(s) のURLのみ取得できます。");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new HttpError(400, "このURLは取得できません。");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(404, "サイトが見つかりませんでした。");
  if (addrs.some((a) => isPrivateIP(a.address))) throw new HttpError(400, "このURLは取得できません。");
}

function pickCharset(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (fromHeader) return fromHeader;
  const ascii = new TextDecoder("latin1").decode(head);
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii)?.[1] || "utf-8";
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

// 同じページはしばらく覚えておく（展示で何度も開くため）
const CACHE_MAX = 40;
const CACHE_MS = 15 * 60 * 1000;
const caches = { static: new Map(), render: new Map() };

async function cached(kind, raw, load) {
  const cache = caches[kind];
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  // 同時に来た同じ要求は1回の取得にまとめる
  const page = load(raw);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(raw, { at: Date.now(), page });
  page.catch(() => cache.get(raw)?.page === page && cache.delete(raw));
  return page;
}

// 本物の Chrome で描画して写し取る（スクリプトで組み立てるサイトや CSS-in-JS も元の見た目に近づく）
async function renderClip(raw) {
  if (!renderEnabled()) throw new HttpError(501, "再現表示は使えません（Chrome が見つかりません）。");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "URLが不正です。");
  }
  await assertPublicUrl(u);
  try {
    return { ...(await renderPage(u.href, { assertPublicUrl, isPrivateIP })), rendered: true };
  } catch (err) {
    console.warn(`[clip] 再現表示に失敗: ${u.href} (${err.message})`);
    throw new HttpError(502, "このページは再現表示できませんでした。");
  }
}

if (!isMock()) warmUp();

async function fetchPage(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "URLが不正です。");
  }
  // リダイレクト先も毎回検証する
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(u);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        // ボット向けの簡素なページや拒否を避けるため、一般的なブラウザに近い名乗りにする
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 CharincoSearch/0.1",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.8",
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location"), u);
      continue;
    }
    if (!res.ok) throw new HttpError(502, `ページを取得できませんでした (${res.status})`);
    const type = res.headers.get("content-type") || "";
    if (!/html|xml/i.test(type)) throw new HttpError(415, "HTMLページではないためスクラップできません。");
    const buf = await readLimited(res);
    let html;
    try {
      html = new TextDecoder(pickCharset(type, buf.subarray(0, 4096))).decode(buf);
    } catch {
      html = new TextDecoder("utf-8").decode(buf);
    }
    return { url: u.href, html };
  }
  throw new HttpError(502, "リダイレクトが多すぎます。");
}

export const GET = handle(async (request) => {
  const target = new URL(request.url).searchParams.get("url") || "";
  if (isMock()) {
    return {
      rendered: new URL(request.url).searchParams.get("mode") === "render" || undefined,
      url: target,
      html: `<html><head><title>モックページ</title></head><body><article><h1>モックの記事</h1>
<p>これはスクラップボードの動作確認用の段落です。<strong>強調</strong>や<a href="/x">リンク</a>も含みます。</p>
<blockquote>引用ブロックの例。</blockquote><ul><li>リスト1</li><li>リスト2</li></ul>
<figure><img src="https://picsum.photos/seed/charinco/400/240" alt="sample"><figcaption>図のキャプション</figcaption></figure>
<h2>見出し2</h2><p>二つ目の段落です。</p></article><script>alert(1)</script></body></html>`,
    };
  }
  if (new URL(request.url).searchParams.get("mode") === "render") return cached("render", target, renderClip);
  return cached("static", target, fetchPage);
});
