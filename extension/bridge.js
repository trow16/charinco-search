// Charinco Search のページ（localhost）と拡張機能のあいだの受け渡し
(() => {
  // Charinco のページかどうか（同じ localhost の別のアプリでは何もしない）
  if (!document.getElementById("board") || !document.querySelector('meta[name="charinco"]')) return;
  const root = document.documentElement;
  // 拡張機能を読み込み直すと、このページとのつながりは切れる（ページを読み込み直すまで、拡張機能に頼めない）
  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (err) {
      return Promise.reject(err);
    }
  };

  // 拡張機能の裏方（background.js）とつながったら、ページ側に「拡張機能が使える」と知らせる。
  // つながらない（拡張機能のフォルダが見つからない・動いていない など）ときは知らせず、Charinco は自分の切り抜き画面を使う。
  // 返事をもらうときに、開いていない間の切り抜きも届く
  send({ type: "bridge-ready" }).then((r) => r?.ok && (root.dataset.charincoExt = "1"), () => {});

  // ページ → 拡張機能（「切り抜く」でページを開く）。開けたかどうかをページに返す
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.charinco !== "open") return;
    const answer = (ok) => {
      if (!ok) delete root.dataset.charincoExt; // このページでは、以後 Charinco の切り抜き画面を使う
      window.postMessage({ charincoExt: "opened", id: e.data.id, ok }, location.origin);
    };
    send({ type: "open", url: String(e.data.url || "") }).then((r) => answer(!!r?.ok), () => answer(false));
  });

  // 拡張機能 → ページ（切り抜きを貼る）
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "ping") return reply({ charinco: true });
    if (msg.type === "view") {
      window.postMessage({ charincoExt: "view", view: msg.view }, location.origin);
      return reply({ ok: true });
    }
    if (msg.type === "clip") {
      window.postMessage({ charincoExt: "clip", card: msg.card }, location.origin);
      reply({ ok: true });
    }
  });
})();
