// オフライン起動用のランタイムキャッシュ。
// ナビゲーション(HTML)はネットワーク優先。ただし車のネットはつながるまで遅いことが
// あるので、待つのは NAVIGATION_TIMEOUT_MS まで。過ぎたら前回の画面で起動する。
// 同一オリジンの静的アセット(ハッシュ付きチャンク・画像)はキャッシュ優先。
// 外部API(天気・シフト・地図タイル等)はキャッシュせず素通しする。
const CACHE_NAME = "zcar-runtime-v1";
// 起動のときにネットの返事を待つ長さ。これを過ぎたら貯めてある画面を出す。
const NAVIGATION_TIMEOUT_MS = 3000;
// 以前は音楽ファイルも "zcar-music-v1" に貯めていた。音楽はやめたので、
// 下の activate でほかの古いキャッシュと一緒に消して、車の容量を空ける。

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const putInCache = (request, response) => {
  const copy = response.clone();
  void caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => undefined);
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 設定のやり取り(api)はいつも最新を読むので、キャッシュせず素通しする。
  if (url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    const network = fetch(request).then((response) => {
      if (response.ok) putInCache(request, response);
      return response;
    });
    // 間に合わなかった返事も、次の起動のために最後まで受け取って貯める。
    event.waitUntil(network.then(() => undefined, () => undefined));
    // 画面の「更新」で読み込み直したときは、ブラウザの更新ボタンと同じくネットを待つ。
    const userReload = request.cache === "no-cache" || request.cache === "reload";
    event.respondWith(
      (async () => {
        const cached = (await caches.match(request)) ?? (await caches.match("./"));
        // 貯めた画面が無い(初めて開いた)ときは、時間がかかってもネットを待つ。
        if (!cached) return network.catch(() => Response.error());
        if (userReload) return network.catch(() => cached);
        const late = new Promise((resolve) => {
          setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
        });
        try {
          return (await Promise.race([network, late])) ?? cached;
        } catch {
          return cached;
        }
      })(),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) putInCache(request, response);
          return response;
        }),
    ),
  );
});
