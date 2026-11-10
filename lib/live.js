// 裏で動かしている本物の Chrome のタブ（ライブ表示）。
// 切り抜き画面にはこのタブの画面を流し、クリック・スクロール・キー入力をここへ中継する。
// 切り抜くときは、このタブのページの中で clipcore.js を動かして要素を取り出す。
import fs from "node:fs";
import crypto from "node:crypto";
import { HttpError } from "./claude.js";
import { getBrowser, BLOCKED_URLS, isPrivateHost, UA, renderEnabled } from "./render.js";

const CORE = fs.readFileSync(new URL("../public/clipcore.js", import.meta.url), "utf8");
// 広告・計測・Cookie バナーだけ止める（画像やフォントは本物のブラウザと同じく読む）
const AD_URLS = BLOCKED_URLS.filter((p) => !/^\*\.\w+\*$/.test(p));
const MAX_SESSIONS = 5;
const IDLE_MS = 5 * 60 * 1000;

const sessions = new Map(); // id → session

export const liveEnabled = () => renderEnabled();

const clampSize = (w, h, dpr) => ({
  width: Math.max(320, Math.min(2400, Math.round(Number(w) || 1280))),
  height: Math.max(240, Math.min(1600, Math.round(Number(h) || 800))),
  deviceScaleFactor: Math.max(1, Math.min(2, Number(dpr) || 1)),
});

function get(id) {
  const s = sessions.get(id);
  if (!s) throw new HttpError(404, "このページはもう閉じられています。");
  s.last = Date.now();
  return s;
}

function broadcast(s, msg) {
  for (const send of s.clients) send(msg);
}

async function navInfo(s) {
  const { page, cdp } = s;
  let back = false, fwd = false;
  try {
    const h = await cdp.send("Page.getNavigationHistory");
    back = h.currentIndex > 0 && h.entries[h.currentIndex - 1].url !== "about:blank";
    fwd = h.currentIndex < h.entries.length - 1;
  } catch {}
  return { t: "nav", url: page.url(), title: await page.title().catch(() => ""), back, fwd, loading: s.loading };
}
const pushNav = (s) => navInfo(s).then((m) => broadcast(s, m), () => {});

async function closeSession(s) {
  sessions.delete(s.id);
  broadcast(s, { t: "closed" });
  await s.page.close().catch(() => {});
}

// 使われていないタブは閉じる
setInterval(() => {
  for (const s of sessions.values()) if (!s.clients.size && Date.now() - s.last > IDLE_MS) closeSession(s);
}, 30000).unref();

export async function open({ url, w, h, dpr }, { assertPublicUrl, isPrivateIP }) {
  const u = new URL(url);
  await assertPublicUrl(u);
  // 数が多すぎるときは、いちばん長く使っていないタブから閉じる
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => (a.clients.size - b.clients.size) || a.last - b.last)[0];
    await closeSession(oldest);
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  const id = crypto.randomUUID();
  const s = { id, page, cdp: null, clients: new Set(), last: Date.now(), frame: null, loading: true, size: clampSize(w, h, dpr) };
  sessions.set(id, s);
  try {
    await page.setUserAgent(UA);
    await page.setViewport(s.size);
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en;q=0.8" });
    const cdp = (s.cdp = await page.createCDPSession());
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: AD_URLS });
    // ページ（とその中の iframe）の移動先だけ検査する：内部ネットワークへは行かせない
    await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
    cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
      let ok = false;
      try {
        const t = new URL(request.url);
        if (/^https?:$/.test(t.protocol) && !isPrivateHost(t.hostname, isPrivateIP)) {
          await assertPublicUrl(t);
          ok = true;
        }
      } catch {}
      cdp.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    });
    // 画面の変化をそのまま流す
    cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      s.frame = { t: "frame", data, w: metadata.deviceWidth, h: metadata.deviceHeight };
      broadcast(s, s.frame);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    // 新しいタブで開くリンクは、同じタブで開き直す
    page.on("popup", async (pop) => {
      try {
        await pop.waitForNavigation({ timeout: 8000 }).catch(() => {});
        const next = pop.url();
        await pop.close().catch(() => {});
        if (/^https?:/.test(next)) page.goto(next).catch(() => {});
      } catch {}
    });
    page.on("framenavigated", (f) => f === page.mainFrame() && ((s.loading = true), pushNav(s)));
    page.on("domcontentloaded", () => pushNav(s));
    page.on("load", () => ((s.loading = false), pushNav(s)));
    page.goto(u.href, { waitUntil: "load", timeout: 45000 }).catch((err) => {
      s.loading = false;
      broadcast(s, { t: "error", message: err.message });
      pushNav(s);
    });
    return { id };
  } catch (err) {
    await closeSession(s);
    throw err;
  }
}

// 画面を流す（Server-Sent Events）
export function stream(id) {
  const s = get(id);
  const enc = new TextEncoder();
  let send;
  const body = new ReadableStream({
    start(ctrl) {
      send = (msg) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {}
      };
      s.clients.add(send);
      // 見ているタブを前面に出す（裏のタブは画面が更新されないため）
      s.page.bringToFront().catch(() => {});
      if (s.frame) send(s.frame);
      pushNav(s);
    },
    cancel() {
      s.clients.delete(send);
      s.last = Date.now();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}

// ページの中で切り抜きの部品を使えるようにする（ページが移動するたびに入れ直す）
// （文字列のまま渡すと、サイトの CSP に関係なく実行できる）
async function inPage(s, fn, ...args) {
  const has = await s.page.evaluate(() => !!globalThis.CharincoClip);
  if (!has) await s.page.evaluate(CORE);
  return s.page.evaluate(fn, ...args);
}

const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export async function act(body) {
  const s = get(body.id);
  const { page, cdp } = s;
  switch (body.action) {
    case "close":
      await closeSession(s);
      return { ok: true };
    case "resize":
      s.size = clampSize(body.w, body.h, body.dpr);
      await page.setViewport(s.size);
      return { ok: true };
    case "nav": {
      const op = body.op;
      if (op === "back") page.goBack({ timeout: 30000 }).catch(() => {});
      else if (op === "forward") page.goForward({ timeout: 30000 }).catch(() => {});
      else if (op === "reload") page.reload({ timeout: 30000 }).catch(() => {});
      return { ok: true };
    }
    case "mouse": {
      // { type: mouseMoved|mousePressed|mouseReleased, x, y, button, clickCount, mods }
      const modifiers = (body.mods || []).reduce((m, k) => m | (MODS[k] || 0), 0);
      // マウスの移動は、ページが処理し終わるのを待たない（重いページだと1回に数秒かかり、操作が詰まる）。
      // 同じ接続で送るので、後のクリックより先に届く順番は変わらない
      const sent = cdp.send("Input.dispatchMouseEvent", {
        type: body.type,
        x: body.x,
        y: body.y,
        button: body.button || "none",
        buttons: body.type === "mouseMoved" ? body.buttons || 0 : undefined,
        clickCount: body.clickCount || 0,
        modifiers,
      });
      if (body.type === "mouseMoved") sent.catch(() => {});
      else await sent;
      // カーソルの形と、文字入力欄にフォーカスがあるか
      return page
        .evaluate(
          (x, y) => {
            const at = document.elementFromPoint(x, y);
            let cursor = at ? getComputedStyle(at).cursor : "auto";
            if (cursor === "auto" && at?.closest("a[href]")) cursor = "pointer";
            if (cursor === "auto" && at?.closest("input,textarea,[contenteditable]")) cursor = "text";
            const a = document.activeElement;
            const editable = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.tagName === "IFRAME");
            return { cursor, editable };
          },
          body.x,
          body.y
        )
        .catch(() => ({ cursor: "auto", editable: false }));
    }
    case "wheel":
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: body.x, y: body.y, deltaX: body.dx || 0, deltaY: body.dy || 0 });
      return { ok: true };
    case "key": {
      // 名前のあるキー（Enter, Backspace, ArrowDown …）と、修飾キー付きのショートカット
      const mods = (body.mods || []).filter((k) => k in MODS);
      try {
        for (const m of mods) await page.keyboard.down(m);
        await page.keyboard.press(body.key);
      } catch {
        if (body.key.length === 1 && !mods.length) await page.keyboard.sendCharacter(body.key);
      } finally {
        for (const m of mods.reverse()) await page.keyboard.up(m).catch(() => {});
      }
      return { ok: true };
    }
    case "text":
      // 日本語入力（確定した文字）もそのまま入れる
      await page.keyboard.sendCharacter(String(body.text || "").slice(0, 2000));
      return { ok: true };

    // ---- 切り抜き ----
    case "point":
      // 指した場所のブロック（level 段だけ親へ広げる）の位置
      return inPage(
        s,
        (x, y, level) => {
          const C = globalThis.CharincoClip;
          let n = C.blockOf(document.elementFromPoint(x, y));
          for (let i = 0; i < level && n?.parentElement && !["BODY", "HTML"].includes(n.parentElement.tagName); i++) n = n.parentElement;
          globalThis.__charincoSel = n ? [n] : [];
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { rects: [{ x: r.left, y: r.top, w: r.width, h: r.height }], label: `<${n.localName}> ${Math.round(r.width)}×${Math.round(r.height)}`, canUp: !!n.parentElement && !["BODY", "HTML"].includes(n.parentElement.tagName) };
        },
        Number(body.x),
        Number(body.y),
        Math.max(0, Math.min(30, Number(body.level) || 0))
      );
    case "range":
      // 枠に掛かっている要素
      return inPage(
        s,
        (rect) => {
          const picked = globalThis.CharincoClip.collectRange(document, rect);
          globalThis.__charincoSel = picked;
          return { rects: picked.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })) };
        },
        {
          left: Number(body.rect.left), top: Number(body.rect.top), right: Number(body.rect.right), bottom: Number(body.rect.bottom),
          width: Number(body.rect.right) - Number(body.rect.left), height: Number(body.rect.bottom) - Number(body.rect.top),
        }
      );
    case "clip":
      // 直前に選んだ要素（point / range）を、元の見た目のまま HTML にする
      return inPage(s, () => {
        const C = globalThis.CharincoClip;
        const picked = (globalThis.__charincoSel || []).filter((n) => n.isConnected);
        if (!picked.length) return { error: "切り抜ける部分がありませんでした" };
        try {
          return { html: C.serializePicked(picked), w: C.cardWidth(picked), count: picked.length, title: document.title, url: location.href };
        } catch (err) {
          return { error: err.message };
        }
      });
    case "mark":
      // 貼った部分に印を付ける（ページの上で、どこを切り抜いたか分かるように）
      await inPage(s, () => {
        for (const n of globalThis.__charincoSel || []) n.style.setProperty("outline", "2px solid #b5452f", "important"), n.style.setProperty("outline-offset", "2px", "important");
      });
      return { ok: true };
    default:
      throw new HttpError(400, "unknown action");
  }
}
