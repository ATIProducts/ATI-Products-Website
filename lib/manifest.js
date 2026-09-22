// lib/manifest.js
//
// The list of "editable pages" isn't hardcoded in the server code — it
// lives in admin/content-manifest.json, a normal file in the repo. That
// matters for one reason: when someone publishes a new blog post, the
// admin adds an entry for it to this file (see api/posts.js) so the post
// shows up in the "Blog Posts" list for editing later. If the list were
// hardcoded in code instead, every new post would be invisible to the
// admin panel until someone manually edited and redeployed the source.

const { getFile, putFile } = require('./github');

const MANIFEST_PATH = 'admin/content-manifest.json';

async function getManifest() {
  const file = await getFile(MANIFEST_PATH);
  if (!file) {
    throw new Error(
      `Couldn't find ${MANIFEST_PATH} in GitHub. Either the admin files weren't uploaded to the repo, ` +
        'or GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH in Vercel don’t match the site’s repo, ' +
        'or the GitHub access key wasn’t given access to that repo.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(file.content);
  } catch (e) {
    throw new Error(`${MANIFEST_PATH} contains invalid JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.pages)) {
    throw new Error(`${MANIFEST_PATH} is malformed (expected { "pages": [...] }).`);
  }
  return { pages: parsed.pages, sha: file.sha };
}

async function addManifestEntry(entry, commitMessage) {
  const { pages, sha } = await getManifest();
  if (pages.some((p) => p.file === entry.file)) {
    // Already listed (e.g. a retry) — nothing to do.
    return { pages, added: false };
  }
  const updatedPages = pages.concat([entry]);
  await putFile(MANIFEST_PATH, JSON.stringify({ pages: updatedPages }, null, 2) + '\n', commitMessage, sha);
  return { pages: updatedPages, added: true };
}

module.exports = { MANIFEST_PATH, getManifest, addManifestEntry };
