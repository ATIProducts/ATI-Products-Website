// api/pages.js
//
// GET  /api/pages             -> list of every editable page (read live
//                                 from admin/content-manifest.json, so
//                                 newly published posts show up too)
// GET  /api/pages?file=x.html -> current raw HTML of one page (fetched
//                                 live from GitHub, so it always reflects
//                                 the real deployed source, not a stale
//                                 copy)
// PUT  /api/pages { file, content } -> commits the edited HTML back to
//                                 GitHub, which triggers Vercel to
//                                 rebuild and redeploy automatically.
//
// IMPORTANT: this intentionally edits full page source, not individual
// fields. Every page on this site was hand-built with its own layout, so
// there's no single structured "content model" to map form fields onto
// without a much larger rebuild (see SETUP.md for why). The admin UI
// wraps this in a source editor with a live preview so non-technical
// edits are still safe to make.

const { requireAuth } = require('../lib/requireAuth');
const { getFile, putFile } = require('../lib/github');
const { getManifest } = require('../lib/manifest');

module.exports = requireAuth(async (req, res) => {
  if (req.method === 'GET') {
    const file = req.query && req.query.file;

    let manifest;
    try {
      manifest = await getManifest();
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }

    if (!file) {
      res.status(200).json({ pages: manifest.pages });
      return;
    }

    const match = manifest.pages.find((p) => p.file === file);
    if (!match) {
      res.status(404).json({ error: 'That file is not in the editable pages list.' });
      return;
    }

    try {
      const result = await getFile(file);
      if (!result) {
        res.status(404).json({ error: 'File not found in the repository.' });
        return;
      }
      res.status(200).json({ file, title: match.title, content: result.content, sha: result.sha });
    } catch (e) {
      res.status(502).json({ error: `Could not reach GitHub: ${e.message}` });
    }
    return;
  }

  if (req.method === 'PUT') {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch {
        body = {};
      }
    }
    const { file, content } = body || {};

    let manifest;
    try {
      manifest = await getManifest();
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }

    const match = manifest.pages.find((p) => p.file === file);
    if (!match) {
      res.status(404).json({ error: 'That file is not in the editable pages list.' });
      return;
    }
    if (typeof content !== 'string' || content.trim().length < 20) {
      res.status(400).json({ error: 'That content looks empty or too short to publish.' });
      return;
    }
    if (!/^\s*<!DOCTYPE html>/i.test(content)) {
      res.status(400).json({ error: 'Content must be a full HTML page starting with <!DOCTYPE html>.' });
      return;
    }

    try {
      const existing = await getFile(file);
      const result = await putFile(file, content, `Update ${file} via admin`, existing ? existing.sha : undefined);
      res.status(200).json({ ok: true, commit: result && result.commit && result.commit.sha });
    } catch (e) {
      res.status(502).json({ error: `Could not save to GitHub: ${e.message}` });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
