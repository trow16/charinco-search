// Claude API wrapper: 平行サジェスチョン（NDCの書架ごとにずらす）
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { HttpError } from "./errors.js";
import { remember } from "./cache.js";

const MODEL = "claude-opus-5-5";
let client;
const getClient = () => (client ??= new Anthropic());

// JSON Schema で出力形式を固定して1回呼び出す
async function callJSON({ system, user, schema }) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // 展示での待ち時間を短くするため effort は low
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema },
    },
    // 安全分類器に誤って弾かれた場合はサーバー側で別モデルに回す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "AIがこの話題の提案を辞退しました。別の言葉で試してください。");
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "AIの応答を解釈できませんでした。");
  }
}

export function describeError(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof APIConnectionError)
    return { status: 502, message: "Claude API に接続できませんでした。" };
  if (err instanceof AuthenticationError)
    return { status: 500, message: "ANTHROPIC_API_KEY が無効です。" };
  if (err instanceof RateLimitError)
    return { status: 429, message: "AIが混み合っています。少し待ってから試してください。" };
  if (err instanceof APIError)
    return { status: 502, message: `Claude API エラー (${err.status ?? "?"})` };
  if (/Could not resolve authentication/i.test(err?.message || ""))
    return { status: 500, message: "ANTHROPIC_API_KEY が設定されていません。" };
  console.error(err);
  return { status: 500, message: err?.message || "不明なエラー" };
}

/* ---------- 平行サジェスチョン（書架ごとに1つ） ---------- */

export const SHIFT_KINDS = [
  "同じ構造",
  "別の時代",
  "別の場所",
  "別の分野",
  "反例・対立",
  "スケール違い",
];

// 日本十進分類法（NDC）の第1次区分
export const NDC = [
  "総記",
  "哲学",
  "歴史",
  "社会科学",
  "自然科学",
  "技術",
  "産業",
  "芸術",
  "言語",
  "文学",
];

const PARALLEL_SYSTEM = `あなたは「Charinco Search」という、創作のための検索エンジンの司書です。
利用者は企画や制作のために「資料の収集」をしています（ジェームス・W・ヤング『アイデアのつくり方』でいう一般資料）。
この図書館は日本十進分類法（NDC）の10の書架でできています。
0 総記（情報科学・百科事典・ジャーナリズム・図書館）/ 1 哲学（思想・心理学・宗教）/ 2 歴史（歴史・伝記・地理・紀行）/
3 社会科学（政治・法律・経済・社会・教育・民俗）/ 4 自然科学（数学・物理・化学・生物・医学）/ 5 技術（工学・建築・IT・家政・料理）/
6 産業（農業・商業・運輸・通信・ビジネス）/ 7 芸術（美術・デザイン・音楽・演劇・スポーツ・娯楽）/ 8 言語 / 9 文学（小説・詩・エッセイ・評論）

あなたの仕事：
1. home：利用者の関心ごとがもともと置かれる書架の番号を1つ選ぶ。
2. shifts：home 以外の9つの書架それぞれへ、関心ごとを「平行にずらした」検索語を1つずつ作る（9個、書架の重複なし）。
   その検索語で見つかる記事が、本当にその書架に置かれる内容であること。

平行にずらすとは：
- 関連はあるが、元の論を直接補強しない情報へ、程よい距離だけジャンプすること。
- 同義語・言い換え・上位概念/下位概念・定義を調べる語は禁止（それは最短経路の検索です）。
- デタラメなランダム連想も禁止。ずらした理由を一文で説明できること。
- 目指すのは、人間が十分に理解できる範囲で新しさを感じる「良い誤読」の種。常識を超えた突飛な飛躍は要らない。

ずらし方の種類（kind）。9個の中で6種類すべてを少なくとも1回ずつ使う：
- 同じ構造：仕組みや関係の形が同じだが、題材が全く違う事象
- 別の時代：過去（または想像される未来）における類似の出来事や営み
- 別の場所：異なる地域・文化圏での類似の事象
- 別の分野：異なる学問・業界・ジャンルで起きている同型の問題
- 反例・対立：その前提を覆す事例、反対の立場の意見
- スケール違い：ミクロ/マクロ、個人/社会など規模を大きく変えたときの対応物

検索語はWeb検索エンジンにそのまま入れて良い記事が見つかる具体的な語（2〜5語程度、日本語中心）にしてください。
note は「司書のコメント」として、この書架にこの本たちを選んだ理由を書いてください。
- 利用者の関心ごととどこが同じ形をしていて、どこがずれているのか、そのずれが発想の種になりうるのはなぜかを伝える。
- 図書館の司書がカウンター越しに一言添えるような、穏やかで具体的な話し言葉（です・ます調）で、60〜90字。
- 「〜はいかがでしょう」のような売り込みや、検索語の言い換えだけの説明はしない。`;

const PARALLEL_SCHEMA = {
  type: "object",
  properties: {
    home: { type: "integer", enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    shifts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ndc: { type: "integer", enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
          kind: { type: "string", enum: SHIFT_KINDS },
          query: { type: "string" },
          note: { type: "string" },
        },
        required: ["ndc", "kind", "query", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["home", "shifts"],
  additionalProperties: false,
};

// 同じ問い合わせはしばらく覚えておく（展示で同じ例を何度も試すため）
const cache = new Map();
const CACHE_MAX = 200;

/**
 * @param {string} query 元の検索語
 * @param {{title?: string, snippet?: string}|null} seed 「この本から平行にずらす」場合の起点
 * @param {string[]} trail これまでの寄り道（重複回避用）
 * @returns {Promise<{home:number, shifts:{ndc:number, kind:string, query:string, note:string}[]}>}
 */
export async function parallelShifts(query, seed, trail = []) {
  let user = `利用者の検索語：「${query}」`;
  if (seed?.title) {
    user = `利用者は「${query}」を調べる途中で、次の資料を手に取りました。この資料を起点にずらしてください。
タイトル：${seed.title}
概要：${seed.snippet || "（なし）"}`;
  }
  if (trail.length) {
    user += `\n\nこれまでに辿った寄り道（これらと重複しないこと）：${trail.join(" → ")}`;
  }
  if (cache.has(user)) return cache.get(user);

  const out = await callJSON({ system: PARALLEL_SYSTEM, user, schema: PARALLEL_SCHEMA });
  const home = Number.isInteger(out.home) ? out.home : 0;
  // 書架ごとに1つ、番号順に並べる
  const byNdc = new Map();
  for (const s of out.shifts || []) {
    if (s.ndc !== home && !byNdc.has(s.ndc) && s.query?.trim()) byNdc.set(s.ndc, s);
  }
  const result = { home, shifts: [...byNdc.keys()].sort((a, b) => a - b).map((k) => byNdc.get(k)) };
  return remember(cache, user, result, CACHE_MAX);
}
