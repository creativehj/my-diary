// 앱 껍데기를 저장해 두어 인터넷 없이도 열리게 합니다. 일기 데이터는 여기가 아니라 IndexedDB에 있습니다.
const V = 'diary-shell-v14';
const SHELL = ['./', 'index.html', 'app.js', 'theme-init.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return; // 날씨 API 등은 항상 네트워크로
  // 화면·코드 파일은 항상 네트워크 우선(최신 버전), 실패하면 저장본. 글꼴·아이콘만 저장본 우선.
  const isAsset = /\.(woff2?|png)$/.test(u.pathname);
  if (!isAsset) {
    e.respondWith(
      fetch(new Request(r.url, { cache: 'no-cache' })).then((res) => {
        if (res && res.ok) { const c = res.clone(); caches.open(V).then((ch) => ch.put(r.mode === 'navigate' ? 'index.html' : r, c)); }
        return res;
      }).catch(() => caches.match(r.mode === 'navigate' ? 'index.html' : r))
    );
    return;
  }
  e.respondWith(
    caches.match(r).then((hit) => {
      const net = fetch(r).then((res) => {
        if (res && res.ok) { const c = res.clone(); caches.open(V).then((ch) => ch.put(r, c)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
