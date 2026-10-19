// ga.js: Google Analytics for ati-products.com, set from the admin's SEO
// dashboard. It waits until the visitor interacts with the page (or a few
// seconds pass) before loading Google's script, so it doesn't slow the
// page down. Leave the ID empty to turn tracking off.
(function () {
  var ID = "G-FBNTV3FJQ5";
  var w = window, d = document;
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  // atiTrack('generate_lead', {...}) works even before Google's script loads.
  w.atiTrack = function (name, params) { if (ID) w.gtag('event', name, params || {}); };
  if (!ID || !/(^|\.)ati-products\.com$/.test(location.hostname)) return;
  w.gtag('js', new Date());
  w.gtag('config', ID);
  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
    d.head.appendChild(s);
  }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (e) { w.addEventListener(e, load, { once: true, passive: true }); });
  w.addEventListener('load', function () { setTimeout(load, 8000); });
  // Calls and calculator quotes are the actions that matter most.
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) w.atiTrack('phone_click', { link_url: href, page_path: location.pathname });
    else if (a.hasAttribute('data-quote')) w.atiTrack('calculator_quote', { page_path: location.pathname });
  }, true);
})();
