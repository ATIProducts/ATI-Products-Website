// lib/site.js
// The website's public address, used in new blog posts' search-engine tags
// and sitemap entries. Change it here (or set SITE_URL in Vercel) if the
// site ever moves to a different domain.
const SITE_URL = String(process.env.SITE_URL || 'https://www.ati-products.com').replace(/\/+$/, '');
module.exports = { SITE_URL };
