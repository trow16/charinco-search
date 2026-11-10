// Brave Search API（一般Web検索）
import { HttpError } from "./claude.js";
import { isClippable } from "./filter.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const stripTags = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同じ検索語の結果はしばらく覚えておく
const cache = new Map();
const CACHE_MAX = 500;

async function searchOnce(q, count) {
  const hit = cache.get(`${count}:${q}`);
  if (hit) return hit;
  const results = await fetchResults(q, count);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(`${count}:${q}`, results);
  return results;
}

async function fetchResults(q, count) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new HttpError(500, "BRAVE_API_KEY が設定されていません。");
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", q);
  // 動画・商品ページなどを除いても数が足りるよう、多めに取ってから絞る（1回の検索の料金は同じ）
  url.searchParams.set("count", "20");
  url.searchParams.set("country", "JP");
  url.searchParams.set("search_lang", "jp");
  url.searchParams.set("ui_lang", "ja-JP");
  url.searchParams.set("safesearch", "moderate");

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      // 秒あたりの上限に当たったら少し待って再試行
      await sleep(400 * (attempt + 1) + Math.random() * 300);
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new HttpError(500, "BRAVE_API_KEY が無効です。");
    if (!res.ok) throw new HttpError(502, `Brave Search エラー (${res.status})`);
    const data = await res.json();
    return (data.web?.results || []).filter(isClippable).slice(0, count).map((r) => ({
      title: stripTags(r.title),
      url: r.url,
      snippet: stripTags(r.description),
      host: r.meta_url?.hostname || new URL(r.url).hostname,
      site: r.profile?.name || "",
      age: r.age || "",
      thumb: r.thumbnail?.src || "",
    }));
  }
  throw new HttpError(429, "検索が混み合っています。少し待ってから試してください。");
}

/**
 * 複数の検索語をまとめて検索する。BRAVE_GAP_MS を設定すると、その間隔ずつずらして投げる。
 * @param {string[]} queries
 * @returns {Promise<{query:string, results:any[], error?:string}[]>}
 */
export async function searchMany(queries, count = 8) {
  const gap = Number(process.env.BRAVE_GAP_MS || 0);
  return Promise.all(
    queries.map(async (q, i) => {
      await sleep(i * gap);
      try {
        return { query: q, results: await searchOnce(q, count) };
      } catch (err) {
        if (err instanceof HttpError && err.status === 500) throw err; // キー設定ミスは全体エラー
        return { query: q, results: [], error: err.message };
      }
    })
  );
}
