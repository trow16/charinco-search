// APIキーなしで画面を確認するためのモックデータ（CHARINCO_MOCK=1）
import { SHIFT_KINDS, NDC } from "./claude.js";

export function mockShifts(query) {
  const home = 7;
  const shifts = NDC.map((name, ndc) => ({ ndc, name }))
    .filter((s) => s.ndc !== home)
    .map((s, i) => ({
      ndc: s.ndc,
      kind: SHIFT_KINDS[i % SHIFT_KINDS.length],
      query: `${s.name}から見た${query}`,
      note: `「${query}」と同じ形をした話が、${s.name}の棚にも置かれています。題材が違うぶん、見慣れた問いを外側から眺め直せると思って選びました。`,
    }));
  return { home, shifts };
}

export function mockSearch(queries) {
  return queries.map((q, qi) => ({
    query: q,
    results: Array.from({ length: 6 }, (_, i) => ({
      title: `${q}についての考察 その${i + 1} | サンプルサイト${qi}`,
      url: `https://example.com/${encodeURIComponent(q)}/${i}`,
      snippet: `${q}に関する記事の概要文です。ここに検索結果の説明が入ります。`,
      host: `site${qi}-${i}.example.com`,
      site: "",
      age: "",
      thumb: "",
    })),
  }));
}
