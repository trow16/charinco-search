// POST /api/parallel  { query, seed?: {title, snippet}, trail?: string[] } -> { home, shifts }
import { parallelShifts } from "../lib/claude.js";
import { HttpError } from "../lib/errors.js";
import { handle, readBody, isMock } from "../lib/http.js";
import { mockShifts } from "../lib/mock.js";

export const POST = handle(async (request) => {
  const { query, seed, trail } = await readBody(request);
  const q = String(query || "").trim().slice(0, 200);
  if (!q) throw new HttpError(400, "検索語が空です。");
  const t = Array.isArray(trail) ? trail.map(String).slice(-12) : [];
  return isMock() ? mockShifts(q) : await parallelShifts(q, seed, t);
});
