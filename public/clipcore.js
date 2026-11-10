// 切り抜きの中核：ページの中の要素を選び、元の見た目のまま持ち出せる HTML にする。
// 切り抜き画面（app.js）と、裏で動かしている本物の Chrome のページ（lib/live.js が注入）の両方で使う。
// どちらでも動くよう、ほかのファイルに頼らない普通のスクリプトにしてある。
(() => {
  if (globalThis.CharincoClip) return;

  const HL = "charinco-hl";
  const CLIPPED = "charinco-clipped";

  // 計算済みスタイルを書き写す対象
  const INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform", "text-indent", "white-space", "word-break", "writing-mode", "list-style-type"];
  const BOX = [
    "display",
    "background-color", "background-image", "background-size", "background-position", "background-repeat",
    "border-top", "border-right", "border-bottom", "border-left", "border-radius",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-bottom",
    "box-shadow", "text-decoration-line", "opacity", "vertical-align", "float", "clear",
    "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "object-fit",
  ];
  const MAX_NODES = 4000;

  // ブラウザ標準のスタイル（タグごと）。これと違う値だけを書き出す
  let uaDoc;
  const uaCache = new Map();
  function uaStyle(tag) {
    if (!uaDoc) {
      const f = document.createElement("iframe");
      f.setAttribute("aria-hidden", "true");
      f.tabIndex = -1;
      f.style.cssText = "position:absolute!important;width:0!important;height:0!important;border:0!important;visibility:hidden!important";
      document.documentElement.append(f);
      uaDoc = f.contentDocument;
      uaDoc.open();
      uaDoc.write("<!doctype html><html><head></head><body></body></html>");
      uaDoc.close();
    }
    if (!uaCache.has(tag)) {
      let n;
      try {
        n = uaDoc.createElement(tag);
      } catch {
        n = uaDoc.createElement("span");
      }
      uaDoc.body.append(n);
      const cs = uaDoc.defaultView.getComputedStyle(n);
      const snap = {};
      for (const p of [...INHERITED, ...BOX]) snap[p] = cs.getPropertyValue(p);
      n.remove();
      uaCache.set(tag, snap);
    }
    return uaCache.get(tag);
  }

  // keep を渡すと、それに当てはまらない要素（範囲選択の枠の外）は持ち出さない
  // trimText には、枠の外の文字を取り除く要素（枠内の要素の祖先）を渡す
  // 戻り値はサニタイズ前の HTML（サニタイズは切り抜き画面の側で行う）
  function serialize(root, keep = null, trimText = null) {
    const win = root.ownerDocument.defaultView;
    const origs = [root, ...root.querySelectorAll("*")];
    const kept = keep ? origs.filter(keep).length : origs.length;
    if (kept > MAX_NODES) throw new Error("範囲が大きすぎます。↓キーで狭めてください。");
    const marked = origs.filter((n) => n.classList.contains(HL) || n.classList.contains(CLIPPED));
    const saved = marked.map((n) => [n, n.className]);
    marked.forEach((n) => n.classList.remove(HL, CLIPPED));

    try {
      const clone = root.cloneNode(true);
      const clones = [clone, ...clone.querySelectorAll("*")];
      const styleCache = new Map();
      const computed = (n) => (styleCache.has(n) ? styleCache.get(n) : (styleCache.set(n, win.getComputedStyle(n)), styleCache.get(n)));
      const drop = [];
      origs.forEach((o, i) => {
        const c = clones[i];
        if (keep && o !== root && !keep(o)) return drop.push(c);
        if (trimText?.has(o)) for (const t of [...c.childNodes]) if (t.nodeType === 3 && t.textContent.trim()) t.remove();
        const cs = computed(o);
        if (cs.display === "none" || cs.visibility === "hidden" || (o !== root && cs.opacity === "0")) return drop.push(c);
        const parentCs = o === root || !o.parentElement ? null : computed(o.parentElement);
        const ua = uaStyle(o.localName);
        const uaPlain = uaStyle("span");
        const decl = [];
        for (const p of INHERITED) {
          const v = cs.getPropertyValue(p);
          // 見出しや<b>のようにブラウザ標準で値が決まるタグは、親と同じでも明示する
          const tagSets = ua[p] !== uaPlain[p];
          if (!parentCs || tagSets || parentCs.getPropertyValue(p) !== v) decl.push(`${p}:${v}`);
        }
        for (const p of BOX) {
          const v = cs.getPropertyValue(p);
          if (v && v !== ua[p]) decl.push(`${p}:${v}`);
        }
        if (o instanceof win.HTMLImageElement || o instanceof win.SVGSVGElement) {
          const r = o.getBoundingClientRect();
          decl.push(`width:${Math.round(r.width)}px`, "max-width:100%", "height:auto");
        }
        if (o instanceof win.HTMLImageElement) {
          c.setAttribute("src", o.currentSrc || o.src);
          c.removeAttribute("srcset");
          c.removeAttribute("sizes");
          c.removeAttribute("loading");
        }
        // canvas は画像にして持ち出す
        if (o instanceof win.HTMLCanvasElement) {
          try {
            const img = root.ownerDocument.createElement("img");
            img.setAttribute("src", o.toDataURL("image/png"));
            const r = o.getBoundingClientRect();
            decl.push(`width:${Math.round(r.width)}px`, "max-width:100%", "height:auto");
            c.replaceWith(img);
            clones[i] = img;
            img.setAttribute("style", decl.join(";"));
            return;
          } catch {}
        }
        if (o instanceof win.HTMLAnchorElement && o.href) c.setAttribute("href", o.href);
        c.removeAttribute("style");
        if (decl.length) c.setAttribute("style", decl.join(";"));
      });
      // 切り抜いた範囲の背景が透明なら、実際に見えていた背景色を持ってくる
      const transparent = (v) => v === "rgba(0, 0, 0, 0)" || v === "transparent";
      let bgNode = root;
      while (bgNode && transparent(win.getComputedStyle(bgNode).backgroundColor)) bgNode = bgNode.parentElement;
      const bg = bgNode ? win.getComputedStyle(bgNode).backgroundColor : "#fff";
      const own = computed(root).backgroundColor;
      if (clone.style) {
        clone.style.setProperty("background-color", transparent(own) ? bg : own);
        clone.style.setProperty("margin", "0");
        clone.style.setProperty("max-width", "100%");
        clone.style.setProperty("box-sizing", "border-box");
      }
      drop.forEach((n) => n.remove());
      clone.querySelectorAll("source").forEach((n) => n.remove());
      return clone.outerHTML;
    } finally {
      saved.forEach(([n, cls]) => (n.className = cls));
    }
  }

  // インライン要素の上にいるときは、それを含むブロックを選ぶ
  function blockOf(t) {
    const win = t?.ownerDocument?.defaultView;
    while (t && t.tagName !== "BODY" && t.tagName !== "IMG" && win.getComputedStyle(t).display === "inline") t = t.parentElement;
    return t && !["BODY", "HTML"].includes(t.tagName) ? t : null;
  }

  // ドラッグの枠に少しでも掛かっている要素を、ひとかたまり（段落・見出し・画像など）単位で集める
  // rect は画面上の座標（getBoundingClientRect と同じ基準）
  function collectRange(doc, rect) {
    const win = doc.defaultView;
    const MEDIA = ["IMG", "SVG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "TABLE", "FIGURE"];
    const hits = (r) => r.width > 0 && r.height > 0 && r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
    // 段落は回り込んだ画像の下まで箱が伸びていることがあるので、文字や画像が実際に描かれている場所で判定する。
    // 1行ずつ確かめる（全体をまとめた長方形だと、画面外に置かれた読み上げ用の文字などで大きく広がってしまう）
    const range = doc.createRange();
    const drawnHits = (n) => {
      if (MEDIA.includes(n.tagName.toUpperCase())) return hits(n.getBoundingClientRect());
      range.selectNodeContents(n);
      const rs = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      return rs.length ? rs.some(hits) : hits(n.getBoundingClientRect());
    };
    const contains = (r) => r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom;
    // 中にブロック要素を持たない要素（段落・見出し・ボタンなど）は、それ以上分けない
    const isUnit = (n) => {
      if (MEDIA.includes(n.tagName.toUpperCase())) return true;
      for (const c of n.children) {
        const d = win.getComputedStyle(c).display;
        if (d !== "none" && !d.startsWith("inline") && d !== "contents") return false;
        if (d === "contents" && !isUnit(c)) return false;
      }
      return true;
    };
    const picked = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.id === "charinco-range") continue;
        const cs = win.getComputedStyle(c);
        // 透明な要素（閉じているポップアップ等）は見えていないので拾わない
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
        if (cs.display === "contents") {
          walk(c);
          continue;
        }
        const r = c.getBoundingClientRect();
        // 箱の外にはみ出した子要素（position:absolute 等）も拾えるよう、箱が当たらなくても描画範囲で確かめる
        if (!hits(r) && !drawnHits(c)) continue;
        if (isUnit(c) || contains(r)) {
          if (drawnHits(c)) picked.push(c);
        } else walk(c);
      }
    };
    if (doc.body) walk(doc.body);
    return picked;
  }

  // 集めた要素を、共通の親ごと1枚のカードにする（枠に掛からなかった兄弟は持ち出さない）
  function serializePicked(picked) {
    if (picked.length === 1) return serialize(picked[0]);
    const doc = picked[0].ownerDocument;
    let root = picked[0].parentElement;
    while (root && !picked.every((n) => root.contains(n))) root = root.parentElement;
    if (!root || root === doc.documentElement) root = doc.body;
    const pickedSet = new Set(picked);
    const ancestors = new Set();
    for (const n of picked) for (let p = n.parentElement; p && p !== root; p = p.parentElement) ancestors.add(p);
    const keep = (o) => {
      if (ancestors.has(o) || pickedSet.has(o)) return true;
      for (let p = o.parentElement; p && p !== root; p = p.parentElement) if (pickedSet.has(p)) return true;
      return false;
    };
    return serialize(root, keep, new Set([root, ...ancestors]));
  }

  // カードの幅（切り抜いた範囲の幅に合わせる）
  function cardWidth(nodes) {
    const rs = nodes.map((n) => n.getBoundingClientRect());
    const w = Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left));
    return Math.max(200, Math.min(560, Math.round(w) + 16));
  }

  globalThis.CharincoClip = { HL, CLIPPED, serialize, serializePicked, blockOf, collectRange, cardWidth };
})();
