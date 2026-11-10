// Charinco Search のサーバー：public/ を配信し、/api/* を api/ の各ファイルに渡す
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// .env（APIキー）を読む。node の --env-file 系の指定は Node.js のバージョンによって使えず、
// 古い Node.js の Mac ではサーバーが起動しなくなるので、自分で読む（すでにある環境変数は上書きしない）
try {
  for (const line of (await fs.readFile(path.join(here, ".env"), "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    const q = m[2].match(/^(["'])(.*)\1$/);
    process.env[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, "");
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);

// 止める合図（起動したウィンドウを閉じた・Ctrl+C）で必ず終わる。裏の Chrome を動かす puppeteer は、
// この合図では Chrome を閉じるだけでサーバーを残してしまうため。終わるときに Chrome も閉じる（puppeteer が exit で閉じる）
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// 拡張機能（extension/）にも同じ切り抜きの中核を入れておく
{
  const src = await fs.readFile(path.join(here, "public", "clipcore.js"), "utf8");
  const dst = path.join(here, "extension", "clipcore.js");
  if ((await fs.readFile(dst, "utf8").catch(() => "")) !== src) await fs.writeFile(dst, src).catch(() => {});
}

const routes = {};
for (const name of ["parallel", "search", "clip", "asset", "live"]) {
  routes[`/api/${name}`] = await import(`./api/${name}.js`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const mod = routes[url.pathname];
    if (mod) {
      const handler = mod[req.method];
      if (!handler) return res.writeHead(405).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // 流し続ける応答（ライブ表示の画面）は、届いた分からそのまま送る
      if (/event-stream/.test(response.headers.get("content-type") || "") && response.body) {
        const stream = Readable.fromWeb(response.body);
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.join(here, "public", path.normalize(rel));
    if (!file.startsWith(path.join(here, "public"))) return res.writeHead(403).end();
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, () => {
    console.log(`Charinco Search → http://localhost:${PORT}${process.env.CHARINCO_MOCK === "1" ? "  (mock mode)" : ""}`);
  });
