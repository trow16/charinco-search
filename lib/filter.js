// 切り抜けない（HTMLの要素として取り出せない）検索結果を除く
// 動画・音楽・SNS・ECの商品ページ・PDFなどは、ページを開いても段落や見出しとして切り抜けないため

// サイトごと除外するもの（ホスト名の末尾で判定）
const BLOCK_HOSTS = [
  // 動画・音楽・ポッドキャスト
  "youtube.com", "youtu.be", "nicovideo.jp", "nico.ms", "vimeo.com", "dailymotion.com", "tiktok.com", "twitch.tv",
  "abema.tv", "tver.jp", "netflix.com", "hulu.jp", "unext.jp", "video.unext.jp", "spotify.com", "music.apple.com",
  "podcasts.apple.com", "soundcloud.com", "music.youtube.com", "music.amazon.co.jp", "linemusic.jp", "awa.fm",
  "bilibili.com", "bilibili.tv", "nhk.jp/plus",
  // SNS（ログインやスクリプトが前提で、本文を切り抜けない）
  "x.com", "twitter.com", "instagram.com", "facebook.com", "threads.net", "threads.com", "pinterest.com", "pinterest.jp",
  "linkedin.com", "bsky.app",
  // EC・フリマ・オークション
  "amazon.co.jp", "amazon.com", "amzn.to", "amzn.asia", "rakuten.co.jp", "shopping.yahoo.co.jp", "store.shopping.yahoo.co.jp",
  "paypaymall.yahoo.co.jp", "auctions.yahoo.co.jp", "paypayfleamarket.yahoo.co.jp", "mercari.com", "jp.mercari.com",
  "fril.jp", "zozo.jp", "yodobashi.com", "biccamera.com", "kakaku.com", "monotaro.com", "askul.co.jp", "lohaco.yahoo.co.jp",
  "aliexpress.com", "temu.com", "shein.com", "ebay.com", "etsy.com", "qoo10.jp", "minne.com", "creema.jp", "booth.pm",
  "dmm.com", "dlsite.com", "nitori-net.jp", "muji.com", "uniqlo.com", "gu-global.com", "cainz.com", "tower.jp",
  "hmv.co.jp", "honto.jp", "e-hon.ne.jp", "7net.omni7.jp", "tsutaya.co.jp", "store.steampowered.com", "apps.apple.com",
  "play.google.com", "apkpure.com",
  // 画像・地図
  "maps.google.com", "maps.app.goo.gl", "google.com/maps", "photos.google.com", "flickr.com", "unsplash.com", "pixabay.com",
  "instagram.fna.fbcdn.net",
];

// URL のパスで判定するもの（サイト全体は普通の記事だが、その種類のページだけ除く）
const BLOCK_PATHS = [
  /\.(pdf|docx?|xlsx?|pptx?|zip|mp4|mov|mp3|m4a|jpe?g|png|gif|webp)(\?|#|$)/i,
  /\/(item|items|dp|gp\/product|cart|goods)\//i, // 商品ページ
  /^https?:\/\/[^/]*books\.rakuten\.co\.jp\//i,
  /^https?:\/\/(www\.)?google\.[^/]+\/maps/i,
  /^https?:\/\/[^/]*\.?nhk\.jp\/p\/[^/]+\/ts\//i, // NHK の番組配信ページ
  /\/(watch|embed|shorts)(\/|\?|$)/i, // 動画の再生ページ
];

// タイトルで、明らかに商品の販売ページとわかるもの（記事の本文に出てくる言葉では判定しない）
const BLOCK_TITLE = /(【公式通販】|通販サイト|【楽天市場】|楽天市場|Amazon\.co\.jp|ポイント\d+倍|送料無料|新品・中古|の通販|価格比較|最安値|- YouTube$|ニコニコ動画$)/;

function hostMatches(host, path, rule) {
  if (rule.includes("/")) return `${host}${path}`.startsWith(rule) || `${host}${path}`.includes(`.${rule}`);
  return host === rule || host.endsWith(`.${rule}`);
}

/** Brave の生の結果1件が、切り抜けるHTMLページらしいか */
export function isClippable(r) {
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (BLOCK_HOSTS.some((rule) => hostMatches(host, u.pathname, rule))) return false;
  if (BLOCK_PATHS.some((re) => re.test(r.url))) return false;
  // Brave が動画・商品・映画などと判定したもの
  if (r.product || r.products || r.movie || r.music_recording) return false;
  if (["video", "product", "movie", "music_recording", "software"].includes(r.subtype)) return false;
  if (BLOCK_TITLE.test(r.title || "")) return false;
  return true;
}
