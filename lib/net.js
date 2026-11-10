// 外のサイトへ取りに行くときの安全確認と取得。
// 検索結果のURLは誰でも作れるので、手元のネットワーク（localhost・社内のアドレス等）へは行かせない
import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "./errors.js";

// ボット向けの簡素なページや拒否を避けるため、一般的なブラウザに近い名乗りにする
export const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 CharincoSearch/0.1";

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

// 名前を引かずに分かる範囲で、手元のネットワークのホストか
const isPrivateHost = (hostname) => {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || (net.isIP(h) && isPrivateIP(h));
};

/** 文字列の URL を読む。読めなければ 400 */
export function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    throw new HttpError(400, "URLが不正です。");
  }
}

/** 外の http(s) のサイトでなければ例外（名前を引いて、行き先のアドレスまで確かめる） */
export async function assertPublicUrl(u) {
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "http(s) のURLのみ取得できます。");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new HttpError(400, "このURLは取得できません。");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(404, "サイトが見つかりませんでした。");
  if (addrs.some((a) => isPrivateIP(a.address))) throw new HttpError(400, "このURLは取得できません。");
}

/** 裏の Chrome のページ移動を通してよいか（Fetch.requestPaused で使う） */
export async function isAllowedNavigation(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return false;
    await assertPublicUrl(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * リダイレクトを自分でたどりながら取得する（行き先を毎回確かめる）。
 * @returns {Promise<{res: Response, url: URL}>}
 */
export async function fetchPublic(u, { timeout = 10000, headers = {} } = {}) {
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(u);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": FETCH_UA, ...headers },
    });
    const location = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!location) return { res, url: u };
    u = new URL(location, u);
  }
  throw new HttpError(502, "リダイレクトが多すぎます。");
}
