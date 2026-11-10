// Charinco Search — フロントエンド
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

const NDC = ["総記", "哲学", "歴史", "社会科学", "自然科学", "技術", "産業", "芸術", "言語", "文学"];
const KINDS = {
  "同じ構造": "--k-structure",
  "別の時代": "--k-era",
  "別の場所": "--k-place",
  "別の分野": "--k-field",
  "反例・対立": "--k-counter",
  "スケール違い": "--k-scale",
};
const kindColor = (kind) => (kind && KINDS[kind] ? `var(${KINDS[kind]})` : "transparent");
// 背表紙のクロス色
const CLOTH = [
  ["#2f3a45", "#e8e4dc"], ["#3f4a44", "#ece6da"], ["#6b3a3e", "#f1e8e0"], ["#c2ab7e", "#1e1a14"],
  ["#4a4038", "#ebe3d6"], ["#5a625e", "#f6f3ec"], ["#e4ddd0", "#33302b"], ["#3b3646", "#ebe5dc"],
  ["#74644f", "#fbf7f0"], ["#1f2b2e", "#dcd6c8"], ["#8a4e3c", "#fdf6f0"], ["#c9c1b0", "#2a2721"],
];
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
// http(s) の URL なら絶対 URL にして返す。それ以外（javascript: や壊れた URL）は null
const httpUrl = (href, base) => {
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
const safeUrl = (u) => httpUrl(u) ?? "#";
// 文字の入力中か（そのときは 1文字のショートカットキーを効かせない）
const isTyping = (e) => !!(e.target.isContentEditable || e.target.closest?.("input,textarea,select"));
// localStorage は使えないこと（プライベートウィンドウ・容量切れ）もあるので、失敗しても止まらないようにする
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  getJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  /** 保存できなければそのエラーを返す */
  set(key, value) {
    try {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      return null;
    } catch (err) {
      return err;
    }
  },
};
// 件数に上限のある覚え書き。なければ make() で作って入れる（上限を超えたら、いちばん古く入れたものから捨てる）
function remember(map, key, make, max) {
  if (!map.has(key)) {
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, make());
  }
  return map.get(key);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

// 公開環境で ACCESS_CODE が設定されている場合の合言葉
const CODE_KEY = "charinco.code";
const getCode = () => store.get(CODE_KEY) || "";

async function api(path, body, retried = false) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), "X-Access-Code": getCode() },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`サーバーエラー (${res.status})`);
  }
  if (res.status === 401 && !retried) {
    const code = prompt("合言葉を入力してください");
    if (code) {
      store.set(CODE_KEY, code.trim());
      return api(path, body, true);
    }
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `エラー (${res.status})`), { status: res.status });
  return data;
}

/* =========================================================
   状態
   ========================================================= */
const state = {
  trail: [], // { query, kind, from, data? }
  current: -1,
  books: [],
  shifts: [],
  read: new Set(),
  busy: false,
};

/* =========================================================
   検索パイプライン：平行にずらす → 書架ごとに本を集める
   ========================================================= */
// 図書館タブの中身を切り替える："welcome"（最初の画面）/ "loading" / "library"（検索結果）/ "error"
function showScreen(name) {
  $("#welcome").hidden = name !== "welcome";
  $("#loading").hidden = name !== "loading";
  $("#error").hidden = name !== "error";
  $("#hallWrap").hidden = $("#shifts").hidden = name !== "library";
}
function setStep(step) {
  const order = ["shift", "search"];
  const idx = order.indexOf(step);
  $$(".steps li").forEach((li, i) => {
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", i < idx);
  });
}

// 背表紙用の短い題：サイト名などの区切り以降を落とす
function spineTitle(title) {
  const parts = title.split(/\s*[|｜]\s*|\s+[-–—]\s+|\s*[：:]\s+/).filter(Boolean);
  const head = parts[0] && [...parts[0]].length >= 4 ? parts[0] : title;
  return [...head.replace(/^【[^】]*】\s*/, "")].slice(0, 18).join("") || title.slice(0, 18);
}

async function explore({ query, kind = null, from = null, seed = null, reset = false }) {
  if (state.busy) return;
  query = query.trim();
  if (!query) return;
  state.busy = true;
  // ヘッダーから検索したときは、切り抜き画面や本の説明を閉じて結果を見せる
  if (!$("#reader").hidden) hideReader();
  $("#drawer").hidden = true;
  showView("library");
  window.scrollTo(0, 0);

  if (reset) state.trail = [];
  else state.trail = state.trail.slice(0, state.current + 1);
  state.trail.push({ query, kind, from });
  state.current = state.trail.length - 1;
  renderTrail();
  $("#q").value = query;

  showScreen("loading");
  setStep("shift");

  const fail = (err) => {
    $("#error").textContent = err.message;
    showScreen("error");
    state.trail.pop();
    state.current = state.trail.length - 1;
    renderTrail();
    if (!state.trail.length) $("#welcome").hidden = false;
  };

  try {
    const trailQueries = state.trail.map((t) => t.query);
    // 元の語の検索は、平行ずらしを待たずに始めておく
    const directP = api("/api/search", { queries: [query] });
    directP.catch(() => {});
    const { home, shifts } = await api("/api/parallel", { query, seed, trail: trailQueries.slice(0, -1) });

    // 書架を先に並べ、検索結果が届いた棚から本を埋めていく
    const books = [];
    const seen = new Set();
    state.home = home;
    state.shifts = shifts;
    state.books = books;
    state.filter = null;
    state.pending = new Set([home, ...shifts.map((s) => s.ndc)]);
    renderLibrary();

    const fill = (ndc, results, origin, shiftIndex, limit) => {
      for (const r of results.slice(0, limit)) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        books.push({ ...r, id: books.length, ndc, origin, shiftIndex, spine: spineTitle(r.title) });
      }
      state.pending.delete(ndc);
      updateShelf(ndc);
      renderShiftList();
    };
    const tasks = [
      directP.then(
        (d) => fill(home, d.groups[0]?.results || [], null, -1, 8),
        () => fill(home, [], null, -1, 0)
      ),
      ...shifts.map((s, i) =>
        api("/api/search", { queries: [s.query] }).then(
          (d) => fill(s.ndc, d.groups[0]?.results || [], s, i, 6),
          () => fill(s.ndc, [], s, i, 0)
        )
      ),
    ];
    await Promise.all(tasks);
    if (!books.length) throw new Error("本が一冊も見つかりませんでした。別の言葉で試してください。");
    state.trail[state.current].data = { home, shifts, books };
    snapshotTrail();
    pushNav();
  } catch (err) {
    fail(err);
  } finally {
    $("#loading").hidden = true;
    state.busy = false;
  }
}

/* =========================================================
   寄り道の記録
   ========================================================= */
function renderTrail() {
  const ol = $("#trail");
  ol.replaceChildren(
    ...state.trail.map((t, i) =>
      el(
        "li",
        {},
        t.kind ? el("span", { class: "via", style: `background:${kindColor(t.kind)}`, title: t.from ? `「${t.from}」から` : null }, t.kind) : null,
        el(
          "button",
          {
            "aria-current": i === state.current ? "true" : null,
            onclick: () => {
              if (!t.data || state.busy) return;
              goStep(i);
              showView("library");
              pushNav();
            },
          },
          t.query
        )
      )
    )
  );
}

// 寄り道の記録のうち i 番目の検索結果に戻る（-1 は最初の画面）
function goStep(i) {
  if (i < 0) {
    state.current = -1;
    $("#q").value = "";
    showScreen("welcome");
    renderTrail();
    return true;
  }
  const t = state.trail[i];
  if (!t?.data) return false;
  state.current = i;
  state.books = t.data.books;
  state.shifts = t.data.shifts;
  state.home = t.data.home;
  state.filter = null;
  state.pending = new Set();
  $("#q").value = t.query;
  renderTrail();
  renderLibrary();
  return true;
}

/* =========================================================
   ブラウザの「戻る／進む」
   画面の状態（表示中のタブ・検索結果・本の説明・切り抜き画面）を履歴に積む
   ========================================================= */
let applyingNav = false;
// 新しく検索し直すと寄り道の記録が作り直されるので、その時点の記録を番号つきで取っておく
let trailRid = 0;
const trailSnapshots = new Map([[0, []]]);
function snapshotTrail() {
  trailRid = trailSnapshots.size;
  trailSnapshots.set(trailRid, state.trail.slice());
}
function navState() {
  return {
    charinco: 1,
    rid: trailRid,
    view: $("#view-board").hidden ? "library" : "board",
    step: state.current,
    book: $("#drawer").hidden ? null : openedBook,
    reader: $("#reader").hidden ? null : activePage()?.b || null,
  };
}
function pushNav() {
  if (!applyingNav) history.pushState(navState(), "");
}
function replaceNav() {
  if (!applyingNav) history.replaceState(navState(), "");
}
addEventListener("popstate", (e) => {
  const s = e.state;
  if (!s?.charinco) return;
  applyingNav = true;
  try {
    if (!state.busy) {
      if (s.rid !== trailRid && trailSnapshots.has(s.rid)) {
        state.trail = trailSnapshots.get(s.rid).slice();
        trailRid = s.rid;
        goStep(s.step);
      } else if (s.step !== state.current) goStep(s.step);
    }
    showView(s.view, { keepScroll: true });
    if (s.book) {
      if ($("#drawer").hidden || openedBook?.url !== s.book.url) openBook(s.book);
    } else $("#drawer").hidden = true;
    if (s.reader) {
      if ($("#reader").hidden || activePage()?.b.url !== s.reader.url) openReader(s.reader);
    } else hideReader();
  } finally {
    applyingNav = false;
  }
});
// 本の説明・切り抜き画面を閉じる：その画面を開いたときの履歴があれば「戻る」で閉じる
function closeDrawer() {
  if ($("#drawer").hidden) return;
  if (history.state?.book && !history.state?.reader) history.back();
  else $("#drawer").hidden = true;
}
function closeReader() {
  if ($("#reader").hidden) return;
  if (history.state?.reader) history.back();
  else hideReader();
}

/* =========================================================
   仮想図書館ビュー
   ========================================================= */
const collator = new Intl.Collator("ja");

function renderLibrary() {
  showScreen("library");

  // 凡例（今回使われたずらし方だけ）
  const kinds = [...new Set(state.shifts.map((s) => s.kind))];
  $("#legend").replaceChildren(
    el("span", {}, el("i", { class: "direct" }), `「${state.trail[state.current]?.query}」そのもの（${state.home} ${NDC[state.home]}）`),
    ...kinds.map((k) => el("span", {}, el("i", { style: `background:${kindColor(k)}` }), k))
  );

  hall.classList.remove("filtering");
  hall.replaceChildren(...NDC.map((_, ndc) => shelfCase(ndc)));
  hall.scrollLeft = 0;
  $("#shelfNav").replaceChildren(
    ...NDC.map((name, ndc) =>
      el("button", { "data-ndc": String(ndc), class: ndc === state.home ? "home" : null, onclick: () => goShelf(ndc) }, el("b", {}, String(ndc)), name)
    )
  );
  updateHallNav();
  renderShiftList();
}

function shelfCase(ndc) {
  const list = state.books.filter((b) => b.ndc === ndc).sort((a, b) => collator.compare(a.spine, b.spine));
  const loading = state.pending?.has(ndc);
  const shift = state.shifts.find((s) => s.ndc === ndc);
  const tiers = Math.min(3, Math.max(1, Math.ceil(list.length / 4)));
  const per = Math.ceil(list.length / tiers) || 0;
  return el(
    "div",
    {
      class: `case${list.length ? "" : " empty"}${loading ? " loading" : ""}`,
      "data-ndc": ndc,
      title: ndc === state.home ? `「${state.trail[state.current]?.query}」` : shift ? `${shift.kind}：「${shift.query}」` : null,
    },
    el("div", { class: "plate" }, el("b", {}, String(ndc)), NDC[ndc], el("small", {}, loading ? "集書中…" : `${list.length}冊`)),
    el(
      "div",
      { class: "case-body" },
      Array.from({ length: tiers }, (_, t) => el("div", { class: "tier" }, list.slice(t * per, (t + 1) * per).map(spine)))
    )
  );
}

function updateShelf(ndc) {
  const old = $(`#hall .case[data-ndc="${ndc}"]`);
  if (!old) return;
  old.replaceWith(shelfCase(ndc));
  applyFilter();
  updateHallNav();
}

function renderShiftList() {
  const counts = new Map();
  for (const b of state.books) counts.set(b.shiftIndex, (counts.get(b.shiftIndex) || 0) + 1);
  $("#shiftList").replaceChildren(
    ...state.shifts.map((s, i) =>
      el(
        "div",
        {
          class: "shift",
          role: "button",
          tabindex: "0",
          "aria-pressed": String(state.filter === i),
          style: `--band:${kindColor(s.kind)}`,
          onclick: () => toggleFilter(i),
          onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleFilter(i)),
        },
        el("span", { class: "n" }, state.pending?.has(s.ndc) ? "…" : `${counts.get(i) || 0}冊`),
        el("span", { class: "kind" }, `${s.ndc} ${NDC[s.ndc]} ・ ${s.kind}`),
        el("p", { class: "note" }, s.note),
        // 押すと、司書が選書に使った言葉で検索しなおす（寄り道の記録に1歩増える）
        el(
          "button",
          {
            class: "go",
            title: `「${s.query}」を新しい検索語にして、10の書架を選びなおします`,
            onclick: (e) => {
              e.stopPropagation();
              explore({ query: s.query, kind: s.kind, from: state.trail[state.current]?.query });
            },
          },
          el("span", { class: "go-label" }, "この言葉で探しなおす"),
          el("span", { class: "go-q" }, `「${s.query}」`),
          el("span", { class: "go-arrow", "aria-hidden": "true" }, "→")
        )
      )
    )
  );
}

function spine(b) {
  const h = hash(b.url);
  const [c, t] = CLOTH[h % CLOTH.length];
  const len = [...b.spine].length;
  const w = len > 11 ? 44 + (h % 6) : 32 + (h % 8);
  const height = 138 + (h % 34); // 段の内寸（188px）に、持ち上げても収まる余白を残す
  return el(
    "button",
    {
      class: `book${state.read.has(b.url) ? " read" : ""}`,
      style: `--c:${c};--t:${t};--w:${w}px;--h:${height}px;--band:${kindColor(b.origin?.kind)}`,
      "data-host": b.host.replace(/^www\./, ""),
      "data-kind": b.origin?.kind || "",
      "data-shift": String(b.shiftIndex ?? -1),
      "aria-label": `${b.title}（${b.host}）`,
      onclick: () => openBook(b),
      onmouseenter: (e) => showTip(e, b),
      onmouseleave: hideTip,
      onfocus: (e) => showTip(e, b),
      onblur: hideTip,
    },
    el("span", { class: "t" }, b.spine)
  );
}

let tipEl;
function showTip(e, b) {
  hideTip();
  const r = e.currentTarget.getBoundingClientRect();
  tipEl = el("div", { class: "book-tip" }, el("b", {}, b.title), b.host, b.origin ? ` ・ ${b.origin.kind}` : "");
  document.body.append(tipEl);
  const tw = tipEl.offsetWidth;
  tipEl.style.left = `${Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
  tipEl.style.top = `${Math.max(8, r.top - tipEl.offsetHeight - 22)}px`;
}
function hideTip() {
  tipEl?.remove();
  tipEl = null;
}

function toggleFilter(i) {
  state.filter = state.filter === i ? null : i;
  $$(".shift").forEach((n, j) => n.setAttribute("aria-pressed", String(state.filter === j)));
  applyFilter();
  if (state.filter != null) {
    $(`#hall .case[data-ndc="${state.shifts[i].ndc}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

function applyFilter() {
  const on = state.filter != null;
  hall.classList.toggle("filtering", on);
  $$(".book", hall).forEach((b) => b.classList.toggle("match", on && b.dataset.shift === String(state.filter)));
}

// 書架の間を歩く：縦ホイールはページのスクロールに使い、横移動は矢印・書架番号・キー・横スワイプで
const hall = $("#hall");
const step = () => Math.max(240, hall.clientWidth * 0.7);
hall.addEventListener("keydown", (e) => {
  if (e.target !== hall) return;
  if (e.key === "ArrowRight") (e.preventDefault(), hall.scrollBy({ left: step() }));
  if (e.key === "ArrowLeft") (e.preventDefault(), hall.scrollBy({ left: -step() }));
});
$("#hallPrev").addEventListener("click", () => hall.scrollBy({ left: -step() }));
$("#hallNext").addEventListener("click", () => hall.scrollBy({ left: step() }));

function goShelf(ndc) {
  const c = $(`#hall .case[data-ndc="${ndc}"]`);
  if (c) hall.scrollTo({ left: c.offsetLeft - (hall.clientWidth - c.offsetWidth) / 2 });
}

// 矢印の出し入れと、いま正面にある書架の番号を光らせる
function updateHallNav() {
  const max = hall.scrollWidth - hall.clientWidth;
  $("#hallPrev").hidden = hall.scrollLeft <= 4;
  $("#hallNext").hidden = hall.scrollLeft >= max - 4;
  // いま見えている書架（6割以上見えているもの）を光らせる
  const l = hall.scrollLeft, r = l + hall.clientWidth;
  const visible = new Set();
  for (const c of $$(".case", hall)) {
    const shown = Math.min(r, c.offsetLeft + c.offsetWidth) - Math.max(l, c.offsetLeft);
    if (shown >= c.offsetWidth * 0.6) visible.add(c.dataset.ndc);
  }
  $$("#shelfNav button").forEach((b) => b.setAttribute("aria-current", String(visible.has(b.dataset.ndc))));
}
hall.addEventListener("scroll", () => requestAnimationFrame(updateHallNav), { passive: true });
addEventListener("resize", updateHallNav);

/* =========================================================
   本を手に取る
   ========================================================= */
// ページの取り寄せ：本を手に取った時点で先に始めておき、結果を覚えておく
// 失敗したらもう一度取りに行けるよう忘れる
const clipCache = new Map();
const fetchClip = (url) =>
  remember(clipCache, url, () => {
    const p = api(`/api/clip?url=${encodeURIComponent(url)}`);
    p.catch(() => clipCache.delete(url));
    return p;
  }, 30);
// 本物の Chrome で描画して写し取った版（時間がかかるので、本を手に取った時点で頼んでおく）。
// 失敗しても覚えておき、同じページで何度も待たせない
const renderCache = new Map();
const fetchRendered = (url) =>
  remember(renderCache, url, () => {
    const p = api(`/api/clip?url=${encodeURIComponent(url)}&mode=render`);
    p.catch(() => {});
    return p;
  }, 30);

let openedBook = null;
function openBook(b) {
  hideTip();
  openedBook = b;
  prepareClip(b.url);
  state.read.add(b.url);
  $$(".book").forEach((n) => n.getAttribute("aria-label") === `${b.title}（${b.host}）` && n.classList.add("read"));
  $("#bookShelf").textContent = `${b.ndc} ${NDC[b.ndc]} の書架`;
  $("#bookTitle").textContent = b.title;
  let shown = b.url;
  try {
    shown = decodeURI(b.url);
  } catch {}
  $("#bookHost").textContent = shown;
  $("#bookSnippet").textContent = b.snippet || "（概要なし）";
  const origin = $("#bookOrigin");
  if (b.origin) {
    origin.style.setProperty("--band", kindColor(b.origin.kind));
    origin.replaceChildren(
      el("b", {}, "司書のコメント"),
      el("p", { class: "origin-note" }, b.origin.note),
      el("small", {}, `${b.origin.kind}へのずらし ・ 選書に使った言葉「${b.origin.query}」`)
    );
  } else {
    origin.style.removeProperty("--band");
    origin.textContent = `「${state.trail[state.current]?.query}」でそのまま見つかった本です。`;
  }
  $("#bookOpen").href = safeUrl(b.url);
  const wasOpen = !$("#drawer").hidden;
  $("#drawer").hidden = false;
  // 拡張機能があれば「切り抜く」でふつうのタブに開くので、「ページを開く」とまとめて1つのボタンにする
  $("#bookClip").textContent = hasExtension() ? "ページを開いて切り抜く ↗" : "切り抜く";
  $("#bookClip").focus();
  if (!wasOpen) pushNav();
  else replaceNav();
}
// Charinco 切り抜きの拡張機能が入っているか（extension/bridge.js が印を付ける）
const hasExtension = () => document.documentElement.dataset.charincoExt === "1";
$("#bookClip").addEventListener("click", () => {
  // 拡張機能があれば、ふつうの Chrome のタブで開いて、その上で切り抜いてもらう
  if (hasExtension()) {
    window.postMessage({ charinco: "open", url: openedBook.url }, location.origin);
    toast("隣のタブで開きました。右下の「✂ 切り抜き」（C キー）で切り抜けます");
    return;
  }
  // 本の説明の履歴を切り抜き画面に置き換える（戻ると図書館に戻る）
  $("#drawer").hidden = true;
  openReader(openedBook);
  replaceNav();
});
$("#bookPin").addEventListener("click", () => {
  pinBook(openedBook);
  closeDrawer();
});
$("#bookShift").addEventListener("click", () => {
  const b = openedBook;
  $("#drawer").hidden = true;
  replaceNav();
  explore({
    query: b.spine || b.title,
    kind: b.origin?.kind || null,
    from: state.trail[state.current]?.query,
    seed: { title: b.title, snippet: b.snippet },
  });
});

/* =========================================================
   切り抜きリーダー
   ========================================================= */
const PURIFY = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "video", "audio", "svg", "math"],
  FORBID_ATTR: ["style", "class", "id", "width", "height"],
};
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") {
    node.setAttribute("referrerpolicy", "no-referrer");
    node.setAttribute("loading", "lazy");
  }
});
const clean = (html) => DOMPurify.sanitize(html, PURIFY);

function extractBlocks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = doc.querySelector("meta[property='og:title']")?.content || doc.title || baseUrl;
  $$("script,style,noscript,template,nav,footer,aside,form,iframe,header [role=navigation],[aria-hidden=true]", doc).forEach((n) => n.remove());

  // 遅延読み込み画像とURLの絶対化
  for (const img of $$("img", doc)) {
    const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || img.getAttribute("src");
    if (src) img.setAttribute("src", src);
    img.removeAttribute("srcset");
  }
  for (const [sel, attr] of [["img", "src"], ["a", "href"]]) {
    for (const n of $$(`${sel}[${attr}]`, doc)) {
      try {
        n.setAttribute(attr, new URL(n.getAttribute(attr), baseUrl).href);
      } catch {
        n.removeAttribute(attr);
      }
    }
  }

  const root = doc.querySelector("article") || doc.querySelector("main,[role=main]") || doc.body;
  const SEL = "h1,h2,h3,h4,p,blockquote,pre,ul,ol,table,figure,img,dl";
  const blocks = [];
  for (const n of $$(SEL, root)) {
    if (n.parentElement?.closest(SEL)) continue; // 入れ子はまとめて扱う
    const text = n.textContent.trim();
    const hasImg = n.tagName === "IMG" || n.querySelector("img");
    if (!hasImg && text.length < (/^H\d$/.test(n.tagName) ? 2 : 6)) continue;
    const html = clean(n.outerHTML);
    if (html.trim()) blocks.push(html);
    if (blocks.length >= 400) break;
  }
  return { title, blocks };
}

/* ---------- 元のデザインで表示する（iframe） ---------- */

// 元サイトの見た目を保ったカード用のサニタイズ設定（style 属性を許可）
const PURIFY_STYLED = {
  FORBID_TAGS: ["style", "link", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "video", "audio", "math", "foreignObject"],
  FORBID_ATTR: ["class", "id"],
};
const cleanStyled = (html) => {
  const out = DOMPurify.sanitize(html, { ...PURIFY_STYLED, RETURN_DOM_FRAGMENT: true });
  // ボードの外にはみ出す配置は無効にする
  for (const n of out.querySelectorAll("[style]")) {
    for (const p of ["position", "z-index", "top", "left", "right", "bottom", "inset"]) n.style.removeProperty(p);
  }
  const box = document.createElement("div");
  box.append(out);
  return box.innerHTML;
};

const HL = "charinco-hl";
const HINT_CLIP = "切り抜きたい部分をクリック／ドラッグで範囲を囲んで切り抜く";
const HINT_BROWSE = "閲覧モード ― リンクをたどって読めます。切り抜くときは「✂ 切り抜き」に切り替え（C キー）";
// 閲覧モード（false）と切り抜きモード（true）。ページを切り替えても選んだモードのまま
let clipping = false;
let onClipModeChange = null; // 表示中のページが、モード切り替え時の後始末を登録する
const hintDefault = () => (clipping ? HINT_CLIP : HINT_BROWSE);
function setClipMode(on) {
  clipping = on;
  $("#modeBrowse").setAttribute("aria-pressed", String(!on));
  $("#modeClip").setAttribute("aria-pressed", String(on));
  $("#readerBody").classList.toggle("clipping", on);
  const hint = $("#readerHint");
  hint.textContent = hintDefault();
  hint.classList.toggle("browse", !on);
  onClipModeChange?.();
}
$("#modeBrowse").addEventListener("click", () => setClipMode(false));
$("#modeClip").addEventListener("click", () => setClipMode(true));
setClipMode(false);
// リーダーの外（「読みやすい表示」やバー）にフォーカスがあるときの C キー
document.addEventListener("keydown", (e) => {
  if ($("#reader").hidden || clipPreview || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
  if (e.key === "c" || e.key === "C") {
    e.preventDefault();
    setClipMode(!clipping);
  }
});
const CLIPPED = "charinco-clipped";

// 取得したHTMLを、スクリプトを除いて元のCSSのまま表示できる文書にする
function buildPageDoc(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  $$("script,iframe,frame,frameset,embed,param,base,meta[http-equiv]", doc).forEach((n) => n.remove());
  // <object> は外側だけ外す（中身は「読み込めないときの代わりの表示」で、記事の見出しなどを入れるサイトがある）
  for (const o of $$("object", doc).reverse()) o.replaceWith(...o.childNodes);
  // （sandbox でスクリプトは動かないが、念のため on* 属性と javascript: も消す）
  for (const n of doc.getElementsByTagName("*")) {
    const attrs = n.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const { name, value } = attrs[i];
      if (/^on/i.test(name) || (value.length > 10 && /^\s*javascript:/i.test(value))) n.removeAttribute(name);
    }
  }
  // 遅延読み込み画像（スクリプトが動かないので自分で差し替える）
  for (const img of $$("img,source", doc)) {
    const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
    if (src) img.setAttribute("src", src);
    const set = img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
    if (set) img.setAttribute("srcset", set);
    img.removeAttribute("loading");
    // 「スクリプトが無いときは .lazyload を隠す」類のCSSに巻き込まれないように
    if (src || set) for (const c of [...img.classList]) if (/lazy/i.test(c)) img.classList.remove(c);
  }
  // 遅延読み込みの背景画像
  for (const n of $$("[data-bg],[data-background],[data-background-image],[data-lazy-background]", doc)) {
    const v = n.getAttribute("data-bg") || n.getAttribute("data-background") || n.getAttribute("data-background-image") || n.getAttribute("data-lazy-background");
    if (v && !/^\s*javascript:/i.test(v)) n.style.backgroundImage = /^url\(/i.test(v.trim()) ? v : `url("${v.replace(/"/g, "%22")}")`;
  }
  // <noscript>：スクリプトが動かない枠では中身がそのまま表示されてしまう。
  // 画像の代替だけ残し、「JavaScriptを有効に」等の案内や、すでに表示される画像との重複は取り除く
  for (const ns of $$("body noscript", doc)) {
    const hasImg = ns.querySelector("img");
    const dup = hasImg && [...(ns.parentElement?.querySelectorAll("img") || [])].some((i) => !ns.contains(i));
    if (!hasImg || dup) ns.remove();
  }
  // CSS とフォントは自分のサーバー経由で読む（他サイトのフォントは localhost からだと拒否されるため）
  const relay = (abs) => `${location.origin}/api/asset?url=${encodeURIComponent(abs)}`;
  const styles = [];
  for (const link of $$('link[rel~="stylesheet"][href]', doc)) {
    const abs = httpUrl(link.getAttribute("href"), baseUrl);
    if (abs) styles.push(relay(abs));
    if (abs) link.setAttribute("href", relay(abs));
    link.removeAttribute("integrity");
    link.removeAttribute("crossorigin");
  }
  $$('link[rel="preload"][as="font"]', doc).forEach((n) => n.remove());
  for (const st of $$("style", doc)) {
    st.textContent = st.textContent.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, href) => {
      const abs = httpUrl(href.trim(), baseUrl);
      return abs && /\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(abs) ? `url("${relay(abs)}")` : m;
    });
  }
  const head = doc.head;
  head.prepend(
    Object.assign(doc.createElement("base"), { href: baseUrl }),
    Object.assign(doc.createElement("meta"), { name: "referrer", content: "no-referrer" })
  );
  const style = doc.createElement("style");
  style.textContent = `.${HL}{outline:2px dashed #b5452f!important;outline-offset:2px!important;cursor:copy!important}
.${CLIPPED}{outline:2px solid #b5452f!important;outline-offset:2px!important}
html{scroll-behavior:auto!important}
[data-aos],[data-sal],[data-scroll],[data-animate],.wow,.aos-init,.fadein,.fade-in,.js-fade,.js-fadein,.inview,.scroll-reveal{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important}`;
  head.append(style);
  const title = doc.querySelector("meta[property='og:title']")?.content || doc.title || baseUrl;
  return { title, styles, srcdoc: "<!doctype html>\n" + doc.documentElement.outerHTML };
}

// 本を手に取った時点で、ページの取り寄せ・組み立て・CSSの読み込みまで済ませておく
const builtCache = new Map();
const buildCached = (page) =>
  remember(builtCache, (page.rendered ? "render:" : "static:") + page.url, () => buildPageDoc(page.html, page.base || page.url), 20);
function prepareClip(url) {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 30));
  const warm = (page) =>
    idle(() => {
      try {
        for (const href of buildCached(page).styles) fetch(href).catch(() => {});
      } catch {}
    });
  fetchClip(url).then(warm, () => {});
  // ライブ表示が使えるなら、裏の Chrome で先にページを開いておく（写し取りは要らない）
  liveReady.then((ok) => {
    if (ok && !liveFailed.has(url)) liveOpen(url).catch(() => {});
    else fetchRendered(url).then(warm, () => {});
  });
}

// 元の見た目のまま持ち出せるHTMLにする（中身は clipcore.js。裏の Chrome のページでも同じものを使う）
const MAX_CLIP = 400_000; // 1枚のカードに入れる HTML の上限（文字数）
function finishClip(raw) {
  const html = cleanStyled(raw);
  if (html.length > MAX_CLIP) throw new Error("範囲が大きすぎます。↓キーで狭めてください。");
  return html;
}
const serializeStyled = (root, keep, trimText) => finishClip(CharincoClip.serialize(root, keep, trimText));
// 切り抜きカードの幅（ボード上で読める範囲に収める）
const clipCardWidth = (w) => Math.max(200, Math.min(560, Math.round(w)));

let readerToken = 0;
let readerCleanup = null;
let readerMode = "page"; // "page"：元のデザイン / "simple"：読みやすい表示

/* 切り抜き画面で開いているページ（タブ） */
const pages = []; // { b, ratio }
let activeUrl = null;
const MAX_PAGES = 12;
const activePage = () => pages.find((p) => p.b.url === activeUrl) || null;
function frameScrollRatio() {
  const se = $("#readerBody .page-frame")?.contentDocument?.scrollingElement;
  return se ? se.scrollTop / Math.max(1, se.scrollHeight) : 0;
}
function hideReader() {
  const cur = activePage();
  if (cur && !$("#reader").hidden) cur.ratio = frameScrollRatio();
  $("#reader").hidden = true;
  renderPageTabs();
  closeClipPreview();
  // 隠している間は画面の受け取りなどを止める（開き直すときに openReader で作り直す）
  if ($("#readerBody").classList.contains("live")) {
    readerCleanup?.();
    readerCleanup = null;
  }
}
function closePage(url) {
  const i = pages.findIndex((p) => p.b.url === url);
  if (i < 0) return;
  pages.splice(i, 1);
  liveClose(url);
  if (url === activeUrl) {
    const next = pages[i] || pages[i - 1];
    activeUrl = null;
    if (next) {
      openReader(next.b);
      replaceNav();
    } else closeReader();
  }
  renderPageTabs();
}
function renderPageTabs() {
  const nav = $("#readerTabs");
  nav.replaceChildren(
    ...pages.map((p) => {
      let host = "";
      try {
        host = new URL(p.b.url).hostname.replace(/^www\./, "");
      } catch {}
      const active = p.b.url === activeUrl;
      return el(
        "div",
        { class: "reader-tab", "aria-current": active ? "page" : null },
        el(
          "button",
          {
            class: "reader-tab-open",
            title: `${p.b.title}\n${p.b.url}`,
            onclick: () => {
              if (p.b.url === activeUrl) return;
              openReader(p.b);
              replaceNav();
            },
          },
          el("span", { class: "reader-tab-title" }, p.b.title),
          el("span", { class: "reader-tab-host" }, host)
        ),
        el("button", { class: "reader-tab-close", "aria-label": `${p.b.title} を閉じる`, onclick: () => closePage(p.b.url) }, "×")
      );
    })
  );
  nav.hidden = !pages.length;
  $("#pagesCount").textContent = pages.length;
  $("#pagesCount").classList.toggle("zero", !pages.length);
  updateTabs();
}
$("#pagesTab").addEventListener("click", () => {
  if (!$("#reader").hidden) return;
  const p = activePage() || pages[pages.length - 1];
  if (!p) return toast("まだ開いているページはありません。本を手に取り「切り抜く」を押してください");
  $("#drawer").hidden = true;
  openReader(p.b);
  pushNav();
});
// ヘッダーのタブ：切り抜き画面を開いている間は「開いているページ」を選択中にする
function updateTabs() {
  const readerOpen = !$("#reader").hidden;
  const view = $("#view-board").hidden ? "library" : "board";
  $$(".tabs button[data-view]").forEach((b) => b.setAttribute("aria-selected", String(!readerOpen && b.dataset.view === view)));
  $("#pagesTab").setAttribute("aria-selected", String(readerOpen));
}
// 本の説明・切り抜き画面はヘッダーの下に重ねる（ヘッダーのタブを常に見せる）
new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${$(".top").offsetHeight}px`)).observe($(".top"));

async function openReader(b) {
  const reader = $("#reader");
  const body = $("#readerBody");
  const token = ++readerToken;
  // いま見ているページの位置を覚えてから切り替える
  const prev = activePage();
  if (prev && !reader.hidden) prev.ratio = frameScrollRatio();
  closeClipPreview();
  readerCleanup?.();
  let entry = pages.find((p) => p.b.url === b.url);
  if (!entry) {
    entry = { b, ratio: 0 };
    pages.push(entry);
    if (pages.length > MAX_PAGES) pages.splice(pages.findIndex((p) => p !== entry), 1);
  }
  activeUrl = b.url;
  renderPageTabs();
  // 開いたタブが見えるようにする
  requestAnimationFrame(() => $('#readerTabs .reader-tab[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  $("#readerTitle").textContent = b.title;
  $("#readerOpen").href = safeUrl(b.url);
  $("#readerMode").hidden = true;
  body.classList.remove("page");
  body.replaceChildren(el("div", { class: "reader-msg" }, el("div", { class: "wheel small", "aria-hidden": "true" }), el("p", {}, "ページを取り寄せています…")));
  reader.hidden = false;
  updateTabs();
  body.scrollTop = 0;

  const fallback = (msg) =>
    body.replaceChildren(
      el(
        "div",
        { class: "reader-msg" },
        el("p", {}, msg),
        el("button", { class: "btn primary", onclick: () => (pinBook(b), closeReader()) }, "概要だけカードにして貼る")
      )
    );

  const status = $("#readerStatus");
  status.textContent = "";
  status.classList.remove("busy");

  // ライブ表示：裏の本物の Chrome の画面を映して、そのまま操作する
  if (readerMode === "page" && !liveFailed.has(b.url) && (await liveReady)) {
    if (token !== readerToken) return;
    $("#readerMode").hidden = false;
    $("#readerMode").textContent = "読みやすい表示にする";
    $("#readerMode").onclick = () => {
      readerMode = "simple";
      openReader(b);
    };
    renderLive(b, token, () => {
      // 開けなければ、写し取った HTML での表示に切り替える
      liveFailed.add(b.url);
      if (token === readerToken) openReader(b);
    });
    return;
  }

  // 再現版（本物の Chrome で描画したもの）が少し待って届くならそれを使い、
  // 間に合わなければ取得したままの HTML で先に表示して、届いた時点で差し替える
  const rendered = fetchRendered(b.url);
  let page = await Promise.race([rendered.catch(() => null), new Promise((r) => setTimeout(r, 1800, null))]);
  if (!page) {
    try {
      page = await fetchClip(b.url);
    } catch (err) {
      page = await rendered.catch(() => null);
      if (!page) {
        if (token === readerToken) fallback(`${err.message}（サイトが取得を拒否している可能性があります）`);
        return;
      }
    }
  }
  if (token !== readerToken || reader.hidden) return;
  if (!page.rendered) {
    status.textContent = "元の見た目を再現しています…";
    status.classList.add("busy");
    rendered.then(
      (rp) => {
        if (token !== readerToken || reader.hidden) return;
        status.classList.remove("busy");
        // すでに切り抜いた後なら、選んでいる場所が変わらないよう差し替えない
        if (readerMode !== "page" || $("#readerBody").dataset.clipped) {
          status.textContent = "";
          return;
        }
        const ratio = frameScrollRatio();
        page = rp;
        render(ratio);
        status.textContent = "再現表示に切り替えました";
        setTimeout(() => token === readerToken && (status.textContent = ""), 2500);
      },
      () => {
        if (token !== readerToken) return;
        status.classList.remove("busy");
        status.textContent = "";
      }
    );
  }

  const render = (scrollRatio = 0) => {
    readerCleanup?.();
    readerCleanup = null;
    delete $("#readerBody").dataset.clipped;
    $("#readerMode").hidden = false;
    $("#readerMode").textContent = readerMode === "page" ? "読みやすい表示にする" : "元のデザインで表示する";
    if (readerMode === "page") renderPage(page, b, fallback, scrollRatio);
    else renderSimple(page, fallback);
  };
  $("#readerMode").onclick = () => {
    readerMode = readerMode === "page" ? "simple" : "page";
    if (readerMode === "page" && liveOk && !liveFailed.has(b.url)) return openReader(b);
    render();
  };
  render(entry.ratio || 0);
}

// 切り抜く前の確認：ボードに貼られる姿を見せ、「貼る／やめる」を選んでもらう
let clipPreview = null; // { confirm, cancel }
// onClose は、貼っても・やめても、閉じたときに呼ぶ（元のページで光らせていた枠を消すなど）
function openClipPreview({ html, w, count, onConfirm, onClose }) {
  closeClipPreview();
  const reader = $("#reader");
  const content = el("div", { class: "content" });
  content.innerHTML = cleanStyled(html);
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    wrap.remove();
    clipPreview = null;
    if (ok) onConfirm(note.value.trim());
    onClose?.();
  };
  const okBtn = el("button", { class: "btn primary", onclick: () => finish(true) }, "ボードに貼る");
  const note = el("textarea", {
    class: "clip-preview-comment",
    rows: "2",
    placeholder: "コメント（任意）：なぜ気になったか、何とつながりそうか…",
    "aria-label": "コメント",
  });
  const wrap = el(
    "div",
    { class: "clip-preview", role: "dialog", "aria-label": "切り抜きのプレビュー" },
    el(
      "div",
      { class: "clip-preview-panel" },
      el("p", { class: "clip-preview-head" }, count > 1 ? `${count} か所をまとめて、このように貼ります` : "このように貼ります"),
      el("div", { class: "clip-preview-stage" }, el("div", { class: "card styled", style: `width:${w}px` }, content)),
      el("div", { class: "clip-preview-note" }, note),
      el(
        "div",
        { class: "clip-preview-actions" },
        el("span", { class: "clip-preview-keys" }, "Enter で貼る（コメント入力中は ⌘/Ctrl+Enter）／Esc でやめる"),
        el("button", { class: "btn", onclick: () => finish(false) }, "やめる"),
        okBtn
      )
    )
  );
  wrap.addEventListener("click", (e) => e.target === wrap && finish(false));
  reader.append(wrap);
  clipPreview = { confirm: () => finish(true), cancel: () => finish(false) };
  okBtn.focus({ preventScroll: true });
}
function closeClipPreview() {
  clipPreview?.cancel();
}

// 切り抜き画面のキーのうち、表示のしかた（ライブ／写し取り）によらないもの。処理したら true
function handleReaderKey(e, cancelDrag) {
  if (clipPreview) {
    // コメント欄では Enter は改行。⌘/Ctrl+Enter で貼る
    if (e.key === "Enter" && e.target.closest?.("textarea") && !e.metaKey && !e.ctrlKey) return true;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      clipPreview.confirm();
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      clipPreview.cancel();
    }
    return true;
  }
  if (e.key === "Escape") {
    // 後ろの本の説明（ドロワー）まで一緒に閉じないよう、ここで止める。
    // 範囲選択中なら選択だけをやめ、そうでなければ切り抜き画面を閉じる
    e.stopImmediatePropagation();
    if (!cancelDrag()) closeReader();
    return true;
  }
  return false;
}

function renderPage(page, b, fallback, scrollRatio = 0) {
  const body = $("#readerBody");
  const hint = $("#readerHint");
  const { title, srcdoc } = buildCached(page);
  $("#readerTitle").textContent = title;
  body.classList.add("page");
  // allow-scripts を付けないので元サイトのスクリプトは一切動かない
  const frame = el("iframe", { class: "page-frame", sandbox: "allow-same-origin", title: "元のページ" });
  frame.srcdoc = srcdoc;
  body.replaceChildren(frame);

  let current = null;
  const trail = []; // ↑で広げたときに戻るための履歴
  const describe = (n) => {
    const r = n.getBoundingClientRect();
    return `<${n.tagName.toLowerCase()}> ${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const select = (n) => {
    current?.classList.remove(HL);
    current = n;
    if (n) {
      n.classList.add(HL);
      hint.textContent = `${describe(n)} を選択中 ― クリックで切り抜く／↑↓キーで広げる・狭める／ドラッグで範囲を囲む`;
    } else hint.textContent = hintDefault();
  };
  const { blockOf, collectRange } = CharincoClip;
  let cancelDrag = null;
  const onKey = (e) => {
    if ($("#reader").hidden || handleReaderKey(e, () => cancelDrag?.())) return;
    if (!clipping || !current) return;
    if (e.key === "ArrowUp") {
      const p = current.parentElement;
      if (p && !["BODY", "HTML"].includes(p.tagName)) {
        e.preventDefault();
        trail.push(current);
        select(p);
      }
    } else if (e.key === "ArrowDown" && trail.length) {
      e.preventDefault();
      select(trail.pop());
    } else if (e.key === "Enter") {
      e.preventDefault();
      clipCurrent();
    }
  };
  // プレビューで確かめてから貼る。貼ったら元のページの該当部分に印を付ける
  const previewAndPaste = (nodes, html, w, doneMsg, onClose) =>
    openClipPreview({
      html,
      w,
      count: nodes.length,
      onClose,
      onConfirm: (comment) => {
        nodes.forEach((n) => n.classList.add(CLIPPED));
        body.dataset.clipped = "1";
        addCard({ type: "clip", styled: true, html, src: { title, url: page.url }, w, comment });
        toast(doneMsg);
      },
    });
  // 集めた要素を、共通の親ごと1枚のカードにする（枠に掛からなかった兄弟は持ち出さない）
  const clipRange = (doc, picked) => {
    if (!picked.length) return toast("枠の中に切り抜ける部分がありませんでした");
    let html;
    try {
      html = finishClip(CharincoClip.serializePicked(picked));
    } catch (err) {
      return toast(err.message);
    }
    // プレビュー中も、どこを切り抜くのか元のページ上で分かるようにしておき、閉じたら消す
    picked.forEach((n) => n.classList.add(HL));
    previewAndPaste(picked, html, CharincoClip.cardWidth(picked), `囲んだ ${picked.length} か所をまとめて貼りました`, () =>
      picked.forEach((n) => n.classList.remove(HL))
    );
  };

  const clipCurrent = () => {
    if (!current) return;
    let html;
    try {
      html = serializeStyled(current);
    } catch (err) {
      return toast(err.message);
    }
    previewAndPaste([current], html, clipCardWidth(current.getBoundingClientRect().width + 16), "元のデザインのまま貼りました");
  };

  // 画像やCSSを待たず、HTMLの読み込みが終わった時点で操作できるようにする
  let attached = false;
  const tryAttach = (final) => {
    const doc = frame.contentDocument;
    const ready = doc && doc.URL === "about:srcdoc" && doc.body && doc.readyState !== "loading";
    if (ready) {
      unblockPage(doc);
      if (!attached) {
        attached = true;
        setup(doc);
      }
    } else if (final && !attached && doc?.URL === "about:srcdoc") fallback("ページを表示できませんでした。");
  };
  const poll = setInterval(() => {
    tryAttach(false);
    if (attached || !frame.isConnected) clearInterval(poll);
  }, 60);
  frame.addEventListener("load", () => tryAttach(true));

  function setup(doc) {
    if (scrollRatio > 0 && doc.scrollingElement) {
      const se = doc.scrollingElement;
      se.scrollTop = scrollRatio * se.scrollHeight;
      // 画像やCSSが後から読み込まれて高さが変わっても、だいたい同じ場所に留まる
      doc.defaultView.addEventListener("load", () => (se.scrollTop = scrollRatio * se.scrollHeight), { once: true });
    }
    // 本文がほぼ空なら、スクリプトで描画するサイトとみなす
    if (doc.body.innerText.trim().length < 40 && !doc.querySelector("img")) {
      hint.textContent = "このサイトはスクリプトで描画されるため、元のデザインでは表示できません。「読みやすい表示」を試してください。";
    }
    // ドラッグで範囲を囲む（クリックは従来どおりブロック単位）
    let drag = null;
    let suppressClick = false;
    const box = doc.createElement("div");
    box.id = "charinco-range";
    box.setAttribute(
      "style",
      "position:absolute;z-index:2147483647;pointer-events:none;border:2px dashed #b5452f;background:rgba(181,69,47,.08);box-sizing:border-box;display:none;margin:0"
    );
    const pageRect = (a, b) => {
      const sx = doc.defaultView.scrollX, sy = doc.defaultView.scrollY;
      const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
      // 画面上の座標（getBoundingClientRect と同じ基準）に直す
      return { left: x1 - sx, top: y1 - sy, right: x2 - sx, bottom: y2 - sy, width: x2 - x1, height: y2 - y1 };
    };
    const pointOf = (e) => ({ x: e.clientX + doc.defaultView.scrollX, y: e.clientY + doc.defaultView.scrollY });
    doc.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0 || !clipping) return; // 閲覧モードでは文字選択などふつうに使える
        e.preventDefault(); // 文字選択や画像のドラッグを始めない
        drag = { start: pointOf(e), active: false };
      },
      true
    );
    doc.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const p = pointOf(e);
      if (!drag.active && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 8) return;
      if (!drag.active) {
        drag.active = true;
        select(null);
        doc.body.append(box);
        box.style.display = "block";
      }
      drag.end = p;
      // 枠が画面の端に来たら少しずつスクロールする
      const vh = doc.defaultView.innerHeight;
      if (e.clientY > vh - 30) doc.defaultView.scrollBy(0, 24);
      else if (e.clientY < 30) doc.defaultView.scrollBy(0, -24);
      const x1 = Math.min(drag.start.x, p.x), y1 = Math.min(drag.start.y, p.y);
      // body に position:relative 等が付いていても枠がずれないよう、body の位置を差し引く
      const br = doc.body.getBoundingClientRect();
      const bodyStatic = doc.defaultView.getComputedStyle(doc.body).position === "static";
      const offX = bodyStatic ? 0 : br.left + doc.defaultView.scrollX;
      const offY = bodyStatic ? 0 : br.top + doc.defaultView.scrollY;
      Object.assign(box.style, { left: `${x1 - offX}px`, top: `${y1 - offY}px`, width: `${Math.abs(p.x - drag.start.x)}px`, height: `${Math.abs(p.y - drag.start.y)}px` });
      // 枠に掛かっている要素をその場で光らせる
      if (!drag.raf)
        drag.raf = requestAnimationFrame(() => {
          if (!drag?.active) return;
          drag.raf = 0;
          const picked = collectRange(doc, pageRect(drag.start, drag.end));
          drag.picked?.forEach((n) => n.classList.remove(HL));
          picked.forEach((n) => n.classList.add(HL));
          drag.picked = picked;
          hint.textContent = `${picked.length} か所を選択中 ― 離すと切り抜く／Esc でやめる`;
        });
    });
    const endDrag = (e, cancel) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      box.style.display = "none";
      box.remove();
      if (d.raf) cancelAnimationFrame(d.raf);
      d.picked?.forEach((n) => n.classList.remove(HL));
      if (!d.active) return;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      hint.textContent = hintDefault();
      if (!cancel && e) clipRange(doc, collectRange(doc, pageRect(d.start, d.end || pointOf(e))));
    };
    doc.addEventListener("mouseup", (e) => endDrag(e, false));
    cancelDrag = () => (drag?.active ? (endDrag(null, true), true) : ((drag = null), false));
    doc.defaultView.addEventListener("blur", () => endDrag(null, true));
    doc.addEventListener("mouseover", (e) => {
      if (!clipping || drag?.active) return;
      const n = blockOf(e.target);
      if (n && n !== current) {
        trail.length = 0;
        select(n);
      }
    });
    doc.addEventListener(
      "click",
      (e) => {
        if (!clipping) return followLink(e, page.url);
        e.preventDefault();
        e.stopPropagation();
        if (suppressClick) return;
        clipCurrent();
      },
      true
    );
    doc.addEventListener("submit", (e) => e.preventDefault(), true);
    doc.addEventListener("keydown", onKey);
    // ページの中にフォーカスがあるときの C キー（外側の document には届かないため）
    doc.addEventListener("keydown", (e) => {
      if (clipPreview || e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || (e.key !== "c" && e.key !== "C")) return;
      e.preventDefault();
      setClipMode(!clipping);
    });
  }
  document.addEventListener("keydown", onKey, true);
  // 閲覧モードに戻したら、選択中の枠やドラッグ中の範囲を消す
  onClipModeChange = () => {
    if (clipping) return;
    cancelDrag?.();
    select(null);
    trail.length = 0;
  };
  readerCleanup = () => {
    closeClipPreview();
    document.removeEventListener("keydown", onKey, true);
    onClipModeChange = null;
    hint.textContent = hintDefault();
  };
}

/* ---------- ライブ表示：裏の本物の Chrome の画面を映して操作する ---------- */
let liveOk = false;
const liveReady = fetch("/api/live?status=1")
  .then((r) => r.json())
  .then((d) => (liveOk = !!d.enabled), () => false);
const liveIds = new Map(); // 本の URL → Promise<セッションID>
const liveFailed = new Set(); // ライブ表示で開けなかったページ（写し取り表示に切り替える）
function liveSize() {
  const body = $("#readerBody");
  let w = body.clientWidth, h = body.clientHeight;
  // まだ切り抜き画面を開いていないとき（本の説明を見ている間の下準備）は、だいたいの大きさで開く
  if (!w || !h || $("#reader").hidden) {
    w = innerWidth;
    h = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 60) - 110;
  }
  return { w, h, dpr: Math.min(2, devicePixelRatio || 1) };
}
function liveOpen(key, url = key) {
  if (!liveIds.has(key)) {
    const p = api("/api/live", { action: "open", url, ...liveSize() }).then((r) => r.id);
    p.catch(() => liveIds.delete(key));
    liveIds.set(key, p);
  }
  return liveIds.get(key);
}
function liveClose(key) {
  const p = liveIds.get(key);
  liveIds.delete(key);
  p?.then((id) => api("/api/live", { action: "close", id })).catch(() => {});
}
const modsOf = (e) => [e.altKey && "Alt", e.ctrlKey && "Control", e.metaKey && "Meta", e.shiftKey && "Shift"].filter(Boolean);
const MOUSE_BUTTONS = ["left", "middle", "right"];

async function renderLive(b, token, onFail) {
  const body = $("#readerBody");
  const hint = $("#readerHint");
  const status = $("#readerStatus");
  body.classList.add("page", "live");
  const img = el("img", { class: "live-frame", alt: "", draggable: "false" });
  const overlay = el("div", { class: "live-overlay" });
  const rangeBox = el("div", { class: "live-range", hidden: true });
  const input = el("textarea", { class: "live-input", "aria-label": "ページへの文字入力", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const loading = el("div", { class: "live-loading" }, el("div", { class: "wheel small", "aria-hidden": "true" }), el("p", {}, "ページを開いています…"));
  // 読み込み中の表示は、上のバーの高さを変えないよう画面の上端の細い線で出す
  const progress = el("div", { class: "live-progress", hidden: true, role: "status", "aria-label": "読み込み中" });
  const view = el("div", { class: "live-view" }, img, overlay, rangeBox, input, loading, progress);
  body.replaceChildren(view);

  let id;
  try {
    id = await liveOpen(b.url);
  } catch (err) {
    if (token === readerToken) onFail(err);
    return;
  }
  if (token !== readerToken) return;

  let alive = true;
  let cur = { url: b.url, title: b.title };
  let editable = false;
  const navBox = $("#liveNav");
  navBox.hidden = false;

  // ---- 入力を順番どおりに送る（マウスの移動などは最新のものだけ） ----
  const queue = [];
  let working = false;
  const enqueue = (o) => {
    const last = queue[queue.length - 1];
    if (o.coalesce && last?.coalesce === o.coalesce) {
      if (o.action === "wheel") (o.dx += last.dx), (o.dy += last.dy);
      queue[queue.length - 1] = o;
    } else queue.push(o);
    pump();
  };
  const pump = async () => {
    if (working) return;
    working = true;
    while (queue.length && alive) {
      const { coalesce, then, ...msg } = queue.shift();
      try {
        const r = await api("/api/live", { id, ...msg });
        if (alive) then?.(r);
      } catch (err) {
        if (err.status === 404) return reopen();
      }
    }
    working = false;
  };
  // 裏のタブが閉じられていたら（しばらく使わなかった等）、最後に見ていたページで開き直す
  let reopening = false;
  const reopen = () => {
    if (reopening || !alive) return;
    reopening = true;
    cleanup();
    liveIds.delete(b.url);
    liveOpen(b.url, cur.url);
    renderLive(b, token, onFail);
  };

  // ---- 画面を受け取る ----
  const es = new EventSource(`/api/live?id=${encodeURIComponent(id)}&code=${encodeURIComponent(getCode())}`);
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "frame") {
      img.src = `data:image/jpeg;base64,${m.data}`;
      loading.hidden = true;
    } else if (m.t === "nav") {
      cur = { url: m.url, title: m.title || cur.title };
      if (m.title) $("#readerTitle").textContent = m.title;
      $("#readerOpen").href = safeUrl(m.url);
      $("#liveBack").disabled = !m.back;
      $("#liveFwd").disabled = !m.fwd;
      progress.hidden = !m.loading;
      clearMarks();
    } else if (m.t === "error" && loading.hidden === false) {
      loading.querySelector("p").textContent = "ページを開けませんでした。";
    } else if (m.t === "closed") reopen();
  };
  es.onerror = () => es.readyState === EventSource.CLOSED && reopen();

  // ---- 大きさを合わせる ----
  let sized = "";
  const resize = () => {
    const r = view.getBoundingClientRect();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (!r.width || !r.height || key === sized) return;
    sized = key;
    enqueue({ action: "resize", w: r.width, h: r.height, dpr: Math.min(2, devicePixelRatio || 1), coalesce: "resize" });
  };
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });
  ro.observe(view);
  resize();

  const pos = (e) => {
    const r = view.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };

  // ---- 切り抜きの枠の表示 ----
  let marks = [];
  const clearMarks = () => {
    marks.forEach((n) => n.remove());
    marks = [];
  };
  const showRects = (rects = []) => {
    clearMarks();
    marks = rects.map((r) => el("div", { class: "live-hl", style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` }));
    overlay.append(...marks);
  };

  // ---- 切り抜きモード ----
  let level = 0;
  let canUp = false;
  let point = null;
  let drag = null;
  const pointAt = (p) =>
    enqueue({
      action: "point",
      x: p.x,
      y: p.y,
      level,
      coalesce: "point",
      then: (r) => {
        if (drag?.active || clipPreview) return;
        showRects(r?.rects);
        canUp = !!r?.canUp;
        hint.textContent = r ? `${r.label} を選択中 ― クリックで切り抜く／↑↓キーで広げる・狭める／ドラッグで範囲を囲む` : hintDefault();
      },
    });
  const rectOf = (a, z) => ({ left: Math.min(a.x, z.x), top: Math.min(a.y, z.y), right: Math.max(a.x, z.x), bottom: Math.max(a.y, z.y) });
  const clipSelected = (count) =>
    enqueue({
      action: "clip",
      then: (r) => {
        if (r.error) {
          clearMarks();
          return toast(r.error);
        }
        let html;
        try {
          html = finishClip(r.html);
        } catch (err) {
          clearMarks();
          return toast(err.message);
        }
        openClipPreview({
          html,
          w: r.w,
          count: r.count,
          onConfirm: (comment) => {
            addCard({ type: "clip", styled: true, html, src: { title: r.title || cur.title, url: r.url || cur.url }, w: r.w, comment });
            enqueue({ action: "mark" });
            toast(r.count > 1 ? `囲んだ ${r.count} か所をまとめて貼りました` : "元のデザインのまま貼りました");
          },
          onClose: clearMarks, // プレビューを閉じたら枠を消す
        });
      },
    });
  const cancelDrag = () => {
    if (!drag?.active) return (drag = null), false;
    drag = null;
    rangeBox.hidden = true;
    clearMarks();
    hint.textContent = hintDefault();
    return true;
  };

  // ---- マウス ----
  let pressed = false; // ページの上で押したボタン（ツールバーのクリックをページへ送らないように）
  overlay.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pressed = true;
    input.focus({ preventScroll: true });
    const p = pos(e);
    if (clipping) {
      if (e.button === 0) drag = { start: p, active: false };
      return;
    }
    if (e.button > 2) return;
    // 日本語入力の候補が、クリックした場所の近くに出るように
    Object.assign(input.style, { left: `${p.x}px`, top: `${p.y}px` });
    editable = false; // ページからの答えが来るまでは、文字入力欄の外とみなす
    enqueue({ action: "mouse", type: "mousePressed", ...p, button: MOUSE_BUTTONS[e.button], clickCount: e.detail || 1, mods: modsOf(e), then: (r) => (editable = !!r?.editable) });
  });
  overlay.addEventListener("mousemove", (e) => {
    const p = pos(e);
    if (!clipping) {
      return enqueue({
        action: "mouse",
        type: "mouseMoved",
        ...p,
        buttons: e.buttons,
        button: e.buttons & 1 ? "left" : "none",
        coalesce: "move",
        then: (r) => r && (overlay.style.cursor = r.cursor),
      });
    }
    if (clipPreview) return;
    if (drag) {
      if (!drag.active && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 8) return;
      drag.active = true;
      drag.end = p;
      const r = rectOf(drag.start, p);
      rangeBox.hidden = false;
      Object.assign(rangeBox.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      enqueue({
        action: "range",
        rect: r,
        coalesce: "range",
        then: (res) => {
          if (!drag?.active) return;
          showRects(res.rects);
          hint.textContent = `${res.rects.length} か所を選択中 ― 離すと切り抜く／Esc でやめる`;
        },
      });
      return;
    }
    if (point && Math.hypot(p.x - point.x, p.y - point.y) < 4) return;
    point = p;
    level = 0;
    pointAt(p);
  });
  const onUp = (e) => {
    if (!pressed) return;
    pressed = false;
    if (clipping) {
      if (!drag || e.button !== 0) return;
      const d = drag;
      drag = null;
      rangeBox.hidden = true;
      if (d.active) {
        enqueue({ action: "range", rect: rectOf(d.start, pos(e)), then: (res) => showRects(res.rects) });
        clipSelected();
      } else {
        point = pos(e);
        enqueue({ action: "point", ...point, level, then: (r) => showRects(r?.rects) });
        clipSelected();
      }
      hint.textContent = hintDefault();
      return;
    }
    if (e.button > 2) return;
    enqueue({ action: "mouse", type: "mouseReleased", ...pos(e), button: MOUSE_BUTTONS[e.button], clickCount: e.detail || 1, mods: modsOf(e), then: (r) => (editable = !!r?.editable) });
  };
  window.addEventListener("mouseup", onUp);
  overlay.addEventListener("contextmenu", (e) => e.preventDefault());
  overlay.addEventListener("mouseleave", () => {
    if (clipping && !drag && !clipPreview) {
      clearMarks();
      point = null;
      hint.textContent = hintDefault();
    }
  });
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.clientHeight : 1;
      if (clipping && !clipPreview) {
        clearMarks();
        point = null;
      }
      enqueue({ action: "wheel", ...pos(e), dx: e.deltaX * unit, dy: e.deltaY * unit, coalesce: "wheel" });
    },
    { passive: false }
  );

  // ---- キーボード（閲覧モード：ページへ送る） ----
  const flushText = () => {
    const t = input.value;
    input.value = "";
    if (t) enqueue({ action: "text", text: t });
  };
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || clipPreview) return;
    if (e.key === "Escape") return; // 切り抜き画面を閉じる（下の onKey）
    const mods = modsOf(e);
    // C キーで閲覧／切り抜きを切り替える（ページの文字入力欄にいるときは文字として送る）
    if (!mods.length && /^c$/i.test(e.key) && (clipping || !editable)) {
      e.preventDefault();
      return setClipMode(!clipping);
    }
    if (clipping) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    // ⌘V（貼り付け）や、ブラウザ自身のショートカットはそのまま
    if ((e.metaKey || e.ctrlKey) && /^[vrwtqlnf]$/i.test(e.key)) return;
    const printable = e.key.length === 1;
    // 文字入力欄の外では、スペースや矢印でスクロールできるようキーとして送る
    if (!printable || mods.some((m) => m !== "Shift") || !editable) {
      e.preventDefault();
      enqueue({ action: "key", key: e.key, mods });
    }
  });
  input.addEventListener("input", (e) => !e.isComposing && flushText());
  input.addEventListener("compositionend", flushText);
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData("text/plain");
    if (t) enqueue({ action: "text", text: t });
  });

  // ---- 切り抜き画面全体のキー ----
  const onKey = (e) => {
    if ($("#reader").hidden || handleReaderKey(e, cancelDrag)) return;
    if (!clipping || !point) return;
    if (e.key === "ArrowUp" && canUp) {
      e.preventDefault();
      level++;
      pointAt(point);
    } else if (e.key === "ArrowDown" && level > 0) {
      e.preventDefault();
      level--;
      pointAt(point);
    } else if (e.key === "Enter") {
      e.preventDefault();
      enqueue({ action: "point", ...point, level });
      clipSelected();
    }
  };
  document.addEventListener("keydown", onKey, true);

  $("#liveBack").onclick = () => enqueue({ action: "nav", op: "back" });
  $("#liveFwd").onclick = () => enqueue({ action: "nav", op: "forward" });
  $("#liveReload").onclick = () => enqueue({ action: "nav", op: "reload" });

  onClipModeChange = () => {
    cancelDrag();
    clearMarks();
    point = null;
    overlay.style.cursor = "";
    input.focus({ preventScroll: true });
  };
  const cleanup = () => {
    if (!alive) return;
    alive = false;
    es.close();
    ro.disconnect();
    clearTimeout(resizeTimer);
    window.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKey, true);
    closeClipPreview();
    onClipModeChange = null;
    navBox.hidden = true;
    body.classList.remove("live");
    status.textContent = "";
    status.classList.remove("busy");
    hint.textContent = hintDefault();
  };
  readerCleanup = cleanup;
  hint.textContent = hintDefault();
  input.focus({ preventScroll: true });
}

// 閲覧モードでリンクをクリックしたら、そのページもリーダーの新しいタブで開く
// （元サイトへそのまま移動すると、スクリプト除去や切り抜きの仕組みから外れてしまうため）
function followLink(e, pageUrl) {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const raw = a.getAttribute("href") || "";
  let u;
  try {
    u = new URL(a.href, pageUrl);
  } catch {
    return;
  }
  const doc = a.ownerDocument;
  const here = new URL(pageUrl);
  // 同じページ内の見出しへのリンクは、その場でスクロールする
  if (raw.startsWith("#") || (u.origin === here.origin && u.pathname === here.pathname && u.search === here.search)) {
    const id = decodeURIComponent(u.hash.slice(1));
    (id && (doc.getElementById(id) || doc.getElementsByName(id)[0]))?.scrollIntoView();
    return;
  }
  if (!/^https?:$/.test(u.protocol)) return;
  u.hash = "";
  const title = (a.textContent || a.title || "").replace(/\s+/g, " ").trim().slice(0, 80) || u.hostname;
  openReader({ title, url: u.href });
  pushNav();
}

// スクリプトで閉じるはずのクッキー同意・モーダルなど、画面を覆う固定要素を取り除く
function unblockPage(doc) {
  const win = doc.defaultView;
  if (!win) return;
  const vw = win.innerWidth, vh = win.innerHeight;
  let removed = false;
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.7], [0.5, 0.9]]) {
    for (const n of doc.elementsFromPoint(vw * fx, vh * fy)) {
      if (n === doc.body || n === doc.documentElement) break;
      const cs = win.getComputedStyle(n);
      if (cs.position !== "fixed") continue;
      const r = n.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.3) {
        n.style.setProperty("display", "none", "important");
        removed = true;
      }
    }
  }
  // 覆いを消したら、モーダル用に止められていたスクロールも戻す
  if (removed || win.getComputedStyle(doc.body).overflowY === "hidden") {
    for (const n of [doc.documentElement, doc.body]) n.style.setProperty("overflow-y", "auto", "important");
  }
}

function renderSimple(page, fallback) {
  const body = $("#readerBody");
  body.classList.remove("page");
  body.scrollTop = 0;
  {
    const { title, blocks } = extractBlocks(page.html, page.url);
    if (!blocks.length) return fallback("このページからは切り抜ける部分が見つかりませんでした。");
    $("#readerTitle").textContent = title;
    const url = page.url;
    const col = el("div", { class: "column" });
    for (const html of blocks) {
      const block = el("div", { class: "clip", tabindex: "0" });
      block.innerHTML = html;
      const doClip = (e) => {
        if (!clipping) return e.type === "click" && followLink(e, url);
        e.preventDefault();
        if (block.classList.contains("clipped")) return;
        block.classList.add("clipped");
        addCard({ type: "clip", html, src: { title, url } });
        toast("スクラップボードに貼りました");
      };
      block.addEventListener("click", doClip);
      block.addEventListener("keydown", (e) => e.key === "Enter" && doClip(e));
      col.append(block);
    }
    body.replaceChildren(col);
  }
}

/* =========================================================
   HTMLスクラップボード
   ========================================================= */
const STORE = "charinco.board.v1";
let board = { cards: [], links: [] };
{
  const saved = store.getJSON(STORE);
  if (saved?.cards) board = saved;
}
const save = () => {
  if (store.set(STORE, board)?.name === "QuotaExceededError")
    toast("保存容量がいっぱいです。いくつかカードをはがすか「HTMLとして保存」してください");
  $("#boardCount").textContent = board.cards.length;
  $("#boardEmpty").hidden = board.cards.length > 0;
};

const uid = () => Math.random().toString(36).slice(2, 10);

function addCard(card) {
  const scroll = $("#boardScroll");
  const n = board.cards.length;
  // 画面に見えている範囲の近くに、少しずつずらして貼る
  const vx = -panX / zoom;
  const vy = -panY / zoom;
  const vw = (scroll.clientWidth || 1000) / zoom;
  card = {
    id: uid(),
    x: Math.round(vx + 40 + ((n * 300) % Math.max(320, vw - 320)) + Math.random() * 30),
    y: Math.round(vy + 30 + Math.floor((n * 300) / Math.max(320, vw - 320)) % 3 * 260 + Math.random() * 30),
    w: card.type === "note" ? 220 : 280,
    h: null,
    rot: +(Math.random() * 4 - 2).toFixed(2),
    ...card,
  };
  board.cards.push(card);
  save();
  renderBoard();
  return card;
}

// 拡張機能（extension/bridge.js）から届くもの
addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const { charincoExt: type, view, card } = e.data || {};
  // ツールバーの「図書館へ」「ボードへ」
  if (type === "view" && ["library", "board"].includes(view)) $(`.tabs button[data-view="${view}"]`)?.click();
  if (type === "clip") pasteFromExtension(card || {});
});
// 拡張機能で切り抜いたものをボードに貼る
function pasteFromExtension(c) {
  let html;
  try {
    html = finishClip(String(c.html || ""));
  } catch (err) {
    return toast(err.message);
  }
  if (!html.trim()) return;
  const url = httpUrl(c.url) ?? "";
  addCard({
    type: "clip",
    styled: true,
    html,
    src: { title: String(c.title || url).slice(0, 200), url },
    w: clipCardWidth(Number(c.w) || 320),
    comment: String(c.comment || "").slice(0, 2000),
  });
  toast(`「${String(c.title || "ページ").slice(0, 30)}」から切り抜いて貼りました`);
}

function pinBook(b) {
  addCard({
    type: "book",
    html: clean(`<h3>${escapeHtml(b.title)}</h3><p>${escapeHtml(b.snippet || "")}</p>`),
    src: { title: b.title, url: b.url },
  });
  toast("カードを貼りました");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

let linking = false;
let selected = null;
const ro = new ResizeObserver((entries) => {
  let changed = false;
  for (const e of entries) {
    const card = board.cards.find((c) => c.id === e.target.dataset.id);
    if (!card) continue;
    // CSS resize は style の width/height を書き換える
    const w = parseInt(e.target.style.width, 10) || card.w;
    const h = parseInt(e.target.style.height, 10) || null;
    if (card.w !== w || card.h !== h) {
      card.w = w;
      card.h = h;
      changed = true;
    }
  }
  drawStrings();
  if (changed) save();
});

// 切り抜きカードのコメント欄（なければ「＋ コメント」ボタンだけ出す）
function commentBox(card) {
  const wrap = el("div", { class: "comment-wrap" });
  const showButton = () =>
    wrap.replaceChildren(el("button", { class: "add-comment", onclick: () => showEditor(true) }, "＋ コメント"));
  const showEditor = (focus) => {
    const box = el("div", { class: "comment", contenteditable: "plaintext-only", "aria-label": "コメント", "data-placeholder": "コメントを書く…" });
    box.textContent = card.comment || "";
    box.addEventListener("input", () => {
      card.comment = box.innerText.trim();
      save();
    });
    box.addEventListener("blur", () => {
      if (!card.comment) {
        delete card.comment;
        save();
        showButton();
      }
    });
    box.addEventListener("pointerdown", (e) => linking && e.preventDefault());
    wrap.replaceChildren(box);
    if (focus) box.focus();
  };
  card.comment ? showEditor(false) : showButton();
  return wrap;
}

function renderBoard() {
  const b = $("#board");
  ro.disconnect();
  $$(".card", b).forEach((n) => n.remove());
  for (const card of board.cards) {
    const content = el("div", { class: "content" });
    if (card.type === "note") {
      content.contentEditable = "true";
      content.dataset.placeholder = "メモを書く…";
      content.setAttribute("aria-label", "付箋");
      content.textContent = card.text || "";
      content.addEventListener("input", () => {
        card.text = content.innerText;
        save();
      });
      content.addEventListener("pointerdown", (e) => linking && e.preventDefault());
    } else {
      content.innerHTML = card.styled ? cleanStyled(card.html || "") : clean(card.html || "");
    }
    const node = el(
      "div",
      {
        class: `card ${card.type}${card.styled ? " styled" : ""}${selected === card.id ? " selected" : ""}`,
        "data-id": card.id,
        style: `left:${card.x}px;top:${card.y}px;width:${card.w}px;${card.h ? `height:${card.h}px;` : ""}--rot:${card.rot}deg`,
      },
      el("span", { class: "grip", title: "ドラッグで動かす" }),
      el("button", { class: "del", title: "はがす", onclick: () => removeCard(card.id) }, "×"),
      content,
      card.type === "note" ? null : commentBox(card),
      card.src ? el("a", { class: "src", href: safeUrl(card.src.url), target: "_blank", rel: "noopener noreferrer" }, `出典：${card.src.title}`) : null
    );
    node.addEventListener("pointerdown", (e) => startDrag(e, card, node));
    node.addEventListener("click", (e) => linking && pickForLink(e, card));
    // 付箋は持ち手と×以外のどこを押しても書ける（文字の外を押したら末尾から続けて書く）
    if (card.type === "note")
      node.addEventListener("click", (e) => {
        if (linking || e.target.closest(".grip,.del") || content.contains(e.target)) return;
        content.focus();
        const sel = getSelection();
        sel.selectAllChildren(content);
        sel.collapseToEnd();
      });
    b.append(node);
    ro.observe(node);
  }
  drawStrings();
  save();
}

/* ---------- ボードの拡大縮小・移動（無限キャンバス） ---------- */
// 表示域（#boardScroll）は固定し、ボードを translate(panX, panY) scale(zoom) で動かす。
// panX/panY は「ボードの原点(0,0)が表示域のどこに来るか」（画面px）
const ZOOM_MIN = 0.25, ZOOM_MAX = 2;
const VIEW_KEY = "charinco-view";
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
let zoom = 1, panX = 0, panY = 0;
{
  const v = store.getJSON(VIEW_KEY);
  if (v) {
    zoom = clampZoom(Number(v.zoom) || 1);
    panX = Number(v.x) || 0;
    panY = Number(v.y) || 0;
  } else {
    zoom = clampZoom(Number(store.get("charinco-zoom")) || 1); // 前の版で保存した倍率
  }
}
let viewSaveTimer = 0;
const saveView = () => {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => store.set(VIEW_KEY, { zoom, x: Math.round(panX), y: Math.round(panY) }), 200);
};
function applyView() {
  $("#board").style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  const sc = $("#boardScroll");
  sc.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
  sc.style.backgroundPosition = `${panX}px ${panY}px`;
  $("#zoomReset").textContent = `${Math.round(zoom * 100)}%`;
  saveView();
}
// anchor（画面上の点）の下にあるボード上の位置が動かないように拡大縮小する
function setZoom(z, anchor = null) {
  const sc = $("#boardScroll");
  z = clampZoom(Math.round(z * 100) / 100);
  const r = sc.getBoundingClientRect();
  const ax = anchor ? anchor.clientX - r.left : sc.clientWidth / 2;
  const ay = anchor ? anchor.clientY - r.top : sc.clientHeight / 2;
  const bx = (ax - panX) / zoom, by = (ay - panY) / zoom;
  zoom = z;
  panX = ax - bx * z;
  panY = ay - by * z;
  applyView();
}
// すべてのカードが収まる倍率にして、その範囲を中央に表示する
function zoomToFit() {
  const nodes = $$(".card", $("#board"));
  if (!nodes.length) return goHome();
  const sc = $("#boardScroll");
  const x1 = Math.min(...nodes.map((n) => n.offsetLeft)) - 40;
  const y1 = Math.min(...nodes.map((n) => n.offsetTop)) - 40;
  const x2 = Math.max(...nodes.map((n) => n.offsetLeft + n.offsetWidth)) + 40;
  const y2 = Math.max(...nodes.map((n) => n.offsetTop + n.offsetHeight)) + 40;
  const fit = Math.min(sc.clientWidth / (x2 - x1), sc.clientHeight / (y2 - y1));
  zoom = Math.min(1, Math.max(ZOOM_MIN, Math.floor(fit * 100) / 100));
  panX = (sc.clientWidth - (x2 - x1) * zoom) / 2 - x1 * zoom;
  panY = (sc.clientHeight - (y2 - y1) * zoom) / 2 - y1 * zoom;
  applyView();
}
// 原点（最初にカードが貼られる左上）に戻る。倍率はそのまま
function goHome() {
  panX = 0;
  panY = 0;
  applyView();
}
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
function stepZoom(dir) {
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001);
  setZoom(next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN));
}
$("#zoomIn").addEventListener("click", () => stepZoom(1));
$("#zoomOut").addEventListener("click", () => stepZoom(-1));
$("#zoomReset").addEventListener("click", () => setZoom(1));
$("#zoomFit").addEventListener("click", zoomToFit);
$("#panHome").addEventListener("click", goHome);
// Ctrl/⌘ + ホイール、トラックパッドのピンチ（ブラウザには Ctrl + ホイールとして届く）で拡大縮小。
// それ以外のホイール／2本指スクロールはボードを動かす（スクロールできるカードの中身は除く）
$("#boardScroll").addEventListener(
  "wheel",
  (e) => {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // ピンチは小さな値が細かく届くので、少し強めに効かせる
      const k = Math.abs(dy) < 40 ? 0.01 : 0.0025;
      setZoom(zoom * Math.exp(-dy * k), e);
      return;
    }
    if (canScrollInside(e.target, dx, dy)) return;
    e.preventDefault();
    // Shift + ホイールは横に動かす
    panX -= e.shiftKey && !dx ? dy : dx;
    panY -= e.shiftKey && !dx ? 0 : dy;
    applyView();
  },
  { passive: false }
);
// カードの中身がまだその向きにスクロールできるなら、そちらを優先する
function canScrollInside(target, dx, dy) {
  for (let n = target; n && n.id !== "boardScroll"; n = n.parentElement) {
    if (!(n instanceof Element)) continue;
    const s = getComputedStyle(n);
    if (dy && /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) {
      if ((dy < 0 && n.scrollTop > 0) || (dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return true;
    }
    if (dx && /(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth) {
      if ((dx < 0 && n.scrollLeft > 0) || (dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1)) return true;
    }
  }
  return false;
}
// キーボード：+ / - / 0 / F / H（文字の入力中は除く）
document.addEventListener("keydown", (e) => {
  if ($("#view-board").hidden || !$("#reader").hidden || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
  if (e.key === "+" || e.key === "=") stepZoom(1);
  else if (e.key === "-") stepZoom(-1);
  else if (e.key === "0") setZoom(1);
  else if (e.key === "f" || e.key === "F") zoomToFit();
  else if (e.key === "h" || e.key === "H") goHome();
  else return;
  e.preventDefault();
});
// カードのない所をつかんでボードを動かす
$("#boardScroll").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".card,line") || linking) return;
  const sc = e.currentTarget;
  const sx = e.clientX, sy = e.clientY, ox = panX, oy = panY;
  sc.setPointerCapture(e.pointerId);
  sc.classList.add("panning");
  const move = (ev) => {
    panX = ox + (ev.clientX - sx);
    panY = oy + (ev.clientY - sy);
    applyView();
  };
  const up = () => {
    sc.classList.remove("panning");
    sc.removeEventListener("pointermove", move);
    sc.removeEventListener("pointerup", up);
    sc.removeEventListener("pointercancel", up);
  };
  sc.addEventListener("pointermove", move);
  sc.addEventListener("pointerup", up);
  sc.addEventListener("pointercancel", up);
});
applyView();

function startDrag(e, card, node) {
  if (!e.target.closest(".grip,.pin")) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = card.x, oy = card.y;
  node.style.zIndex = 4;
  node.setPointerCapture(e.pointerId);
  const move = (ev) => {
    // 拡大縮小しているときは、画面上の移動量をボード上の移動量に直す
    card.x = Math.round(ox + (ev.clientX - sx) / zoom);
    card.y = Math.round(oy + (ev.clientY - sy) / zoom);
    node.style.left = `${card.x}px`;
    node.style.top = `${card.y}px`;
    drawStrings();
  };
  const up = () => {
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", up);
    node.style.zIndex = "";
    // 最後に触ったカードを最前面に
    board.cards = [...board.cards.filter((c) => c !== card), card];
    save();
    $("#board").append(node);
  };
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
}

function removeCard(id) {
  board.cards = board.cards.filter((c) => c.id !== id);
  board.links = board.links.filter((l) => l.a !== id && l.b !== id);
  renderBoard();
}

function pickForLink(e, card) {
  if (e.target.closest(".del,a,.comment-wrap")) return;
  if (!selected) {
    selected = card.id;
  } else if (selected !== card.id) {
    const exists = board.links.some((l) => (l.a === selected && l.b === card.id) || (l.b === selected && l.a === card.id));
    if (!exists) board.links.push({ a: selected, b: card.id });
    selected = null;
    toast("糸でつなぎました（糸をクリックで切る）");
  } else selected = null;
  $$(".card").forEach((n) => n.classList.toggle("selected", n.dataset.id === selected));
  save();
  drawStrings();
}

// 糸はカードの中心同士を結ぶ。SVGはカードより下の層にあるので、どのカードの上にも重ならない
function drawStrings() {
  const svg = $("#strings");
  const SVG = "http://www.w3.org/2000/svg";
  const centers = {};
  for (const n of $$(".card", $("#board"))) {
    centers[n.dataset.id] = { x: n.offsetLeft + n.offsetWidth / 2, y: n.offsetTop + n.offsetHeight / 2 };
  }
  const els = [];
  for (const l of board.links) {
    const a = centers[l.a], b = centers[l.b];
    if (!a || !b) continue;
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.addEventListener("click", () => {
      board.links = board.links.filter((x) => x !== l);
      save();
      drawStrings();
    });
    els.push(line);
  }
  svg.replaceChildren(...els);
}

$("#addNote").addEventListener("click", () => {
  const card = addCard({ type: "note", text: "" });
  $(`.card[data-id="${card.id}"] .content`)?.focus();
});
$("#linkMode").addEventListener("click", (e) => {
  linking = !linking;
  selected = null;
  e.currentTarget.setAttribute("aria-pressed", String(linking));
  $("#board").classList.toggle("linking", linking);
  $$(".card").forEach((n) => n.classList.remove("selected"));
  if (linking) toast("つなぎたいカードを2枚クリック");
});
$("#clearBoard").addEventListener("click", () => {
  if (!board.cards.length || !confirm("ボードのカードをすべてはがしますか？")) return;
  board = { cards: [], links: [] };
  renderBoard();
});
$("#exportBoard").addEventListener("click", exportBoard);

function exportBoard() {
  if (!board.cards.length) return toast("まだ何も貼られていません");
  const nodes = $$(".card", $("#board"));
  // 無限キャンバスなので座標は負にもなる。すべてのカードが収まるようにずらして書き出す
  const ox = 60 - Math.min(...nodes.map((n) => n.offsetLeft));
  const oy = 60 - Math.min(...nodes.map((n) => n.offsetTop));
  const maxX = Math.max(...nodes.map((n) => n.offsetLeft + n.offsetWidth)) + ox + 60;
  const maxY = Math.max(...nodes.map((n) => n.offsetTop + n.offsetHeight)) + oy + 60;
  const cards = nodes
    .map((n) => {
      const c = board.cards.find((x) => x.id === n.dataset.id);
      const inner = c.type === "note" ? escapeHtml(c.text || "").replace(/\n/g, "<br>") : c.styled ? cleanStyled(c.html || "") : clean(c.html || "");
      const src = c.src ? `<a class="src" href="${escapeHtml(safeUrl(c.src.url))}">出典：${escapeHtml(c.src.title)}</a>` : "";
      const comment = c.comment ? `<div class="comment">${escapeHtml(c.comment).replace(/\n/g, "<br>")}</div>` : "";
      return `<div class="card ${c.type}${c.styled ? " styled" : ""}" style="left:${n.offsetLeft + ox}px;top:${n.offsetTop + oy}px;width:${n.offsetWidth}px;height:${n.offsetHeight}px;"><div class="content">${inner}</div>${comment}${src}</div>`;
    })
    .join("\n");
  const lines = $("#strings").innerHTML;
  const trail = state.trail.map((t) => escapeHtml(t.query)).join(" → ");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Charinco Search スクラップボード</title>
<style>
body{margin:0;font-family:"Hiragino Sans",sans-serif;background:#f8f6f1;color:#2b2620}
header{padding:12px 20px;background:#fff;border-bottom:1px solid #e4ddd0;font-size:13px;color:#6b6256}
.board{position:relative;width:${maxX}px;height:${maxY}px;background-color:#f8f6f1;background-image:radial-gradient(rgba(43,38,32,.13) 1px,transparent 1.3px);background-size:24px 24px}
svg{position:absolute;inset:0;width:100%;height:100%;z-index:1}line{stroke:#b5452f;stroke-width:1.5}
.card{position:absolute;z-index:2;box-sizing:border-box;background:#fff;border:1px solid #e4ddd0;border-radius:6px;box-shadow:0 1px 2px rgba(43,38,32,.06);padding:22px 16px 12px;font-size:13px;line-height:1.6;overflow:auto}
.card.note{background:#fff3b0;border-color:#e8d36a;font-size:15px;line-height:1.7}
.card:not(.styled) img{max-width:100%;height:auto}.card:not(.styled) p{margin:0 0 8px}.card:not(.styled) h1,.card:not(.styled) h2,.card:not(.styled) h3,.card:not(.styled) h4{font-size:16px;margin:0 0 6px}.card.styled{padding:22px 8px 8px}
.src{display:block;margin-top:10px;padding-top:6px;border-top:1px solid #e4ddd0;font-size:10.5px;color:#6b6256}
.comment{margin-top:10px;padding:6px 10px;border-left:3px solid #b5452f;background:#faf6ee;font-size:13px;line-height:1.6;white-space:pre-wrap;font-family:"Hiragino Sans",sans-serif;color:#2b2620}
</style></head><body><header><b>Charinco Search</b> スクラップボード ／ ${new Date().toLocaleString("ja-JP")}${trail ? ` ／ 寄り道：${trail}` : ""}</header>
<div class="board"><svg><g transform="translate(${ox} ${oy})">${lines}</g></svg>
${cards}
</div></body></html>`;
  const a = el("a", { href: URL.createObjectURL(new Blob([html], { type: "text/html" })), download: `charinco-scrapboard-${Date.now()}.html` });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

/* =========================================================
   画面切り替え・その他
   ========================================================= */
function showView(name, { keepScroll = false } = {}) {
  const changed = $(`#view-${name}`).hidden;
  $("#view-library").hidden = name !== "library";
  $("#view-board").hidden = name !== "board";
  updateTabs();
  if (changed && !keepScroll) window.scrollTo(0, 0);
  if (name === "board") drawStrings();
  return changed;
}
$$(".tabs button[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    // 切り抜き画面や本の説明を開いていても、そのまま図書館／ボードへ移れる
    const covered = !$("#reader").hidden || !$("#drawer").hidden;
    if (!$("#reader").hidden) hideReader();
    $("#drawer").hidden = true;
    if (showView(b.dataset.view) || covered) pushNav();
  })
);

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  explore({ query: $("#q").value, reset: true });
});

// トップの「たとえば」：開くたびに、この中から7つを選んで並べる
const EXAMPLES = [
  "作曲のアイデアの出し方", "レコードを掘る", "曲の印象を言葉にする", "都市の余白", "手紙という文化", "データセンターと街", "自転車の歴史",
  "路地裏の地図", "雑草の生き方", "銭湯のデザイン", "迷子になる楽しさ", "古着の流通", "夜の音", "失敗作の美術館",
  "標識の書体", "駄菓子屋の経済", "遊び場のつくり方", "日記を書く習慣", "雨の日の過ごし方", "まちの看板", "忘れられた道具",
  "鉄道の時刻表", "かたちの名前", "料理のレシピの書き方", "ゲームのルールを作る", "地図にない場所", "本屋の棚の並べ方",
  "眠りの文化", "ノイズと音楽", "壁の落書き", "庭のつくり方", "海辺のごみ", "数字の読み方", "名前の付け方", "影の表現",
  "なぜ人は集めるのか", "時計のない暮らし", "噂の広がり方", "色の名前", "階段のデザイン",
];
const shuffled = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
for (const ex of shuffled(EXAMPLES).slice(0, 7)) {
  $("#tryout").append(el("button", { onclick: () => explore({ query: ex, reset: true }) }, ex));
}

$$("[data-close]").forEach((b) => b.addEventListener("click", () => (b.closest(".reader") ? closeReader() : closeDrawer())));
$("#drawer").addEventListener("click", (e) => e.target.id === "drawer" && closeDrawer());
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#reader").hidden) closeReader();
  else if (!$("#drawer").hidden) closeDrawer();
});
renderPageTabs();
history.replaceState(navState(), "");

renderBoard();
