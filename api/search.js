// POST /api/search  { queries: string[] }
import { searchMany } from "../lib/brave.js";
import { HttpError } from "../lib/claude.js";
import { handle, readBody, isMock } from "../lib/http.js";
import { mockSearch } from "../lib/mock.js";

export const POST = handle(async (request) => {
  const { queries } = await readBody(request);
  const qs = (Array.isArray(queries) ? queries : [])
    .map((q) => String(q).trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10);
  if (!qs.length) throw new HttpError(400, "検索語が空です。");
  return { groups: isMock() ? mockSearch(qs) : await searchMany(qs) };
});
