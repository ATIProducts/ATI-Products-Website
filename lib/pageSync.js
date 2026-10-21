// lib/pageSync.js
//
// Small clean-ups done automatically every time a page is published from
// the admin, so the hidden data Google and AI tools read stays in step
// with what visitors see:
//   - the FAQ data (FAQPage in the JSON-LD) is rebuilt from the page's
//     visible FAQ questions and answers
//   - an existing "dateModified" in the JSON-LD is set to today

const { textOf, brandText } = require('./seoAudit');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function eachJsonLd(html, fn) {
  return String(html).replace(/(<script[^>]+type=["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (full, open, body, close) => {
    let data;
    try { data = JSON.parse(body); } catch (e) { return full; }
    const changed = fn(data);
    if (!changed) return full;
    return open + JSON.stringify(data, null, 0).replace(/<\//g, '<\\/') + close;
  });
}

function nodesOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data['@graph'])) return data['@graph'];
  return [data];
}

function visibleFaq(html) {
  const total = (String(html).match(/itemtype=["']https?:\/\/schema\.org\/Question["']/gi) || []).length;
  const re = /itemtype=["']https?:\/\/schema\.org\/Question["'][^>]*>\s*<(h[1-6]|div|span|p)[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/\1>[\s\S]*?itemprop=["']text["'][^>]*>([\s\S]*?)<\/(?:p|div|span)>/gi;
  const items = [];
  let m;
  const clean = (x) => textOf(brandText(x).replace(/<[^>]+>/g, ''));
  while ((m = re.exec(html))) items.push({ q: clean(m[2]), a: clean(m[3]) });
  // Only trust the result if every question on the page was understood.
  return items.length === total ? items : null;
}

function syncFaqSchema(html) {
  const items = visibleFaq(html);
  if (!items || !items.length) return html;
  return eachJsonLd(html, (data) => {
    let changed = false;
    nodesOf(data).forEach((n) => {
      if (!n || n['@type'] !== 'FAQPage') return;
      const next = items.map((it) => ({ '@type': 'Question', name: it.q, acceptedAnswer: { '@type': 'Answer', text: it.a } }));
      if (JSON.stringify(next) !== JSON.stringify(n.mainEntity)) { n.mainEntity = next; changed = true; }
    });
    return changed;
  });
}

function touchDateModified(html, date) {
  const d = date || today();
  return eachJsonLd(html, (data) => {
    let changed = false;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n.dateModified === 'string' && n.dateModified.slice(0, 10) !== d) { n.dateModified = d; changed = true; }
      Object.keys(n).forEach((k) => { if (n[k] && typeof n[k] === 'object') walk(n[k]); });
    };
    walk(data);
    return changed;
  });
}

module.exports = { syncFaqSchema, touchDateModified, visibleFaq };
