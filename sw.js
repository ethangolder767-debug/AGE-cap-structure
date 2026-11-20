/*
 * sw.js — the service worker that lets the app install and work offline.
 *
 * Network first: every request goes to GitHub Pages, and each answer is
 * saved in the cache. Only when the network fails does the app use the
 * cached copy. That way each merged change shows up the next time the
 * app is online, and the last version still works offline.
 *
 * Every path is relative, because the site lives at
 * https://<username>.github.io/<repository>/, not at the root of a domain.
 */
var CACHE = 'age-cap-v1';

var FILES = [
  './',
  'index.html',
  'styles.css',
  'capstruct.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'data/cdss.csv',
  'data/assumptions.csv',
  'data/banker_schedule.csv',
  'data/example_firms.csv',
  'data/ebit_scenarios.csv',
  'data/banker_schedule_riskier.csv'
];

// Save every file the app needs when the service worker installs.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

// Remove caches left by older versions of this file.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('age-cap-') === 0 && k !== CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Only this site's own files. The app makes no other requests anyway.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
