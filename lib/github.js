// lib/github.js
//
// A thin wrapper around the GitHub "Contents API", which lets a server
// read and write individual files in a repo and have GitHub create a real
// commit for each change. That commit is what triggers Vercel's existing
// GitHub integration to rebuild and redeploy the site — this admin never
// talks to Vercel directly, it just commits files the same way a human
// pushing from their laptop would.
//
// Requires these environment variables (see SETUP.md):
//   GITHUB_TOKEN   - a token with write access to the repo
//   GITHUB_OWNER   - the GitHub username or org that owns the repo
//   GITHUB_REPO    - the repo name
//   GITHUB_BRANCH  - which branch to commit to (defaults to "main")

const API_BASE = 'https://api.github.com';

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function repoConfig() {
  return {
    owner: envOrThrow('GITHUB_OWNER'),
    repo: envOrThrow('GITHUB_REPO'),
    branch: process.env.GITHUB_BRANCH || 'main',
    token: envOrThrow('GITHUB_TOKEN'),
  };
}

function encodePath(filePath) {
  // Encode each path segment individually so slashes stay as separators.
  return filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function ghFetch(path, options = {}) {
  const { token } = repoConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hints = {
      401: 'GitHub rejected the access key (GITHUB_TOKEN in Vercel). It may be mistyped or expired — create a new one and update it in Vercel.',
      403: 'The GitHub access key isn’t allowed to change files. Its "Contents" permission must be set to "Read and write".',
      409: 'GitHub reported a conflict (someone else may have changed this file at the same moment). Try again.',
      422: 'GitHub refused the change. Check that GITHUB_BRANCH in Vercel matches the site’s branch.',
    };
    const hint = hints[res.status] ? hints[res.status] + ' ' : '';
    const err = new Error(`${hint}(GitHub ${options.method || 'GET'} ${path} returned ${res.status}${text ? ': ' + text.slice(0, 200) : ''})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Fetch one file's current text content + its "sha" (GitHub's version
// marker — required when you go to overwrite the file, so GitHub can
// detect if someone else changed it in between).
async function getFile(filePath) {
  const { owner, repo, branch } = repoConfig();
  try {
    const data = await ghFetch(
      `/repos/${owner}/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`
    );
    if (Array.isArray(data)) {
      throw new Error(`${filePath} is a directory, not a file.`);
    }
    const content = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    return { content, sha: data.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Create or update a text file. Pass the existing sha when updating a file
// that already exists (omit it only when creating a brand-new file).
async function putFile(filePath, content, message, existingSha) {
  const { owner, repo, branch } = repoConfig();
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (existingSha) body.sha = existingSha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Same as putFile, but for binary content that's already base64-encoded
// (used for image uploads).
async function putBinaryFile(filePath, base64Content, message, existingSha) {
  const { owner, repo, branch } = repoConfig();
  const body = { message, content: base64Content, branch };
  if (existingSha) body.sha = existingSha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function listDir(dirPath) {
  const { owner, repo, branch } = repoConfig();
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodePath(dirPath)}?ref=${encodeURIComponent(branch)}`
  );
  return Array.isArray(data) ? data : [data];
}

module.exports = { getFile, putFile, putBinaryFile, listDir, repoConfig };
