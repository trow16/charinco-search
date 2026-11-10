// ページの上で切り抜く：右下のツールバー、選択の枠、プレビュー。
// 要素の選び方と書き出しは clipcore.js（Charinco の切り抜き画面と同じもの）
(() => {
  if (globalThis.__charincoClipper) return;
  globalThis.__charincoClipper = true;
  const C = globalThis.CharincoClip;

  // ページの CSS の影響を受けないよう、UI は Shadow DOM の中に作る
  const host = document.createElement("charinco-clipper");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    /* .bar { display: flex } などより優先して、hidden を付けたものは必ず隠す */
    [hidden] { display: none !important; }
    .ui { font: 13px/1.5 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; color: #2b2622; }
    .bar { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px;
      background: #f5efe4; border: 1px solid #d8cdbb; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18); pointer-events: auto; }
    .bar b { font-family: Georgia, "Hiragino Mincho ProN", serif; font-size: 14px; margin-right: 4px; }
    .modes { display: flex; }
    .modes button, .bar .x, .bar .go { border: 1px solid #cbbfa9; background: #fff; padding: 5px 12px; font: inherit; color: inherit; cursor: pointer; }
    .modes button:first-child { border-radius: 6px 0 0 6px; }
    .modes button:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
    .modes button[aria-pressed="true"] { background: #b5452f; border-color: #b5452f; color: #fff; }
    .bar .go { border-radius: 6px; }
    .bar .x { border: 0; background: none; font-size: 18px; padding: 0 4px; color: #8a7f72; }
    .hint { position: fixed; right: 18px; bottom: 70px; max-width: 460px; padding: 6px 12px; border-radius: 8px; background: rgba(43,38,34,.88); color: #fff; font-size: 12px; pointer-events: none; }
    .hint:empty { display: none; }
    .hl { position: fixed; outline: 2px dashed #b5452f; outline-offset: 2px; background: rgba(181,69,47,.06); pointer-events: none; }
    .range { position: fixed; border: 2px dashed #b5452f; background: rgba(181,69,47,.08); pointer-events: none; }
    .toast { position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); padding: 10px 18px; border-radius: 10px; background: #2b2622; color: #fff; pointer-events: none; opacity: 0; transition: opacity .2s; }
    .toast.show { opacity: 1; }
    .shade { position: fixed; inset: 0; background: rgba(43,38,34,.35); display: flex; align-items: center; justify-content: center; pointer-events: auto; }
    .panel { width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: #f5efe4; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }
    .panel .head { padding: 12px 18px; font-size: 12px; color: #6b6158; border-bottom: 1px solid #e3d9c8; }
    .stage { flex: 1; overflow: auto; padding: 18px; background: #fff; }
    .card { margin: 0 auto; max-width: 100%; border: 1px solid #e3d9c8; border-radius: 10px; padding: 10px; background: #fff; overflow: hidden; }
    .card img { max-width: 100%; height: auto; }
    textarea { width: 100%; margin: 0; padding: 8px 10px; border: 1px solid #d8cdbb; border-radius: 8px; font: inherit; resize: vertical; background: #fff; color: inherit; }
    .note { padding: 12px 18px 0; }
    .actions { display: flex; align-items: center; gap: 10px; padding: 12px 18px; }
    .actions .keys { flex: 1; font-size: 11px; color: #8a7f72; }
    .actions button { border: 1px solid #2b2622; border-radius: 999px; padding: 6px 16px; font: inherit; background: #fff; color: #2b2622; cursor: pointer; }
    .actions .ok { background: #2b2622; color: #fff; }
  </style>
  <div class="ui">
    <div class="marks"></div>
    <div class="range" hidden></div>
    <div class="hint"></div>
    <div class="bar" hidden>
      <b>Charinco</b>
      <div class="modes"><button class="browse" aria-pressed="true">閲覧</button><button class="clip" aria-pressed="false">✂ 切り抜き</button></div>
      <button class="go lib" title="Charinco の図書館へ移る">図書館へ</button>
      <button class="go board" title="Charinco のスクラップボードへ移る">ボードへ</button>
      <button class="x" aria-label="ツールバーを閉じる" title="閉じる">×</button>
    </div>
    <div class="toast"></div>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const bar = $(".bar"), hintEl = $(".hint"), marksEl = $(".marks"), rangeEl = $(".range"), toastEl = $(".toast");
  document.documentElement.append(host);

  const HINT_CLIP = "クリックで切り抜く／↑↓で広げる・狭める／ドラッグで範囲を囲む／C か Esc で閲覧に戻る";
  let clipping = false;
  let current = null; // マウスの下のブロック
  const trail = []; // ↑で広げたときに戻るための履歴
  let drag = null;
  let preview = null;
  let shownMarks = []; // 枠を出している要素（スクロールしたら付いていく）

  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove("show"), 2600);
  };
  const drawMarks = () => {
    marksEl.replaceChildren(
      ...shownMarks.map((n) => {
        const r = n.getBoundingClientRect();
        const d = document.createElement("div");
        d.className = "hl";
        Object.assign(d.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        return d;
      })
    );
  };
  const mark = (nodes) => {
    shownMarks = nodes.filter(Boolean);
    drawMarks();
  };
  addEventListener("scroll", () => shownMarks.length && requestAnimationFrame(drawMarks), true);
  addEventListener("resize", () => shownMarks.length && drawMarks());

  function setClipping(on) {
    clipping = on;
    bar.hidden = false;
    $(".browse").setAttribute("aria-pressed", String(!on));
    $(".clip").setAttribute("aria-pressed", String(on));
    // 切り抜き中はマウスの下の要素を見るため、ページのカーソルを十字にする
    document.documentElement.style.cursor = on ? "crosshair" : "";
    hintEl.textContent = on ? HINT_CLIP : "";
    if (!on) {
      current = null;
      trail.length = 0;
      cancelDrag();
      mark([]);
    }
  }
  const showBar = (on) => {
    bar.hidden = !on;
    if (!on) setClipping(false), (bar.hidden = true);
  };
  $(".browse").addEventListener("click", () => setClipping(false));
  $(".clip").addEventListener("click", () => setClipping(true));
  $(".x").addEventListener("click", () => showBar(false));
  const goApp = (view) => chrome.runtime.sendMessage({ type: "focus-app", view }).then((r) => !r?.ok && toast("Charinco のタブが見つかりません"));
  $(".go.lib").addEventListener("click", () => goApp("library"));
  $(".go.board").addEventListener("click", () => goApp("board"));

  const ours = (e) => e.composedPath().includes(host);
  const describe = (n) => {
    const r = n.getBoundingClientRect();
    return `<${n.localName}> ${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const select = (n) => {
    current = n;
    mark(n ? [n] : []);
    hintEl.textContent = n ? `${describe(n)} を選択中 ― クリックで切り抜く／↑↓で広げる・狭める／ドラッグで範囲を囲む` : HINT_CLIP;
  };

  // ---- マウス（切り抜きモードのときだけ、ページより先に受け取る） ----
  const pagePoint = (e) => ({ x: e.clientX + scrollX, y: e.clientY + scrollY });
  const clientRect = (a, z) => {
    const x1 = Math.min(a.x, z.x) - scrollX, y1 = Math.min(a.y, z.y) - scrollY;
    const x2 = Math.max(a.x, z.x) - scrollX, y2 = Math.max(a.y, z.y) - scrollY;
    return { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1 };
  };
  const block = (e) => e.preventDefault() || e.stopPropagation() || e.stopImmediatePropagation();
  addEventListener(
    "mousedown",
    (e) => {
      if (!clipping || preview || ours(e) || e.button !== 0) return;
      block(e);
      drag = { start: pagePoint(e), active: false, last: e };
    },
    true
  );
  addEventListener(
    "mousemove",
    (e) => {
      if (!clipping || preview) return;
      // ページ自身のホバー表示（脚注のポップアップ等）を出さない：出ると範囲選択に混ざる
      if (!ours(e)) e.stopImmediatePropagation();
      if (drag) {
        drag.last = e;
        const p = pagePoint(e);
        if (!drag.active && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 8) return;
        drag.active = true;
        drag.end = p;
        // 枠が画面の端に来たら少しずつスクロールする
        if (e.clientY > innerHeight - 30) scrollBy(0, 24);
        else if (e.clientY < 30) scrollBy(0, -24);
        const r = clientRect(drag.start, p);
        rangeEl.hidden = false;
        Object.assign(rangeEl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        if (!drag.raf)
          drag.raf = requestAnimationFrame(() => {
            if (!drag?.active) return;
            drag.raf = 0;
            const picked = C.collectRange(document, clientRect(drag.start, drag.end));
            mark(picked);
            hintEl.textContent = `${picked.length} か所を選択中 ― 離すと切り抜く／Esc でやめる`;
          });
        return;
      }
      if (ours(e)) return;
      const n = C.blockOf(e.target);
      if (n && n !== current) {
        trail.length = 0;
        select(n);
      }
    },
    true
  );
  addEventListener(
    "mouseup",
    (e) => {
      if (!clipping || preview || !drag) return;
      block(e);
      const d = drag;
      drag = null;
      rangeEl.hidden = true;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (d.active) {
        const picked = C.collectRange(document, clientRect(d.start, d.end || pagePoint(e)));
        if (!picked.length) {
          mark([]);
          return toast("枠の中に切り抜ける部分がありませんでした");
        }
        clip(picked);
      } else if (current) clip([current]);
    },
    true
  );
  // 切り抜き中はリンクやボタンを動かさない
  for (const type of ["click", "dblclick", "auxclick", "contextmenu", "submit"])
    addEventListener(type, (e) => clipping && !ours(e) && block(e), true);
  // pointerdown を打ち消すと mousedown が来なくなるので、ページへ伝えないだけにする
  for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "mouseover", "mouseout"])
    addEventListener(type, (e) => clipping && !preview && !ours(e) && (e.stopPropagation(), e.stopImmediatePropagation()), true);

  function cancelDrag() {
    if (!drag) return false;
    const was = drag.active;
    drag = null;
    rangeEl.hidden = true;
    if (was) {
      mark(current ? [current] : []);
      hintEl.textContent = HINT_CLIP;
    }
    return was;
  }

  // ---- キー ----
  addEventListener(
    "keydown",
    (e) => {
      if (preview) {
        if (e.key === "Escape") return block(e), preview.close(false);
        // コメント欄では Enter は改行。⌘/Ctrl+Enter で貼る
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.composedPath().some((n) => n.localName === "textarea"))) return block(e), preview.close(true);
        return;
      }
      if (bar.hidden) return;
      const typing = e.composedPath().some((n) => n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || ""));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" || e.key === "C") return block(e), setClipping(!clipping);
      if (!clipping) return;
      if (e.key === "Escape") {
        block(e);
        if (!cancelDrag()) setClipping(false);
      } else if (e.key === "ArrowUp" && current?.parentElement && !["BODY", "HTML"].includes(current.parentElement.tagName)) {
        block(e);
        trail.push(current);
        select(current.parentElement);
      } else if (e.key === "ArrowDown" && trail.length) {
        block(e);
        select(trail.pop());
      } else if (e.key === "Enter" && current) {
        block(e);
        clip([current]);
      }
    },
    true
  );

  // ---- 切り抜いて、確かめて、貼る ----
  // プレビュー用：スクリプトや on* 属性を除いた安全なコピー（本番のサニタイズは Charinco 側で行う）
  function safeFragment(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll("script,style,link,iframe,object,embed,form,input,button,textarea,select,video,audio").forEach((n) => n.remove());
    for (const n of doc.body.querySelectorAll("*")) {
      for (const a of [...n.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
      n.removeAttribute("class");
      n.removeAttribute("id");
      for (const p of ["position", "z-index", "top", "left", "right", "bottom", "inset"]) n.style?.removeProperty(p);
    }
    const frag = document.createDocumentFragment();
    frag.append(...[...doc.body.childNodes].map((c) => document.importNode(c, true)));
    return frag;
  }

  function clip(picked) {
    let html;
    try {
      html = C.serializePicked(picked);
    } catch (err) {
      return toast(err.message);
    }
    const w = C.cardWidth(picked);
    mark(picked);
    const shade = document.createElement("div");
    shade.className = "shade";
    shade.innerHTML = `<div class="panel" role="dialog" aria-label="切り抜きのプレビュー">
      <div class="head"></div><div class="stage"><div class="card"></div></div>
      <div class="note"><textarea rows="2" placeholder="コメント（任意）：なぜ気になったか、何とつながりそうか…"></textarea></div>
      <div class="actions"><span class="keys">Enter で貼る（コメント入力中は ⌘/Ctrl+Enter）／Esc でやめる</span><button class="cancel">やめる</button><button class="ok">ボードに貼る</button></div>
    </div>`;
    shade.querySelector(".head").textContent = picked.length > 1 ? `${picked.length} か所をまとめて、このように貼ります` : "このように貼ります";
    const card = shade.querySelector(".card");
    card.style.width = `${w}px`;
    card.append(safeFragment(html));
    const note = shade.querySelector("textarea");
    root.querySelector(".ui").append(shade);
    shade.querySelector(".ok").focus();
    const close = async (ok) => {
      if (!preview) return;
      preview = null;
      shade.remove();
      hintEl.textContent = clipping ? HINT_CLIP : "";
      if (!ok) return mark(current ? [current] : []);
      // 貼った部分に印を付ける
      for (const n of picked) n.style.setProperty("outline", "2px solid #b5452f", "important"), n.style.setProperty("outline-offset", "2px", "important");
      mark([]);
      try {
        const r = await chrome.runtime.sendMessage({ type: "clip", card: { html, w, comment: note.value.trim(), title: document.title, url: location.href } });
        toast(r?.delivered ? "スクラップボードに貼りました" : "Charinco が開いていないので、次に開いたときに貼ります");
      } catch {
        toast("拡張機能に届きませんでした。ページを読み込み直してください");
      }
    };
    preview = { close };
    shade.addEventListener("click", (e) => e.target === shade && close(false));
    shade.querySelector(".cancel").addEventListener("click", () => close(false));
    shade.querySelector(".ok").addEventListener("click", () => close(true));
  }

  // ---- 拡張機能からの合図 ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") {
      if (bar.hidden) setClipping(true);
      else setClipping(!clipping);
    }
  });
  // Charinco から開いたタブなら、最初からツールバーを出す
  chrome.runtime.sendMessage({ type: "hello" }).then((r) => r?.show && showBar(true), () => {});
})();
