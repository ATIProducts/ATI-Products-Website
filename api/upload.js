// api/upload.js
//
// POST { filename, dataBase64, contentType } -> uploads an image into the
// repo's /images folder and commits it, same as any other change here.
// The browser reads the chosen file as base64 (FileReader.readAsDataURL)
// before sending it — nothing is stored outside your GitHub repo.
//
// Vercel's default body size limit for serverless functions is 4.5MB, so
// very large photos should be resized before upload. The admin UI warns
// about this before sending.

const { requireAuth } = require('../lib/requireAuth');
const { getFile, putBinaryFile } = require('../lib/github');
const { slugify } = require('../lib/blogTemplate');

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];

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
  const { filename, dataBase64 } = body || {};

  if (!filename || !dataBase64) {
    res.status(400).json({ error: 'Missing filename or image data.' });
    return;
  }

  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(filename);
  const ext = (extMatch ? extMatch[1] : '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    res.status(400).json({ error: `Unsupported image type ".${ext}". Use one of: ${ALLOWED_EXTENSIONS.join(', ')}.` });
    return;
  }

  const base = slugify(filename.replace(/\.[a-zA-Z0-9]+$/, '')) || 'image';
  let targetPath = `images/${base}.${ext}`;

  // Avoid clobbering an existing image with the same name.
  try {
    const existing = await getFile(targetPath);
    if (existing) {
      targetPath = `images/${base}-${Date.now()}.${ext}`;
    }
  } catch (e) {
    res.status(502).json({ error: `Could not check for an existing file: ${e.message}` });
    return;
  }

  // Strip a data: URL prefix if the client sent the raw FileReader result.
  const base64Payload = String(dataBase64).replace(/^data:[^;]+;base64,/, '');

  try {
    await putBinaryFile(targetPath, base64Payload, `Upload image ${targetPath} via admin`);
    res.status(200).json({ ok: true, path: targetPath });
  } catch (e) {
    res.status(502).json({ error: `Could not upload the image: ${e.message}` });
  }
});
