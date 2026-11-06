const CACHE='moon-toss-github-v1';
const BASE=new URL('./',self.location.href).pathname;
const ASSETS=['style.css','app.mjs','engine.mjs','ble.mjs','protocol.mjs','icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png','manifest.webmanifest'].map(p=>BASE+p);
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('moon-toss-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// Navigations always reach the host's access gate; private HTML is never cached.
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||e.request.mode==='navigate')return;const url=new URL(e.request.url);if(url.origin!==location.origin||!ASSETS.includes(url.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok&&r.type!=='opaqueredirect'&&!r.redirected)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r;}).catch(()=>caches.match(e.request).then(r=>r||Response.error())));});
