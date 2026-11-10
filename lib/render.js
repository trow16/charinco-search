// 本物の Chrome（ヘッドレス）でページを一度表示し、スクリプトが動いた後の姿を HTML として写し取る。
// 取得しただけの HTML では、JavaScript で組み立てるサイトや CSS-in-JS、遅延読み込みが再現できないため。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowedNavigation } from "./net.js";

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // 管理者の権限がない Mac では、自分のフォルダの「アプリケーション」に入れることがある
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1280, height: 900 };
const MAX_PARALLEL = 3;

export const renderEnabled = () => process.env.CHARINCO_RENDER !== "0" && !!findChrome();

let chromePath;
function findChrome() {
  if (chromePath === undefined) chromePath = CHROME_PATHS.find((p) => fs.existsSync(p)) || null;
  return chromePath;
}

let browserPromise = null;
export async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b?.connected) return b;
  }
  // 同時に呼ばれても Chrome は1つだけ起動する（先に Promise を置いてから待つ）
  browserPromise = (async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const opts = {
      executablePath: findChrome(),
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--lang=ja-JP"],
    };
    let b;
    try {
      // スクリプトや CSS をキャッシュに残し、同じサイトの2ページ目からは速く開けるようにする
      b = await puppeteer.launch({ ...opts, userDataDir: path.join(os.tmpdir(), `charinco-chrome-${process.env.PORT || 3000}`) });
    } catch {
      // キャッシュ用のフォルダが使用中（前の Chrome が残っている等）なら、使い捨てのフォルダで起動する
      b = await puppeteer.launch(opts);
    }
    b.on("disconnected", () => (browserPromise = null));
    return b;
  })();
  return browserPromise;
}

// 同時に開くタブ数を抑える
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ページの中で実行：スクリプトが作った状態を、スクリプト無しでも再現できる HTML に固める
function snapshotInPage() {
  const doc = document;
  // CSS-in-JS（insertRule で中身を入れる <style>）や adoptedStyleSheets を文字にする
  for (const st of doc.querySelectorAll("style")) {
    try {
      const rules = st.sheet?.cssRules;
      if (!rules) continue;
      const text = st.textContent || "";
      if (!text.trim() || rules.length > (text.match(/\{/g) || []).length) {
        st.textContent = [...rules].map((r) => r.cssText).join("\n");
      }
    } catch {}
  }
  try {
    for (const sheet of doc.adoptedStyleSheets || []) {
      const st = doc.createElement("style");
      st.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      doc.head.append(st);
    }
  } catch {}
  // 表示中の画像を固定（srcset から選ばれた1枚・遅延読み込み済みの src）
  for (const img of doc.images) {
    if (img.currentSrc && !img.currentSrc.startsWith("blob:")) img.setAttribute("src", img.currentSrc);
    img.removeAttribute("loading");
    if (img.currentSrc) {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.closest("picture")?.querySelectorAll("source").forEach((s) => s.remove());
    }
  }
  // canvas は画像に置き換える
  for (const c of doc.querySelectorAll("canvas")) {
    try {
      if (!c.width || !c.height) continue;
      const img = doc.createElement("img");
      img.src = c.toDataURL("image/png");
      img.className = c.className;
      img.setAttribute("style", (c.getAttribute("style") || "") + `;width:${c.clientWidth}px;height:${c.clientHeight}px`);
      c.replaceWith(img);
    } catch {}
  }
  // フォームの入力値
  for (const i of doc.querySelectorAll("input")) if (i.value && i.type !== "password") i.setAttribute("value", i.value);
  // 動画はポスターだけ残る（スクリプトなしでは再生できない）
  for (const v of doc.querySelectorAll("video")) v.removeAttribute("autoplay");
  // スクリプトは持ち出さない（表示側でも動かさない）
  doc.querySelectorAll("script, noscript").forEach((n) => n.remove());
  const dt = doc.doctype ? "<!doctype html>\n" : "";
  return { html: dt + doc.documentElement.outerHTML, base: doc.baseURI };
}

// 遅延読み込みとスクロール連動の表示を起こすため、下まで一度スクロールして戻る
async function autoScroll(page) {
  // 重いページでは1回のスクロールごとにスクリプトが走るので、回数と時間に上限を設ける
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = performance.now() + 1500;
    const step = innerHeight * 1.5;
    for (let i = 0; i < 12 && performance.now() < until; i++) {
      const before = scrollY;
      scrollBy(0, step);
      await sleep(60);
      if (scrollY === before) break;
    }
    scrollTo(0, 0);
  });
}

// 写し取りに不要で、読み込みを遅くするもの。
// 広告・計測のタグは、ページの組み立て（DOMContentLoaded）を何秒も止めることがあるので読ませない。
// Cookie 同意のバナーも、写し取ると本文の上に被さったまま残るので読ませない。
export const BLOCKED_URLS = [
  ...["woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "m3u8", "mp3"].map((e) => `*.${e}*`),
  ...["googletagmanager", "google-analytics", "doubleclick", "googlesyndication", "googleadservices", "adservice.google", "facebook",
    "hotjar", "clarity.ms", "criteo", "taboola", "outbrain", "amazon-adsystem", "scorecardresearch", "adnxs", "im-apps", "ad-stir",
    "i-mobile", "microad", "fout.jp", "logly", "popin", "krxd", "treasuredata", "newrelic", "nr-data", "sentry", "datadoghq", "cxense",
    "geoedge", "demdex", "impact-ad", "flux-cdn", "platform.twitter", "syndication.twitter", "youtube.com/embed", "player.vimeo",
    "geniee", "rtoaster", "fluct", "yieldone", "adingo", "prebid", "pubmatic", "rubiconproject", "openx.net", "adsrvr", "casalemedia",
    "teads", "smartadserver", "gssprt", "socdm", "ladsp", "yads.", "yjtag", "ptengine", "karte.io", "mouseflow", "bat.bing", "snap.licdn",
    "analytics.tiktok", "nend.net", "zucks", "uncn.jp", "gmossp", "adtdp", "dynalyst", "relaido", "glossom", "adapf", "ad-cloud",
    "pdst.fm", "permutive", "chartbeat", "quantserve", "moatads", "doubleverify", "adsafeprotected", "browsiprod", "uniquest",
    "cookielaw.org", "onetrust", "cookiebot", "trustarc", "usercentrics", "didomi", "cookie-script", "privacy-mgmt"].map((h) => `*${h}*`),
];

// 画像は「読み込めた」ことにして、1×1 の透明画像を返す（本物は表示する側のブラウザが読む）。
// 読み込みを止めてしまうと、「画像が読み込まれたら表示する」作りのサイトで画像やカードが透明のまま写る。
const BLANK_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export async function renderPage(url) {
  return slot(async () => {
    const browser = await getBrowser();
    let deadline = Date.now() + 30000;
    const left = (max) => Math.max(200, Math.min(max, deadline - Date.now()));
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setViewport(VIEWPORT);
      await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en;q=0.8" });
      const cdp = await page.createCDPSession();
      await cdp.send("Network.enable");
      await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URLS });
      // スクリプトがデータを取りに行っている最中（fetch / XHR）かどうか
      const inflight = new Set();
      cdp.on("Network.requestWillBeSent", (e) => ["XHR", "Fetch"].includes(e.type) && inflight.add(e.requestId));
      cdp.on("Network.loadingFinished", (e) => inflight.delete(e.requestId));
      cdp.on("Network.loadingFailed", (e) => inflight.delete(e.requestId));
      // ページ（とその中の iframe）の移動先だけ検査する：内部ネットワークへは行かせない
      await cdp.send("Fetch.enable", {
        patterns: [
          { resourceType: "Document", requestStage: "Request" },
          { resourceType: "Image", requestStage: "Request" },
        ],
      });
      cdp.on("Fetch.requestPaused", async ({ requestId, request, resourceType }) => {
        if (resourceType === "Image") {
          const svg = /\.svg([?#]|$)/i.test(request.url);
          return cdp
            .send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: svg ? "image/svg+xml" : "image/gif" }],
              body: svg ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString("base64") : BLANK_GIF,
            })
            .catch(() => {});
        }
        const ok = await isAllowedNavigation(request.url);
        cdp.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
      });
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      if (process.env.CHARINCO_RENDER_DEBUG)
        page.on("requestfailed", (r) => r.resourceType() !== "image" && console.log(`[render]   failed ${r.failure()?.errorText} ${r.url().slice(0, 140)}`));

      const t0 = Date.now();
      deadline = t0 + 26000;
      const mark = (label) => process.env.CHARINCO_RENDER_DEBUG && console.log(`[render] ${label} ${Date.now() - t0}ms ${url}`);
      // 広告などのスクリプトが遅いサイトでは組み立て（DOMContentLoaded）に10秒以上かかることがあるので、長めに待つ
      // （待っている間、切り抜き画面には取得版を先に出している）。
      // 途中までしか組み立てられていないページは下の方が欠けるので写さない（取得版のほうがまし）
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: left(20000) });
      const status = res?.status() || 0;
      if (status >= 400) throw new Error(`status ${status}`);
      const type = res?.headers()["content-type"] || "";
      if (type && !/html|xml/i.test(type)) throw new Error("not html");
      mark("dcl");
      await page.waitForNetworkIdle({ idleTime: 350, timeout: left(2000) }).catch(() => {});
      mark("idle");
      await Promise.race([autoScroll(page), new Promise((r) => setTimeout(r, left(2500)))]).catch(() => {});
      mark("scroll");
      // 読み込み中の骨組み（スケルトン）のまま写さないよう、
      // スクリプトのデータ取得が終わり、文字量が増えなくなるまで待つ（記事一覧を後から読むサイト向け）
      {
        const until = Date.now() + left(9000);
        let n = -1, changed = Date.now(), quiet = 0;
        while (Date.now() < until) {
          const len = await Promise.race([
            page.evaluate(() => document.body?.innerText.length || 0),
            new Promise((r) => setTimeout(r, 1000, n)), // ページが重くて答えが遅いときは「変化なし」とみなす
          ]).catch(() => n);
          // カルーセル等の小さな変化は無視する
          if (Math.abs(len - n) > Math.max(30, n * 0.02)) (n = len), (changed = Date.now());
          quiet = inflight.size ? 0 : quiet + 1;
          if (Date.now() - changed > 600 && quiet >= 3) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      mark("stable");

      const title = await page.title().catch(() => "");
      // ボット対策の確認画面は写し取っても意味がない
      if (/just a moment|attention required|access denied|captcha/i.test(title)) throw new Error("challenge");
      const { html, base } = await Promise.race([
        page.evaluate(snapshotInPage),
        new Promise((_, no) => setTimeout(() => no(new Error("snapshot timeout")), 6000)),
      ]);
      mark("snapshot");
      return { url: page.url(), base, html };
    } finally {
      page?.close().catch(() => {});
    }
  });
}

// サーバー起動時に Chrome を立ち上げておく（初回の数秒を待たせない）
export function warmUp() {
  if (renderEnabled()) getBrowser().catch((err) => console.warn("[render] Chrome を起動できません:", err.message));
}
