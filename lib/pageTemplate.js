// lib/pageTemplate.js
//
// Builds brand-new website pages for the admin's "+ New Page" screen, in
// one of two ways:
//
//   * a SIMPLE PAGE, from admin/templates/page-template.html (same header,
//     menu, footer and styles as the rest of the site, with a title, an
//     optional line under it, an optional main photo, and the article)
//   * a COPY of an existing page, with the new name, address and Google
//     details swapped in, ready to have its words and photos changed
//
// Also adds a link to a page into the footer's "Explore" list, which is
// repeated on every page of the site.

const { SITE_URL } = require('./site');
const { slugify, escapeHtml, sanitizeBodyHtml } = require('./blogTemplate');

// Addresses that can't be used for a new page.
const RESERVED = new Set([
  'index', 'admin', 'api', 'lib', 'images', 'downloads', 'sitemap', 'robots', 'llms',
  'package', 'vercel', 'favicon', 'og-image', 'readme', 'setup', '404', '500',
]);

function pageSlug(title, requested) {
  const slug = slugify(requested || title);
  if (!slug) throw Object.assign(new Error('Please type a page name.'), { status: 400, expose: true });
  if (RESERVED.has(slug)) {
    throw Object.assign(new Error(`"${slug}" is reserved by the website. Please choose a different web address.`), { status: 400, expose: true });
  }
  return slug;
}

function jsonLd(title, description, slug) {
  const url = `${SITE_URL}/${slug}`;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: title,
        description,
        isPartOf: { '@type': 'WebSite', name: 'ATI Products, LLC', url: `${SITE_URL}/` },
        publisher: {
          '@type': 'Organization',
          name: 'ATI Products, LLC',
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/images/favicon-192x192.png` },
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: title, item: url },
        ],
      },
    ],
  };
  // "</" can't appear inside a <script> block.
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}

function defaultDescription(title) {
  return `${title} from ATI Products, LLC in Arvada, Colorado. Same-day quotes and nationwide service. Call (800) 360-6115.`;
}

// fields: { title, slug, description, keywords, subtitle, heroImageSrc,
//           heroImageAlt, bodyHtml }
function renderSimplePage(templateSource, fields) {
  const title = String(fields.title || '').trim();
  if (!title) throw Object.assign(new Error('Please type a page name.'), { status: 400, expose: true });
  const slug = pageSlug(title, fields.slug);
  const description = String(fields.description || '').trim() || defaultDescription(title);
  const bodyHtml = sanitizeBodyHtml(fields.bodyHtml);
  if (bodyHtml.replace(/<[^>]+>/g, '').trim().length < 20) {
    throw Object.assign(new Error('Please write a bit more on the page before creating it.'), { status: 400, expose: true });
  }
  const subtitle = String(fields.subtitle || '').trim();
  const hero = String(fields.heroImageSrc || '').trim();

  const replacements = {
    '{{PAGE_TITLE}}': escapeHtml(title),
    '{{META_DESCRIPTION}}': escapeHtml(description),
    '{{META_KEYWORDS}}': escapeHtml(fields.keywords || title),
    '{{SITE_URL}}': SITE_URL,
    '{{SLUG}}': slug,
    '{{JSON_LD}}': jsonLd(title, description, slug),
    '{{SUBTITLE_HTML}}': subtitle ? `    <p class="lead">${escapeHtml(subtitle)}</p>\n` : '',
    '{{HERO_FIGURE_HTML}}': hero
      ? `  <figure class="section-banner reveal">\n    <img decoding="async" loading="lazy" width="1280" height="720" src="${escapeHtml(hero)}" alt="${escapeHtml(fields.heroImageAlt || title)}">\n  </figure>\n`
      : '',
    '{{ARTICLE_BODY_HTML}}': bodyHtml,
  };
  let html = templateSource;
  // Body last, so nothing typed in the article is mistaken for a placeholder.
  Object.keys(replacements).forEach((k) => {
    if (k !== '{{ARTICLE_BODY_HTML}}') html = html.split(k).join(replacements[k]);
  });
  html = html.split('{{ARTICLE_BODY_HTML}}').join(replacements['{{ARTICLE_BODY_HTML}}']);
  return { html, slug, title, description };
}

function setMetaContent(html, attr, name, value) {
  const re = new RegExp(`(<meta\\s+${attr}="${name}"\\s+content=")[^"]*(")`, 'i');
  return html.replace(re, (m, a, b) => a + escapeHtml(value) + b);
}

function removeActiveNav(html) {
  return html
    .replace(/(<ul class="nav-links">[\s\S]*?<\/ul>)/, (block) => block.replace(/class="active"/g, 'class=""'))
    .replace(/(<div class="mobile-nav"[\s\S]*?<\/div>)/, (block) => block.replace(/class="active"/g, 'class=""'));
}

// fields: { title, slug, description, sourceFile }
function copyPage(sourceHtml, fields) {
  const title = String(fields.title || '').trim();
  if (!title) throw Object.assign(new Error('Please type a page name.'), { status: 400, expose: true });
  const slug = pageSlug(title, fields.slug);
  const description = String(fields.description || '').trim() || defaultDescription(title);
  const url = `${SITE_URL}/${slug}`;
  const fullTitle = `${title} | ATI Products`;

  let html = String(sourceHtml);
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(fullTitle)}</title>`);
  html = setMetaContent(html, 'name', 'description', description);
  html = setMetaContent(html, 'property', 'og:title', fullTitle);
  html = setMetaContent(html, 'property', 'og:description', description);
  html = setMetaContent(html, 'property', 'og:url', url);
  html = setMetaContent(html, 'name', 'twitter:title', fullTitle);
  html = setMetaContent(html, 'name', 'twitter:description', description);
  html = html.replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/i, (m, a, b) => a + url + b);

  // The original page's search-engine data describes the original page,
  // so it's replaced with fresh, accurate data for the new one.
  html = html.replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<\/head>/i, `<script type="application/ld+json">\n${jsonLd(title, description, slug)}\n</script>\n</head>`);

  // Main heading and the last breadcrumb step become the new name.
  html = html.replace(/(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/i, (m, a, b) => a + escapeHtml(title) + b);
  html = html.replace(/(<nav aria-label="Breadcrumb"[\s\S]*?)(<li\b[^>]*>)((?:(?!<li\b)[\s\S])*?)(<\/li>\s*<\/ol>)/i, (m, pre, liOpen, inner, close) =>
    /<a\b/i.test(inner) ? m : pre + liOpen + escapeHtml(title) + close
  );
  // A brand-new page sits directly under Home: drop any middle steps.
  html = html.replace(/(<nav aria-label="Breadcrumb"[^>]*>\s*<ol[^>]*>)([\s\S]*?)(<\/ol>)/i, (m, open, inner, close) => {
    const items = inner.match(/\s*<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
    if (items.length < 5) return m;
    const kept = items.slice(0, 2).concat(items.slice(-1));
    const trailing = inner.match(/\s*$/)[0];
    return open + kept.join('') + trailing + close;
  });
  html = removeActiveNav(html);
  return { html, slug, title, description };
}

// Adds <li><a href="file">label</a></li> to the footer's Explore list.
// Returns the new HTML, or null if the page has no such list or already
// links there.
function addFooterLink(html, file, label) {
  const m = /class="[^"]*\bfooter-col-explore\b[^"]*"/.exec(html);
  if (!m) return null;
  const start = m.index;
  const end = html.indexOf('</ul>', start);
  if (end === -1) return null;
  if (html.slice(start, end).includes(`href="${file}"`)) return null;
  const lineStart = html.lastIndexOf('\n', end) + 1;
  const onOwnLine = html.slice(lineStart, end).trim() === '';
  const lis = html.slice(start, end).match(/\n([ \t]*)<li\b/g);
  const indent = lis && lis.length ? lis[lis.length - 1].replace('\n', '').replace('<li', '') : '        ';
  const item = `<li><a href="${escapeHtml(file)}">${escapeHtml(label)}</a></li>`;
  if (onOwnLine) return html.slice(0, lineStart) + indent + item + '\n' + html.slice(lineStart);
  return html.slice(0, end) + item + html.slice(end);
}

// Takes a page's link back out of the footer's Explore list. Returns the
// new HTML, or null if there was nothing to remove.
function removeFooterLink(html, file) {
  const m = /class="[^"]*\bfooter-col-explore\b[^"]*"/.exec(html);
  if (!m) return null;
  const end = html.indexOf('</ul>', m.index);
  if (end === -1) return null;
  const section = html.slice(m.index, end);
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = section.replace(new RegExp(`\\n?[ \\t]*<li><a href="${esc}">[^<]*</a></li>`), '');
  if (cleaned === section) return null;
  return html.slice(0, m.index) + cleaned + html.slice(end);
}

module.exports = { renderSimplePage, copyPage, addFooterLink, removeFooterLink, pageSlug, RESERVED };
