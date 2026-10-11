// オフライン起動用のランタイムキャッシュ。
// ナビゲーション(HTML)はネットワーク優先で、オフライン時のみキャッシュを返す。
// 同一オリジンの静的アセット(ハッシュ付きチャンク・画像)はキャッシュ優先。
// 外部API(天気・シフト・地図タイル等)はキャッシュせず素通しする。
const CACHE_NAME = "zcar-runtime-v1";
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) putInCache(request, response);
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match("./"))
            .then((cached) => cached ?? Response.error()),
        ),
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
