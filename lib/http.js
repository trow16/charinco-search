// Web標準 Request/Response 形式のハンドラ用ユーティリティ
import { describeError } from "./claude.js";

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const isMock = () => process.env.CHARINCO_MOCK === "1";

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ACCESS_CODE を設定すると、合言葉を知っている人だけがAPI（=料金のかかる処理）を使える
export function checkAccess(request) {
  const code = process.env.ACCESS_CODE;
  if (code && request.headers.get("x-access-code") !== code) {
    return json({ error: "合言葉が違います。" }, 401);
  }
  return null;
}

export function handle(fn) {
  return async (request) => {
    const denied = checkAccess(request);
    if (denied) return denied;
    try {
      return json(await fn(request));
    } catch (err) {
      const { status, message } = describeError(err);
      return json({ error: message }, status);
    }
  };
}
