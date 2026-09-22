// api/posts.js
//
// POST /api/posts  -> publishes a brand-new blog post from form fields.
// It does four things in sequence, each a real GitHub commit:
//   1. Creates <slug>.html from admin/templates/blog-post-template.html
//      with the submitted fields filled in.
//   2. Adds it to admin/content-manifest.json so it shows up in the
//      admin's own page list for editing later.
//   3. Adds a card for it to the top of blog.html's grid.
//   4. Adds an entry for it to sitemap.xml.
// If step 1 succeeds but a later step fails, the response says exactly
// which parts completed so nothing is silently half-done.

const { requireAuth } = require('../lib/requireAuth');
const { getFile, putFile } = require('../lib/github');
const { addManifestEntry } = require('../lib/manifest');
const { renderBlogPostHtml, renderBlogCardHtml, renderSitemapEntry, slugify } = require('../lib/blogTemplate');

const TEMPLATE_PATH = 'admin/templates/blog-post-template.html';

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }

  const {
    title,
    slug: requestedSlug,
    category,
    metaDescription,
    metaKeywords,
    heroImageSrc,
    heroImageAlt,
    heroCaption,
    excerpt,
    bodyHtml,
  } = body || {};

  // 1. Load the shared template live from GitHub.
  let templateFile;
  try {
    templateFile = await getFile(TEMPLATE_PATH);
  } catch (e) {
    res.status(502).json({ error: `Could not reach GitHub to load the post template: ${e.message}` });
    return;
  }
  if (!templateFile) {
    res.status(500).json({
      error: `The post template is missing from the repo at ${TEMPLATE_PATH}. Restore it from the admin setup package.`,
    });
    return;
  }

  // 2. Render the new page.
  let rendered;
  try {
    rendered = renderBlogPostHtml(templateFile.content, {
      title,
      slug: requestedSlug,
      category,
      metaDescription,
      metaKeywords,
      heroImageSrc,
      heroImageAlt,
      heroCaption,
      bodyHtml,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const { html, slug } = rendered;
  const postFile = `${slug}.html`;

  // 3. Make sure we're not about to overwrite an existing page.
  let collision;
  try {
    collision = await getFile(postFile);
  } catch (e) {
    res.status(502).json({ error: `Could not check for an existing page at that URL: ${e.message}` });
    return;
  }
  if (collision) {
    res.status(409).json({
      error: `A page already exists at "${postFile}". Choose a different title or set a custom URL slug.`,
    });
    return;
  }

  const steps = { postCreated: false, manifestUpdated: false, blogListUpdated: false, sitemapUpdated: false };

  // 4. Commit the new post file.
  try {
    await putFile(postFile, html, `Add blog post: ${title}`);
    steps.postCreated = true;
  } catch (e) {
    res.status(502).json({ error: `Could not create the post page: ${e.message}`, steps });
    return;
  }

  // 5. Add it to the content manifest so it shows up in the admin's page
  // list for editing later. Without this the post is live but "invisible"
  // to the admin panel.
  try {
    await addManifestEntry(
      { file: postFile, title, group: 'Blog Posts', isPost: true },
      `List new blog post in admin manifest: ${title}`
    );
    steps.manifestUpdated = true;
  } catch (e) {
    steps.manifestError = e.message;
  }

  // 6. Add a card for it to blog.html (best-effort — the post itself is
  // already live even if this step has trouble).
  try {
    const blogListing = await getFile('blog.html');
    if (blogListing) {
      const cardHtml = renderBlogCardHtml({
        slug,
        title,
        excerpt: excerpt || metaDescription || '',
        heroImageSrc,
        heroImageAlt,
        category,
      });
      const marker = '<div class="blog-grid">';
      if (blogListing.content.includes(marker)) {
        const updated = blogListing.content.replace(marker, `${marker}\n    ${cardHtml}`);
        await putFile('blog.html', updated, `List new blog post on blog.html: ${title}`, blogListing.sha);
        steps.blogListUpdated = true;
      }
    }
  } catch (e) {
    // Non-fatal: the post itself published fine. Surface a warning.
    steps.blogListError = e.message;
  }

  // 7. Add it to sitemap.xml (also best-effort).
  try {
    const sitemap = await getFile('sitemap.xml');
    if (sitemap) {
      const entry = renderSitemapEntry(slug);
      const marker = '</urlset>';
      if (sitemap.content.includes(marker) && !sitemap.content.includes(`/${slug}</loc>`)) {
        const updated = sitemap.content.replace(marker, `${entry}${marker}`);
        await putFile('sitemap.xml', updated, `Add ${slug} to sitemap`, sitemap.sha);
        steps.sitemapUpdated = true;
      }
    }
  } catch (e) {
    steps.sitemapError = e.message;
  }

  res.status(200).json({
    ok: true,
    slug,
    file: postFile,
    url: `https://www.atiproductsllc.com/${slug}`,
    steps,
  });
});
