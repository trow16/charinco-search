// /api/live  切り抜き画面で、裏の本物の Chrome のタブを操作する
//   GET  ?status=1           … ライブ表示が使えるか
//   GET  ?id=...&code=...    … 画面を流す（Server-Sent Events。EventSource はヘッダーを付けられないので合言葉はクエリで）
//   POST { action: "open", url, w, h, dpr } → { id }
//   POST { action: ..., id, ... }            … 入力の中継・切り抜き（lib/live.js）
import { handle, isMock, json } from "../lib/http.js";
import { HttpError } from "../lib/claude.js";
import { liveEnabled, open, stream, act } from "../lib/live.js";
import { assertPublicUrl, isPrivateIP } from "./clip.js";

export const GET = async (request) => {
  const q = new URL(request.url).searchParams;
  if (q.has("status")) return json({ enabled: !isMock() && liveEnabled() });
  const code = process.env.ACCESS_CODE;
  if (code && q.get("code") !== code) return json({ error: "合言葉が違います。" }, 401);
  try {
    return stream(q.get("id") || "");
  } catch (err) {
    return json({ error: err.message }, err.status || 500);
  }
};

export const POST = handle(async (request) => {
  if (isMock() || !liveEnabled()) throw new HttpError(503, "ライブ表示は使えません。");
  const body = await request.json().catch(() => ({}));
  if (body.action === "open") {
    if (typeof body.url !== "string") throw new HttpError(400, "url がありません。");
    return open(body, { assertPublicUrl, isPrivateIP });
  }
  return act(body);
});
