// 앱 껍데기를 저장해 두어 인터넷 없이도 열리게 합니다. 일기 데이터는 여기가 아니라 IndexedDB에 있습니다.
const V = 'diary-shell-v11';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

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
  if (r.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(r.url, { cache: 'no-cache' })).then((res) => { const c = res.clone(); caches.open(V).then((ch) => ch.put('index.html', c)); return res; })
        .catch(() => caches.match('index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(r).then((hit) => {
      const net = fetch(r, { cache: 'no-cache' }).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { const c = res.clone(); caches.open(V).then((ch) => ch.put(r, c)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
