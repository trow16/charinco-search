// Charinco Search のページ（localhost）と拡張機能のあいだの受け渡し
(() => {
  // Charinco のページかどうか（同じ localhost の別のアプリでは何もしない）
  if (!document.getElementById("board") || !document.querySelector('meta[name="charinco"]')) return;
  // ページ側から「拡張機能が入っている」と分かるように
  document.documentElement.dataset.charincoExt = "1";

  // ページ → 拡張機能（「切り抜く」でページを開く）
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.charinco !== "open") return;
    chrome.runtime.sendMessage({ type: "open", url: String(e.data.url || "") });
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

  // 開いていない間に切り抜いたものを受け取る
  chrome.runtime.sendMessage({ type: "bridge-ready" });
})();
