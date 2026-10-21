// lib/seoAudit.js
//
// The scoring engine behind the admin's SEO dashboard. Everything here is
// plain functions over HTML text, with no network calls, so it can be
// tested on its own and run fast on every dashboard load.
//
// Each page gets three scores from 0 to 100:
//   SEO  classic search: titles, descriptions, headings, links, speed
//   AEO  answer engines: FAQs, question headings, short answers, schema
//   GEO  AI citations:   facts, sources, organization data, llms.txt
// A score is the weighted share of that pillar's checks the page passes.
// Checks that can't be judged yet (for example speed before PageSpeed has
// run) are left out instead of counting against the page.

const { SITE_URL } = require('./site');

// ---------- tiny HTML helpers (no dependencies) ----------

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}

// A brand logo used in place of a word (class "brand-logo") reads as its alt text.
function brandText(html) {
  return String(html || '').replace(/<img\b[^>]*class=["'][^"']*\bbrand-logo\b[^"']*["'][^>]*>/gi, (tag) => {
    const m = tag.match(/\balt=["']([^"']*)["']/i);
    return m ? m[1] : ' ';
  });
}

function textOf(html) {
  return decode(brandText(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) {
    out[m[1].toLowerCase()] = decode(m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '');
  }
  return out;
}

function tags(html, name) {
  return (String(html).match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || []).map(attrs);
}

function words(text) {
  return (String(text).match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
}

// The part of the page that is the page's own content: inside <main>, with
// the menu, footer and the sitewide "service coverage" and "subsidiaries"
// blocks taken out (they repeat on every page).
function mainContent(html) {
  let s = String(html);
  const m = s.match(/<main\b[\s\S]*?<\/main>/i);
  if (m) s = m[0];
  return s
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<div class="mobile-nav"[\s\S]*?<\/div>/gi, ' ');
}

function jsonLd(html) {
  const out = [];
  let ok = true;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(m[1]);
      const list = Array.isArray(d) ? d : d && d['@graph'] ? d['@graph'] : [d];
      list.forEach((n) => n && typeof n === 'object' && out.push(n));
    } catch (e) {
      ok = false;
    }
  }
  return { nodes: out, valid: ok };
}

function typesOf(nodes) {
  const set = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n['@type'];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => set.add(String(x)));
    Object.keys(n).forEach((k) => { if (k !== '@type') walk(n[k]); });
  };
  nodes.forEach(walk);
  return set;
}

// "about.html" -> "/about", "index.html" -> "/"
function pathFor(file) {
  const slug = String(file).replace(/\.html$/, '');
  return slug === 'index' ? '/' : '/' + slug;
}

// Turns any link on the site into the page path it points at, or null if
// it's not one of our pages (other sites, phone numbers, PDFs, photos).
function linkTarget(href, fromPath) {
  if (!href) return null;
  let h = href.trim();
  if (/^(mailto:|tel:|javascript:|#)/i.test(h)) return null;
  let u;
  try {
    u = new URL(h, SITE_URL + (fromPath || '/'));
  } catch (e) {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== new URL(SITE_URL).hostname.replace(/^www\./, '')) return null;
  let p = u.pathname.replace(/\/+$/, '') || '/';
  if (/\.(pdf|webp|jpe?g|png|gif|svg|xml|txt|json|ico)$/i.test(p)) return null;
  p = p.replace(/\.html$/, '');
  if (p === '/index') p = '/';
  return p;
}

// ---------- reading one page ----------

function parsePage(html, file) {
  const path = pathFor(file);
  const url = SITE_URL + (path === '/' ? '/' : path);
  const head = (String(html).match(/<head\b[\s\S]*?<\/head>/i) || [''])[0];
  const metas = tags(head, 'meta');
  const metaBy = (key, val) => {
    const m = metas.find((a) => (a[key] || '').toLowerCase() === val);
    return m ? (m.content || '').trim() : '';
  };
  const title = textOf((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const canonical = (tags(head, 'link').find((a) => (a.rel || '').toLowerCase() === 'canonical') || {}).href || '';
  const htmlTag = (String(html).match(/<html\b[^>]*>/i) || [''])[0];
  const main = mainContent(html);
  const mainText = textOf(main);
  const headings = [];
  const hre = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = hre.exec(main))) headings.push({ level: Number(m[1]), text: textOf(m[2]) });
  const allH1 = (String(html).match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || []).map(textOf);
  const imgs = tags(main, 'img');
  const anchors = (String(html).match(/<a\b[^>]*>/gi) || []).map(attrs);
  const mainAnchors = (main.match(/<a\b[^>]*>/gi) || []).map(attrs);
  const ld = jsonLd(html);
  const types = typesOf(ld.nodes);
  const faqVisible = (String(html).match(/itemtype=["']https?:\/\/schema\.org\/Question["']/gi) || []).length;
  let faqSchema = 0;
  ld.nodes.forEach((n) => {
    const t = n['@type'];
    if (t === 'FAQPage' || (Array.isArray(t) && t.includes('FAQPage'))) faqSchema += (n.mainEntity || []).length;
  });
  const paragraphs = (main.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []).map(textOf).filter((t) => t.length > 0);
  const lead = paragraphs.find((t) => words(t) >= 8) || '';
  const factText = mainText.replace(/\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g, ' ');
  const numbers = (factText.match(/\b\d[\d,.]*\s*(?:%|ft|feet|foot|in|inch|inches|lbs?|pounds|steps?|degrees?|°|hours?|days?|years?|states|minutes|seconds|milliseconds|"|′|″|')|\$\s?\d[\d,.]*|\b(?:19|20)\d{2}\b|\b\d+(?:\.\d+)?\s*(?:to|-)\s*\d+/gi) || []).length;
  const outbound = anchors.map((a) => a.href || '').filter((h) => /^https?:\/\//i.test(h) && !/ati-products\.com/i.test(h));
  const authority = outbound.filter((h) => /\.(gov|edu)(\/|$)|osha\.gov|ansi\.org|nist\.gov|iso\.org|google\.com\/search\/docs|developers\.google\.com|support\.google\.com|web\.dev/i.test(h));
  let dateModified = '';
  ld.nodes.forEach((n) => { if (n.dateModified) dateModified = String(n.dateModified); else if (!dateModified && n.datePublished) dateModified = String(n.datePublished); });
  if (!dateModified) {
    const t = (String(html).match(/<time\b[^>]*datetime=["']([^"']+)["']/i) || [])[1];
    if (t) dateModified = t;
  }
  const internalOut = new Set();
  mainAnchors.forEach((a) => { const t = linkTarget(a.href, path); if (t && t !== path) internalOut.add(t); });
  const allOut = new Set();
  anchors.forEach((a) => { const t = linkTarget(a.href, path); if (t && t !== path) allOut.add(t); });
  return {
    file, path, url, title,
    description: metaBy('name', 'description'),
    robots: metaBy('name', 'robots'),
    viewport: metaBy('name', 'viewport'),
    ogTitle: metaBy('property', 'og:title'),
    ogDescription: metaBy('property', 'og:description'),
    ogImage: metaBy('property', 'og:image'),
    lang: attrs(htmlTag).lang || '',
    canonical,
    h1: allH1,
    headings,
    h2Count: headings.filter((h) => h.level === 2).length,
    questionHeadings: headings.filter((h) => /\?\s*$/.test(h.text)).length,
    words: words(mainText),
    mainText,
    lead,
    leadWords: words(lead),
    images: imgs.length,
    imagesMissingAlt: imgs.filter((a) => !('alt' in a) || (!a.alt.trim() && a.role !== 'presentation')).length,
    hasList: /<(ul|ol|table|dl)\b/i.test(main),
    jsonLdValid: ld.valid,
    schemaTypes: Array.from(types),
    faqVisible,
    faqSchema,
    numbers,
    outbound: Array.from(new Set(outbound)),
    authority: Array.from(new Set(authority)),
    brandMentions: (mainText.match(/\bATI\b/g) || []).length,
    hasPhone: /\(?800\)?[\s.-]*360[\s.-]*6115/.test(String(html)),
    dateModified,
    internalOut: Array.from(internalOut),
    allOut: Array.from(allOut),
  };
}

// ---------- the checks ----------
//
// Each check: id, pillar, label (what's being checked), weight, severity if
// it fails, a test returning true / false / null (null = can't tell yet),
// and the fix to show when it fails.

const PRIMARY_TYPES = ['Product', 'Service', 'HowTo', 'Article', 'BlogPosting', 'TechArticle', 'LocalBusiness', 'AboutPage', 'ContactPage', 'CollectionPage', 'Organization'];

const CHECKS = [
  // SEO
  { id: 'title', pillar: 'SEO', label: 'Page title', weight: 10, severity: 'critical', meta: true,
    test: (p) => p.title.length > 0, fix: () => 'Add a page title (the blue headline Google shows).' },
  { id: 'title-length', pillar: 'SEO', label: 'Title length (30 to 65 characters)', weight: 5, severity: 'medium',
    test: (p) => p.title.length >= 30 && p.title.length <= 65,
    fix: (p) => `The title is ${p.title.length} characters. Aim for 30 to 65 so Google shows it in full, with the main search phrase near the start.` },
  { id: 'description', pillar: 'SEO', label: 'Meta description', weight: 8, severity: 'high', meta: true,
    test: (p) => p.description.length > 0, fix: () => 'Add a meta description: one or two sentences Google can show under the title.' },
  { id: 'description-length', pillar: 'SEO', label: 'Description length (70 to 165 characters)', weight: 4, severity: 'low',
    test: (p) => p.description.length >= 70 && p.description.length <= 165,
    fix: (p) => `The description is ${p.description.length} characters. Aim for 70 to 165 and include a reason to click, like same-day quotes.` },
  { id: 'h1', pillar: 'SEO', label: 'Exactly one main heading (H1)', weight: 8, severity: 'high', meta: true,
    test: (p) => p.h1.length === 1, fix: (p) => (p.h1.length ? `The page has ${p.h1.length} main headings (H1). Keep one and make the others subheadings.` : 'Add one main heading (H1) that says what the page is about.') },
  { id: 'canonical', pillar: 'SEO', label: 'Canonical address', weight: 6, severity: 'high', meta: true,
    test: (p) => !!p.canonical && p.canonical.replace(/\/+$/, '') === p.url.replace(/\/+$/, ''),
    fix: (p) => (p.canonical ? `The canonical tag points to ${p.canonical} instead of ${p.url}.` : 'Add a canonical tag with the page’s own address.') },
  { id: 'indexable', pillar: 'SEO', label: 'Allowed in Google', weight: 10, severity: 'critical', meta: true,
    test: (p) => !/noindex/i.test(p.robots), fix: () => 'The page tells Google not to index it (noindex). Remove that if the page should show up in search.' },
  { id: 'in-sitemap', pillar: 'SEO', label: 'Listed in the sitemap', weight: 5, severity: 'high', meta: true,
    test: (p, c) => (c.sitemap ? c.sitemap.has(p.path) : null), fix: () => 'Add the page to sitemap.xml so Google finds it quickly.' },
  { id: 'words', pillar: 'SEO', label: 'At least 300 words of content', weight: 8, severity: 'medium', meta: true,
    test: (p) => p.words >= 300, fix: (p) => `The page has about ${p.words} words of its own content. Add helpful detail to reach at least 300.` },
  { id: 'alt', pillar: 'SEO', label: 'Every photo has a description (alt text)', weight: 6, severity: 'medium', meta: true,
    test: (p) => p.imagesMissingAlt === 0, fix: (p) => `${p.imagesMissingAlt} photo(s) have no description. Describe each one in the editor so Google and screen readers understand it.` },
  { id: 'social', pillar: 'SEO', label: 'Social sharing tags', weight: 3, severity: 'low', meta: true,
    test: (p) => !!(p.ogTitle && p.ogDescription && p.ogImage), fix: () => 'Add og:title, og:description and og:image so the page looks right when shared.' },
  { id: 'subheadings', pillar: 'SEO', label: 'At least 2 section headings (H2)', weight: 4, severity: 'low',
    test: (p) => p.h2Count >= 2, fix: () => 'Break the page into sections with at least two subheadings (H2) that use the words people search.' },
  { id: 'links-out', pillar: 'SEO', label: 'Links to 3+ other pages in the content', weight: 4, severity: 'low',
    test: (p) => p.internalOut.length >= 3, fix: (p) => `The page’s content links to ${p.internalOut.length} other page(s). Link to at least 3 related pages.` },
  { id: 'links-in', pillar: 'SEO', label: 'Linked from 2+ other pages’ content', weight: 6, severity: 'medium',
    test: (p, c) => (p.path === '/' ? null : c.inbound ? (c.inbound[p.path] || 0) >= 2 : null),
    fix: (p, c) => `Only ${(c.inbound && c.inbound[p.path]) || 0} other page(s) link to this one from their content (not counting the menu and footer). See Internal Links for pages that mention it.` },
  { id: 'speed', pillar: 'SEO', label: 'Mobile PageSpeed 90 or higher', weight: 8, severity: 'high',
    test: (p, c) => { const s = c.speed && c.speed[p.path] && c.speed[p.path].mobile; return s && s.perf != null ? s.perf >= 90 : null; },
    fix: (p, c) => `Mobile PageSpeed is ${c.speed[p.path].mobile.perf}. Check the largest photos and anything that loads before the page shows.` },
  { id: 'basics', pillar: 'SEO', label: 'Phone-friendly setup and language tag', weight: 2, severity: 'low', meta: true,
    test: (p) => /width=device-width/.test(p.viewport) && !!p.lang, fix: () => 'Add the viewport tag and lang="en" to the page.' },
  // AEO
  { id: 'faq', pillar: 'AEO', label: 'FAQ with 3+ questions', weight: 15, severity: 'high',
    test: (p) => p.faqVisible >= 3, fix: (p) => (p.faqVisible ? `The FAQ has ${p.faqVisible} question(s). Add more real customer questions, for 3 to 7 in total.` : 'Add an FAQ section with 3 to 7 real customer questions and short, direct answers. Answer engines quote these.') },
  { id: 'faq-schema', pillar: 'AEO', label: 'FAQ data matches the visible FAQ', weight: 10, severity: 'medium',
    test: (p) => (p.faqVisible ? p.faqSchema === p.faqVisible : p.faqSchema === 0 ? null : false),
    fix: (p) => `The hidden FAQ data has ${p.faqSchema} question(s) but the page shows ${p.faqVisible}. Make them match so Google and AI tools read the same answers.` },
  { id: 'questions', pillar: 'AEO', label: '3+ headings phrased as questions', weight: 8, severity: 'low',
    test: (p) => p.questionHeadings >= 3, fix: () => 'Phrase some headings the way people ask, such as “What size AdjustaStairs do I need?”.' },
  { id: 'answer-first', pillar: 'AEO', label: 'Short summary near the top (12 to 70 words)', weight: 8, severity: 'medium',
    test: (p) => p.leadWords >= 12 && p.leadWords <= 70,
    fix: (p) => (p.leadWords > 70 ? `The first paragraph is ${p.leadWords} words. Open with a 1 to 3 sentence answer, then go into detail.` : 'Open the page with a 1 to 3 sentence summary that directly answers what the page is about.') },
  { id: 'lists', pillar: 'AEO', label: 'Lists or tables', weight: 6, severity: 'low',
    test: (p) => p.hasList, fix: () => 'Add a list or table (specs, steps, comparisons). Answer engines lift these directly.' },
  { id: 'breadcrumb', pillar: 'AEO', label: 'Breadcrumb data', weight: 6, severity: 'low',
    test: (p) => p.path === '/' ? null : p.schemaTypes.includes('BreadcrumbList'), fix: () => 'Add BreadcrumbList structured data so Google shows where the page sits on the site.' },
  { id: 'page-type', pillar: 'AEO', label: 'Structured data saying what the page is', weight: 8, severity: 'medium', meta: true,
    test: (p) => p.jsonLdValid && PRIMARY_TYPES.some((t) => p.schemaTypes.includes(t)),
    fix: (p) => (p.jsonLdValid ? 'Add structured data that says what the page is (Product, Service, Article or HowTo).' : 'The page’s structured data (JSON-LD) has an error and can’t be read. Fix the JSON.') },
  // GEO
  { id: 'organization', pillar: 'GEO', label: 'Says who publishes it (Organization data)', weight: 8, severity: 'medium',
    test: (p) => p.schemaTypes.some((t) => /Organization|LocalBusiness/.test(t)), fix: () => 'Add Organization (ATI Products, LLC) to the page’s structured data so AI tools know who is behind it.' },
  { id: 'facts', pillar: 'GEO', label: '8+ specific facts and numbers', weight: 8, severity: 'medium',
    test: (p) => p.numbers >= 8, fix: (p) => `The page has ${p.numbers} specific figures. Add measurements, ratings, ranges, standards and timeframes. AI answers cite pages with concrete facts.` },
  { id: 'sources', pillar: 'GEO', label: 'Cites an authority (OSHA, ANSI, .gov)', weight: 6, severity: 'low',
    test: (p) => p.authority.length > 0, fix: () => 'Link to an authoritative source where it fits, such as the OSHA rule or ANSI standard you mention.' },
  { id: 'brand', pillar: 'GEO', label: 'Names ATI 3+ times', weight: 4, severity: 'low',
    test: (p) => p.brandMentions >= 3, fix: () => 'Mention ATI by name a few times so AI tools connect the answer to your company.' },
  { id: 'freshness', pillar: 'GEO', label: 'Shows when it was last updated', weight: 6, severity: 'low',
    test: (p, c) => !!p.dateModified || !!(c.lastmod && c.lastmod[p.path]),
    fix: () => 'Add a last-updated date (dateModified in the structured data or lastmod in the sitemap).' },
  { id: 'llms', pillar: 'GEO', label: 'Listed in llms.txt', weight: 8, severity: 'medium',
    test: (p, c) => (c.llms == null ? null : c.llms.has(p.path)), fix: () => 'Add a one-line summary of this page to llms.txt, the guide AI tools read about the site.' },
  { id: 'depth', pillar: 'GEO', label: 'In-depth content (600+ words)', weight: 8, severity: 'medium',
    test: (p) => p.words >= 600, fix: (p) => `About ${p.words} words. Pages AI tools cite are usually 600+ words with real detail.` },
  { id: 'contact', pillar: 'GEO', label: 'Phone number on the page', weight: 4, severity: 'low',
    test: (p) => p.hasPhone, fix: () => 'Show the phone number (800) 360-6115 on the page.' },
  { id: 'ai-bots', pillar: 'GEO', label: 'AI crawlers allowed (robots.txt)', weight: 6, severity: 'high',
    test: (p, c) => (c.aiBotsAllowed == null ? null : c.aiBotsAllowed), fix: () => 'robots.txt is blocking AI crawlers (GPTBot, ClaudeBot, PerplexityBot or Google-Extended). Allow them to be cited.' },
];

// Plain-English help for every check, shown in the dashboard's
// "How to Improve" tab and in the page editor. `why` says why it matters,
// `how` says how to fix it from the admin.
const CODE = 'In the editor, use “Advanced: edit code”, or ask whoever manages the site’s code.';
const GUIDE = {
  'title': { why: 'The title is the blue headline in Google and the name in the browser tab. It is the strongest single signal of what a page is about.', how: 'Open the page in the editor and expand “Google search listing (title & description)”. Type a title that starts with the main search phrase.' },
  'title-length': { why: 'Google cuts titles off at roughly 60 characters. Too short wastes the space; too long hides the end.', how: 'In “Google search listing”, keep the title between 30 and 65 characters, main phrase first, brand last (for example “Debris Netting & Safety Netting for Construction | ATI”).' },
  'description': { why: 'The description is the gray text under the title in Google. A good one gets more people to click.', how: 'In “Google search listing”, write one or two sentences that say what the page offers and give a reason to click, like same-day quotes.' },
  'description-length': { why: 'Google shows about 150 to 160 characters. Shorter descriptions leave space unused, longer ones get cut off.', how: 'In “Google search listing”, aim for 70 to 165 characters. The editor counts as you type.' },
  'h1': { why: 'One main heading tells Google and readers what the page is about. Several H1s blur that.', how: 'Keep one main heading at the top of the page. If a page has more, change the extra ones to subheadings. ' + CODE },
  'canonical': { why: 'The canonical tag tells Google which address is the real one, so it doesn’t split credit between copies.', how: 'Every page should point to its own address. ' + CODE },
  'indexable': { why: 'A “noindex” tag keeps a page out of Google completely.', how: 'Remove the noindex tag if the page should show up in search. ' + CODE },
  'in-sitemap': { why: 'The sitemap is the list of pages Google checks first. Pages missing from it are found more slowly.', how: 'Pages made with “+ New Page” or “+ New Blog Post” are added automatically. For other pages, add them to sitemap.xml.' },
  'words': { why: 'Thin pages rarely rank. Google wants enough detail to answer the search fully.', how: 'Add useful detail in the editor: what it is, who it’s for, how it works, specs, and common questions. Aim for at least 300 words.' },
  'alt': { why: 'Photo descriptions (alt text) let Google understand photos and let screen readers describe them. They also help photos show up in Google Images.', how: 'In the editor, click the photo and fill in its description in plain words, like “Debris netting installed on a building under construction”.' },
  'social': { why: 'These tags control the picture and text shown when someone shares the page on Facebook, LinkedIn or a text message.', how: 'Pages made in the admin get them automatically. For older pages: ' + CODE },
  'subheadings': { why: 'Subheadings break a page into sections that Google can match to different searches.', how: 'Add section headings that use the words customers search for, like “How to Install Debris Netting”.' },
  'links-out': { why: 'Links between your own pages help Google understand how topics connect and keep visitors on the site.', how: 'In the editor, select a few words that mention another page’s topic and use the link button to link them to that page. See the Internal Links tab for ideas.' },
  'links-in': { why: 'Pages that other pages link to are treated as more important.', how: 'Open the Internal Links tab. Under “Link opportunities”, it lists pages that already mention this topic. Add a link there in the editor.' },
  'speed': { why: 'Google ranks fast pages higher, and slow pages lose visitors before they load.', how: 'The usual cause is a large photo. Replace big photos through the editor (it makes phone-sized copies automatically) and avoid adding heavy embeds.' },
  'basics': { why: 'Without these, phones show the desktop layout and Google can’t tell the page’s language.', how: CODE },
  'faq': { why: 'Answer engines like Google’s answer boxes, ChatGPT and Perplexity quote short question-and-answer pairs directly. An FAQ is the easiest way to be the answer they pick.', how: 'Add 3 to 7 real questions customers ask, each answered in 2 or 3 sentences. Existing FAQ answers can be edited in the editor. To add new questions: ' + CODE },
  'faq-schema': { why: 'Google and AI tools read a hidden copy of the FAQ. If it doesn’t match what people see, they may ignore it.', how: 'This is now fixed automatically: publishing a page from the editor updates the hidden FAQ data to match the visible questions.' },
  'questions': { why: 'People type questions into Google and AI tools. Headings phrased as questions match those searches word for word.', how: 'Phrase a few headings the way customers ask, such as “What size AdjustaStairs do I need?”. FAQ questions count.' },
  'answer-first': { why: 'Answer engines prefer pages that answer the question in the first few sentences, then explain.', how: 'Start the page with a 1 to 3 sentence summary that directly answers what the page is about, before the long explanation.' },
  'lists': { why: 'Lists and tables (specs, steps, comparisons) are the parts answer engines lift most often.', how: 'Turn specs, steps or comparisons into a bulleted list or table.' },
  'breadcrumb': { why: 'Breadcrumb data shows Google where the page sits on the site, and can show as a path in search results.', how: CODE },
  'page-type': { why: 'Structured data tells Google exactly what the page is: a product, a service, an article or how-to steps.', how: CODE },
  'organization': { why: 'AI tools give more weight to content when they can tell who published it.', how: 'Add Organization (ATI Products, LLC) to the page’s structured data. ' + CODE },
  'facts': { why: 'AI answers cite pages that state concrete facts: measurements, ratings, standards, prices, timeframes and counts. Vague pages don’t get quoted.', how: 'Add real, specific facts in the editor, such as heights, weight ratings, OSHA rule numbers, turnaround times, years in business or how many customers you’ve served. Only use facts that are true.' },
  'sources': { why: 'Linking to the official source (an OSHA rule, an ANSI standard, Google’s own help pages) makes your claims checkable, which AI tools reward.', how: 'Where the page mentions a rule or standard, select those words in the editor and link them to the official page, for example the rule on osha.gov.' },
  'brand': { why: 'Naming ATI ties the facts to your company, so an AI answer mentions ATI instead of just the facts.', how: 'Mention ATI by name a few times where it reads naturally, like “ATI Construction Products quotes these the same day”.' },
  'freshness': { why: 'AI tools and Google prefer content that shows it is current.', how: 'This is now automatic: publishing a page from the editor records today’s date in the sitemap and in the page’s data.' },
  'llms': { why: 'llms.txt is a short guide to the site written for AI tools. Pages listed there are easier for them to find and describe correctly.', how: 'Add a one-line summary of the page to llms.txt. ' + CODE },
  'depth': { why: 'The pages AI tools cite are usually thorough: 600+ words that cover the topic from several angles.', how: 'Add sections that answer the next questions a customer would have: how it works, what it costs or depends on, how to choose, and an FAQ.' },
  'contact': { why: 'A visible phone number is a trust signal for people and helps AI tools connect the page to a real local business.', how: 'Mention (800) 360-6115 on the page, for example in a call-to-action line.' },
  'ai-bots': { why: 'If robots.txt blocks AI crawlers, they can’t read the site, so they can’t cite it.', how: 'Allow GPTBot, ClaudeBot, PerplexityBot and Google-Extended in robots.txt.' },
};

// Kinds of facts that fit each page, for the “facts only you can provide” list.
const FACT_PROMPTS = {
  '/googleadsmanagement': 'Typical results for clients (cost per lead before and after, number of accounts managed, average response time).',
  '/leadgeneration': 'How many businesses use Leads Plus, how fast leads show up, how many lead sources it connects.',
  '/marketinghub': 'Which platforms it connects (by name and count), how often data refreshes, how many businesses use it.',
  '/subsidiaries': 'Founding year of each subsidiary, number of products, states served, customers or projects.',
  '/website-design-for-contractors': 'Typical build time, number of sites built, average speed scores, what’s included (number of pages, revisions).',
  '/offerings': 'Counts and timeframes: product lines, services, quote turnaround, states served.',
  '/z-stack-stair-tower': 'Towers ATI has supplied (count, tallest height), typical lead time and delivery, whether rentals are offered.',
  '/affiliates': 'How long ATI has used each partner and what it’s used for (number of sites hosted, years on SiteDocs).',
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Pages that are tools rather than articles. Judging the contact form or
// the blog's list of posts on FAQ sections and word count would be unfair,
// so those checks are skipped for them.
const UTILITY_PAGES = new Set(['/contact', '/blog']);
const SKIP_ON_UTILITY = new Set(['words', 'faq', 'questions', 'lists', 'depth', 'facts', 'sources', 'answer-first']);

function scorePage(p, ctx) {
  const utility = UTILITY_PAGES.has(p.path);
  const results = CHECKS.map((ch) => {
    let pass = null;
    let note = '';
    if (utility && SKIP_ON_UTILITY.has(ch.id)) {
      note = 'Doesn’t apply to this kind of page.';
    } else {
      try { pass = ch.test(p, ctx); } catch (e) { pass = null; }
      if (pass === null) note = ch.id === 'speed' ? 'Not measured yet.' : 'Not checked yet.';
    }
    return {
      id: ch.id, pillar: ch.pillar, label: ch.label, weight: ch.weight, severity: ch.severity, meta: !!ch.meta,
      pass, note,
      fix: pass === false ? ch.fix(p, ctx) : '',
    };
  });
  const score = (pillar) => {
    const list = results.filter((r) => r.pillar === pillar && r.pass !== null);
    const total = list.reduce((s, r) => s + r.weight, 0);
    const got = list.filter((r) => r.pass).reduce((s, r) => s + r.weight, 0);
    return total ? Math.round((got / total) * 100) : null;
  };
  return { checks: results, scores: { seo: score('SEO'), aeo: score('AEO'), geo: score('GEO') } };
}

// ---------- links between pages ----------

// Phrases that mean "this page" when they show up in another page's text.
const LINK_PHRASES = {
  '/adjustastair': ['adjustastairs'],
  '/adjustastairspecs': ['size calculator', 'adjustastairs specs'],
  '/z-stack-stair-tower': ['z-stack', 'stair tower'],
  '/debris-netting': ['debris netting', 'safety netting'],
  '/used-scaffolding': ['used scaffolding'],
  '/website-design-for-contractors': ['website design', 'website building', 'contractor website'],
  '/scaffoldingmarketplace': ['scaffold exchange'],
  '/leadgeneration': ['leads plus'],
  '/googleadsmanagement': ['google ads management', 'google ads'],
  '/marketinghub': ['marketing hub'],
  '/coloradoconstructionsupply': ['ati construction products'],
  '/oshastairwayrequirements': ['osha stairway'],
  '/buyingvsrentingscaffolding': ['renting scaffolding', 'buying vs. renting'],
  '/choosingtemporaryroofaccess': ['roof access'],
  '/crmreplacementforcontractors': ['crm'],
  '/marketingchannelsforservicebusinesses': ['marketing channels'],
  '/contact': [],
  '/': [],
  '/about': [],
  '/affiliates': [],
  '/blog': [],
  '/offerings': [],
  '/subsidiaries': ['subsidiaries'],
};

function cleanTitle(t) {
  return String(t || '').replace(/[™®]/g, '').replace(/\(.*?\)/g, '').trim().toLowerCase();
}

function linkGraph(pages) {
  const inbound = {};
  const inboundAll = {};
  const from = {};
  pages.forEach((p) => { inbound[p.path] = 0; inboundAll[p.path] = 0; from[p.path] = []; });
  pages.forEach((p) => {
    p.internalOut.forEach((t) => { if (t in inbound) { inbound[t]++; from[t].push(p.path); } });
    p.allOut.forEach((t) => { if (t in inboundAll) inboundAll[t]++; });
  });
  // Pages that mention another page's topic in their text but don't link to it.
  const opportunities = [];
  pages.forEach((target) => {
    const phrases = target.path in LINK_PHRASES ? LINK_PHRASES[target.path] : [cleanTitle(target.manifestTitle || target.title)].filter((x) => x && x.length > 4);
    if (!phrases.length) return;
    pages.forEach((src) => {
      if (src.path === target.path || src.internalOut.includes(target.path)) return;
      const text = src.mainText.toLowerCase();
      const hit = phrases.find((ph) => new RegExp('\\b' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text));
      if (hit) opportunities.push({ from: src.path, fromTitle: src.manifestTitle || src.title, to: target.path, toTitle: target.manifestTitle || target.title, phrase: hit });
    });
  });
  return { inbound, inboundAll, from, opportunities };
}

// ---------- site-wide checks ----------
//
// fetched: { home: {status, headers, html}, robots: {status, text},
//   sitemap: {status, text}, llms: {status, text}, notFound: {status},
//   apex: {status, location} }

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

function robotsBlocks(robotsText, agent) {
  // Groups of "User-agent" lines followed by rules. Returns true if the
  // agent (or *, when it has no group of its own) is disallowed from "/".
  const lines = String(robotsText || '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  lines.forEach((l) => {
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
    } else {
      if (cur && (k === 'disallow' || k === 'allow')) cur.rules.push({ k, v: m[2] });
      lastWasAgent = false;
    }
  });
  const own = groups.find((g) => g.agents.includes(agent.toLowerCase()));
  const g = own || groups.find((x) => x.agents.includes('*'));
  if (!g) return false;
  const dis = g.rules.some((r) => r.k === 'disallow' && r.v === '/');
  const allowRoot = g.rules.some((r) => r.k === 'allow' && r.v === '/');
  return dis && !allowRoot;
}

function parseSitemap(text) {
  const paths = new Set();
  const lastmod = {};
  const re = /<url>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/i) || [])[1];
    if (!loc) continue;
    const p = linkTarget(loc, '/');
    if (!p) continue;
    paths.add(p);
    const lm = (m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i) || [])[1];
    if (lm) lastmod[p] = lm;
  }
  return { paths, lastmod };
}

function parseLlms(text) {
  const set = new Set();
  (String(text || '').match(/https?:\/\/[^\s)\]]+/g) || []).forEach((u) => { const p = linkTarget(u, '/'); if (p) set.add(p); });
  return set;
}

function siteChecks(f, pages) {
  const out = [];
  const add = (id, label, pass, severity, fix, detail) => out.push({ id, label, pass, severity, fix: pass === false ? fix : '', detail: detail || '' });
  const h = (f.home && f.home.headers) || {};
  add('https', 'HTTPS with HSTS', f.home ? !!h['strict-transport-security'] : null, 'high', 'Turn on HTTPS with a Strict-Transport-Security header (Vercel does this automatically for your domain).');
  add('www', 'Address without www forwards to www', f.apex ? [301, 308].includes(f.apex.status) && /^https:\/\/www\./.test(f.apex.location || '') : null, 'medium', 'Make ati-products.com permanently forward to https://www.ati-products.com in Vercel’s domain settings.', f.apex ? `${f.apex.status} → ${f.apex.location || 'nowhere'}` : '');
  add('robots', 'robots.txt found and not blocking Google', f.robots ? f.robots.status === 200 && !robotsBlocks(f.robots.text, 'Googlebot') : null, 'critical', 'robots.txt is missing or blocks Google. It should allow all pages except /admin and /api.');
  add('robots-sitemap', 'robots.txt points to the sitemap', f.robots ? /^\s*sitemap\s*:/im.test(f.robots.text || '') : null, 'low', 'Add a “Sitemap: https://www.ati-products.com/sitemap.xml” line to robots.txt.');
  const blocked = f.robots ? AI_BOTS.filter((b) => robotsBlocks(f.robots.text, b)) : [];
  add('ai-bots', 'AI crawlers allowed', f.robots ? blocked.length === 0 : null, 'high', `robots.txt blocks ${blocked.join(', ')}. Allow them so AI answers can cite the site.`);
  let sm = null;
  if (f.sitemap && f.sitemap.status === 200) sm = parseSitemap(f.sitemap.text);
  add('sitemap', 'sitemap.xml found and valid', f.sitemap ? !!sm && sm.paths.size > 0 : null, 'critical', 'sitemap.xml is missing or can’t be read.', sm ? `${sm.paths.size} pages listed` : '');
  if (sm && pages) {
    const missing = pages.filter((p) => !sm.paths.has(p.path)).map((p) => p.path);
    add('sitemap-complete', 'Every page is in the sitemap', missing.length === 0, 'high', `Add ${missing.join(', ')} to sitemap.xml.`, missing.length ? `${missing.length} missing` : 'all listed');
  }
  add('404', 'Missing pages return a real 404', f.notFound ? f.notFound.status === 404 : null, 'medium', 'Addresses that don’t exist should return a 404 status, not a normal page.', f.notFound ? `returned ${f.notFound.status}` : '');
  const llms = f.llms && f.llms.status === 200 ? parseLlms(f.llms.text) : null;
  add('llms', 'llms.txt found', f.llms ? !!llms : null, 'medium', 'Add an llms.txt file that summarizes the site for AI tools.', llms ? `${llms.size} pages described` : '');
  if (pages) {
    const noViewport = pages.filter((p) => !/width=device-width/.test(p.viewport)).length;
    add('viewport', 'Phone-friendly viewport on every page', noViewport === 0, 'high', `${noViewport} page(s) are missing the viewport tag.`);
    const badLd = pages.filter((p) => !p.jsonLdValid).length;
    add('json-ld', 'Structured data readable on every page', badLd === 0, 'high', `${badLd} page(s) have structured data with errors.`);
    const noindex = pages.filter((p) => /noindex/i.test(p.robots)).map((p) => p.path);
    add('robots-meta', 'No page accidentally hidden from Google', noindex.length === 0, 'critical', `These pages say noindex: ${noindex.join(', ')}.`);
    const dupTitles = {};
    pages.forEach((p) => { (dupTitles[p.title] = dupTitles[p.title] || []).push(p.path); });
    const dups = Object.values(dupTitles).filter((l) => l.length > 1);
    add('unique-titles', 'Every page has its own title', dups.length === 0, 'medium', `Pages sharing a title: ${dups.map((l) => l.join(' and ')).join('; ')}.`);
    const dupDesc = {};
    pages.forEach((p) => { if (p.description) (dupDesc[p.description] = dupDesc[p.description] || []).push(p.path); });
    const dd = Object.values(dupDesc).filter((l) => l.length > 1);
    add('unique-descriptions', 'Every page has its own description', dd.length === 0, 'low', `Pages sharing a description: ${dd.map((l) => l.join(' and ')).join('; ')}.`);
    const urls = pages.filter((p) => /[A-Z_ ]/.test(p.path)).map((p) => p.path);
    add('urls', 'Clean, lowercase addresses', urls.length === 0, 'low', `Addresses with capitals, spaces or underscores: ${urls.join(', ')}.`);
    const org = pages.find((p) => p.path === '/');
    add('org-home', 'Homepage describes the company (Organization data)', org ? org.schemaTypes.some((t) => /Organization|LocalBusiness/.test(t)) : null, 'medium', 'Add Organization or LocalBusiness structured data to the homepage.');
  }
  return { checks: out, sitemap: sm, llms, aiBotsAllowed: f.robots ? blocked.length === 0 : null };
}

// ---------- Search Console helpers ----------

// Expected click-through rate by position (rounded industry averages).
const CTR = [0, 0.28, 0.15, 0.11, 0.08, 0.065, 0.05, 0.04, 0.032, 0.027, 0.023, 0.015, 0.013, 0.011, 0.01, 0.009, 0.008, 0.007, 0.006, 0.006, 0.005];
function expectedCtr(pos) {
  const i = Math.max(1, Math.min(20, Math.round(pos)));
  return pos > 20 ? 0.003 : CTR[i];
}

// rows: [{keys:[query, page], clicks, impressions, ctr, position}]
function strikingDistance(rows, minImpressions) {
  const min = minImpressions || 10;
  const byQuery = {};
  rows.forEach((r) => {
    const q = r.keys[0];
    const cur = byQuery[q];
    if (!cur || r.impressions > cur.impressions) byQuery[q] = { query: q, page: r.keys[1] ? linkTarget(r.keys[1], '/') || r.keys[1] : '', clicks: 0, impressions: 0, position: r.position, _w: 0 };
  });
  // Totals across pages for the query.
  const totals = {};
  rows.forEach((r) => {
    const q = r.keys[0];
    const t = totals[q] || (totals[q] = { clicks: 0, impressions: 0, posw: 0 });
    t.clicks += r.clicks; t.impressions += r.impressions; t.posw += r.position * r.impressions;
  });
  return Object.keys(byQuery).map((q) => {
    const t = totals[q];
    const position = t.impressions ? t.posw / t.impressions : byQuery[q].position;
    const extra = Math.max(0, Math.round(t.impressions * expectedCtr(3) - t.clicks));
    return { query: q, page: byQuery[q].page, clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : 0, position, extraAt3: extra };
  }).filter((r) => r.position >= 3.5 && r.position <= 20.5 && r.impressions >= min)
    .sort((a, b) => b.extraAt3 - a.extraAt3 || b.impressions - a.impressions);
}

// ---------- recommendations ----------

function recId(source, key, path) {
  const s = `${source}|${key}|${path}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'r' + h.toString(36);
}

// Everything worth fixing, as one list. ctx carries: pages (scored),
// siteChecks, index (path -> inspection result), speed, striking, pageStats
// (path -> {clicks, impressions, ctr, position}).
function recommendations(ctx) {
  const out = [];
  const push = (r) => { r.id = recId(r.source, r.key, r.path); out.push(r); };
  (ctx.pages || []).forEach((p) => {
    p.checks.filter((c) => c.pass === false && c.id !== 'ai-bots').forEach((c) => {
      push({ source: 'Page check', key: c.id, path: p.path, pillar: c.pillar, severity: c.severity, title: `${p.manifestTitle || p.title}: ${c.label}`, finding: c.fix });
    });
  });
  (ctx.siteChecks || []).filter((c) => c.pass === false).forEach((c) => {
    push({ source: 'Site check', key: c.id, path: '/', pillar: 'Tech', severity: c.severity, title: c.label, finding: c.fix });
  });
  const idx = ctx.index || {};
  (ctx.pages || []).forEach((p) => {
    const r = idx[p.path];
    if (!r) return;
    const indexed = /indexed/i.test(r.coverageState || '') && !/not indexed/i.test(r.coverageState || '');
    if (r.verdict && r.verdict !== 'PASS' && !indexed) {
      push({ source: 'Index status', key: 'not-indexed', path: p.path, pillar: 'Tech', severity: /unknown/i.test(r.coverageState || '') ? 'high' : 'critical',
        title: `${p.manifestTitle || p.title} is not indexed by Google`, finding: `Google says: “${r.coverageState || 'not indexed'}”. In Search Console, inspect ${p.url} and click Request indexing. If it stays out, check the page’s content is unique and linked from other pages.` });
    } else if (r.googleCanonical && r.userCanonical && r.googleCanonical.replace(/\/+$/, '') !== r.userCanonical.replace(/\/+$/, '')) {
      push({ source: 'Index status', key: 'canonical-mismatch', path: p.path, pillar: 'Tech', severity: 'high',
        title: `Google picked a different main address for ${p.manifestTitle || p.title}`, finding: `Google chose ${r.googleCanonical} instead of ${r.userCanonical}. Make the page’s content clearly different from that page.` });
    }
  });
  (ctx.striking || []).slice(0, 15).forEach((s) => {
    const sev = s.extraAt3 >= 10 ? 'high' : s.extraAt3 >= 3 ? 'medium' : 'low';
    push({ source: 'Search Console', key: 'striking:' + s.query, path: s.page || '/', pillar: 'SEO', severity: sev,
      title: `“${s.query}” is at #${s.position.toFixed(1)}: within reach of the top 3`,
      finding: `${s.impressions} people saw it in the last 28 days and ${s.clicks} clicked. Use the exact phrase in ${s.page || 'the page'}’s title, main heading and one subheading, and answer it in the FAQ. About ${s.extraAt3} more clicks a month at #3.` });
  });
  Object.keys(ctx.pageStats || {}).forEach((path) => {
    const st = ctx.pageStats[path];
    if (st.impressions >= 100 && st.position <= 15 && st.ctr < expectedCtr(st.position) * 0.5) {
      push({ source: 'Search Console', key: 'low-ctr', path, pillar: 'SEO', severity: 'medium',
        title: `Few people click ${path} in Google`, finding: `${st.impressions} views, ${(st.ctr * 100).toFixed(1)}% clicked (about ${(expectedCtr(st.position) * 100).toFixed(0)}% is normal at #${st.position.toFixed(1)}). Rewrite the title and description to match what people searched and give a reason to click.` });
    }
  });
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title));
}

module.exports = {
  brandText,
  parsePage, scorePage, linkGraph, siteChecks, parseSitemap, parseLlms, robotsBlocks,
  strikingDistance, expectedCtr, recommendations, recId, pathFor, linkTarget, textOf, CHECKS, AI_BOTS,
  GUIDE, FACT_PROMPTS, UTILITY_PAGES,
};
