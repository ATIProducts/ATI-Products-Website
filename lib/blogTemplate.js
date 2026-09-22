// lib/blogTemplate.js
//
// Turns the fields typed into the "New Blog Post" form into a complete,
// styled HTML page that matches the rest of the site, by filling in the
// {{PLACEHOLDER}} markers in admin/templates/blog-post-template.html.
//
// Keeping the template as a real HTML file (rather than a JS string)
// means the page's look — nav, footer, fonts, colors — automatically
// stays in sync with the rest of the site whenever that template file is
// updated, without anyone having to touch this code.

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escapes text for safe use *inside* a JSON string that itself sits inside
// an HTML <script type="application/ld+json"> block.
function escapeJsonString(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

// Rich text HTML coming from the editor is trusted (admin-only, password
// protected) but we still strip anything that could execute script, as a
// defensive floor.
function sanitizeBodyHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/ on[a-z]+="[^"]*"/gi, '')
    .replace(/ on[a-z]+='[^']*'/gi, '');
}

function estimateReadTime(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// fields: { title, category, metaDescription, metaKeywords, heroImageSrc,
//           heroImageAlt, heroCaption, bodyHtml, slug? }
function renderBlogPostHtml(templateSource, fields) {
  const title = String(fields.title || '').trim();
  if (!title) throw new Error('Post title is required.');

  const slug = fields.slug ? slugify(fields.slug) : slugify(title);
  if (!slug) throw new Error('Could not generate a URL slug from the title.');

  const bodyHtml = sanitizeBodyHtml(fields.bodyHtml);
  if (!bodyHtml || bodyHtml.replace(/<[^>]+>/g, '').trim().length < 20) {
    throw new Error('Post body looks too short — write a bit more before publishing.');
  }

  const replacements = {
    '{{POST_TITLE}}': escapeHtml(title),
    '{{POST_HEADLINE}}': escapeHtml(title),
    '{{META_DESCRIPTION}}': escapeHtml(fields.metaDescription || title),
    '{{META_KEYWORDS}}': escapeHtml(fields.metaKeywords || ''),
    '{{SLUG}}': slug,
    '{{CATEGORY}}': escapeHtml(fields.category || 'ATI Products'),
    '{{READ_TIME}}': escapeHtml(estimateReadTime(bodyHtml)),
    '{{HERO_IMAGE_SRC}}': escapeHtml(fields.heroImageSrc || 'images/construction-site-background.webp'),
    '{{HERO_IMAGE_ALT}}': escapeHtml(fields.heroImageAlt || title),
    '{{HERO_CAPTION}}': escapeHtml(fields.heroCaption || ''),
    '{{DATE_PUBLISHED}}': fields.datePublished || todayISODate(),
    '{{ARTICLE_BODY_HTML}}': bodyHtml, // intentionally not escaped — this IS the HTML body
  };

  // The JSON-LD block needs its own escaping rules (it's JSON, not HTML
  // attribute text), so headline/description there get the JSON-safe
  // escaper instead of escapeHtml. Because {{POST_HEADLINE}} and
  // {{META_DESCRIPTION}} are reused both inside visible HTML and inside
  // the JSON-LD <script> block in the template, we do a second, narrower
  // pass just for the JSON-LD script section.
  let html = templateSource;
  for (const [marker, value] of Object.entries(replacements)) {
    html = html.split(marker).join(value);
  }

  // Fix up JSON-LD specifically: the two headline occurrences and the
  // description need JSON escaping, not HTML escaping. We already
  // substituted the HTML-escaped version everywhere above, so re-run a
  // targeted replace inside just the <script type="application/ld+json">
  // block using the raw (unescaped) values.
  html = html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (full, jsonBlock) => {
    let fixed = jsonBlock
      .split(escapeHtml(title)).join(escapeJsonString(title))
      .split(escapeHtml(fields.metaDescription || title)).join(escapeJsonString(fields.metaDescription || title));
    return `<script type="application/ld+json">${fixed}</script>`;
  });

  return { html, slug };
}

// The card markup inserted into blog.html's grid for a newly published
// post. Matches the existing .blog-card structure exactly.
function renderBlogCardHtml({ slug, title, excerpt, heroImageSrc, heroImageAlt, category }) {
  return `<a href="${escapeHtml(slug)}.html" class="blog-card reveal">
  <div class="blog-card-img"><img loading="lazy" decoding="async" src="${escapeHtml(
    heroImageSrc || 'images/construction-site-background.webp'
  )}" alt="${escapeHtml(heroImageAlt || title)}" width="400" height="160"></div>
  <div class="blog-card-body">
    <span class="bc-tag">${escapeHtml(category || 'ATI Products')}</span>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(excerpt || '')}</p>
    <span class="bc-read">Read the guide &rarr;</span>
  </div>
</a>`;
}

function renderSitemapEntry(slug) {
  return `  <url>\n    <loc>https://www.atiproductsllc.com/${slug}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
}

module.exports = {
  slugify,
  escapeHtml,
  sanitizeBodyHtml,
  estimateReadTime,
  todayISODate,
  renderBlogPostHtml,
  renderBlogCardHtml,
  renderSitemapEntry,
};
