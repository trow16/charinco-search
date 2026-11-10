// 拡張機能の裏方：Charinco から開いたタブを覚え、切り抜きを Charinco のタブへ届ける

const APP_URLS = ["http://localhost/*", "http://127.0.0.1/*"];
const isApp = (url) => /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url || "");

// 切り抜きのツールバーは、どのページにも入れておくのではなく、使うタブにだけ入れる（ふだん見るページを重くしない）。
// 入れるのは、Charinco から開いたタブ（リンクで別のページへ移っても入れ直す）と、アイコン・ショートカットを押したタブ
const injectClipper = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["clipcore.js", "clipper.js"] });
chrome.webNavigation.onDOMContentLoaded.addListener(
  async ({ tabId, frameId, url }) => {
    if (frameId !== 0 || isApp(url) || !(tabId in (await clipTabs()))) return;
    // ツールバーは読み込まれると「hello」を送り、Charinco から開いたタブなら最初から出る
    await injectClipper(tabId).catch(() => {});
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// Charinco から開いたタブ（ツールバーを最初から出す）。サービスワーカーが止まっても消えないよう session に置く
async function clipTabs() {
  return (await chrome.storage.session.get("clipTabs")).clipTabs || {};
}
async function rememberTab(tabId, appTabId) {
  const tabs = await clipTabs();
  tabs[tabId] = appTabId;
  await chrome.storage.session.set({ clipTabs: tabs });
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await clipTabs();
  if (tabId in tabs) {
    delete tabs[tabId];
    await chrome.storage.session.set({ clipTabs: tabs });
  }
});

// Charinco のタブを探す（そのページを開いたタブ → 最後に使ったタブの順）
async function appTabs(preferId) {
  const found = [];
  for (const t of await chrome.tabs.query({ url: APP_URLS })) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: "ping" });
      if (r?.charinco) found.push(t);
    } catch {}
  }
  return found.sort((a, b) => (b.id === preferId) - (a.id === preferId) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

// 切り抜きを届ける。Charinco が開いていなければ取っておき、開いたときに届ける
async function deliver(card, preferId) {
  const [tab] = await appTabs(preferId);
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "clip", card });
      return true;
    } catch {}
  }
  const { pending = [] } = await chrome.storage.local.get("pending");
  pending.push(card);
  await chrome.storage.local.set({ pending });
  return false;
}

async function flushPending(tabId) {
  const { pending = [] } = await chrome.storage.local.get("pending");
  if (!pending.length) return;
  await chrome.storage.local.set({ pending: [] });
  for (const card of pending) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "clip", card });
    } catch {
      await deliver(card);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tabId = sender.tab?.id;
    switch (msg.type) {
      case "open": {
        // Charinco の「切り抜く」：隣に新しいタブで開き、ツールバーを出す
        if (!/^https?:\/\//.test(msg.url || "")) return reply({ ok: false });
        const t = await chrome.tabs.create({ url: msg.url, openerTabId: tabId, index: (sender.tab?.index ?? 0) + 1 });
        await rememberTab(t.id, tabId);
        return reply({ ok: true });
      }
      case "hello": {
        const tabs = await clipTabs();
        return reply({ show: tabId in tabs });
      }
      case "clip": {
        const tabs = await clipTabs();
        const delivered = await deliver(msg.card, tabs[tabId]);
        return reply({ delivered });
      }
      case "bridge-ready":
        await flushPending(tabId);
        return reply({ ok: true });
      case "focus-app": {
        const [tab] = await appTabs((await clipTabs())[tabId]);
        if (tab) {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          if (msg.view) await chrome.tabs.sendMessage(tab.id, { type: "view", view: msg.view }).catch(() => {});
        }
        return reply({ ok: !!tab });
      }
    }
  })();
  return true; // 非同期で返事する
});

// ツールバーのアイコン・ショートカット：そのタブで切り抜きを始める
async function toggle(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || "") || isApp(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    // まだツールバーを入れていないページには、ここで入れる
    await injectClipper(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  }
}
chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "toggle-clip") toggle(tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});
