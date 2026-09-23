# ATI Products &mdash; Site Admin Setup

> The step-by-step **Setup guide** page (with a built-in password and settings
> generator) and the **How-to guide** for day-to-day editing are the easiest
> versions of these instructions. This file is the technical reference.

This adds a password-protected `/admin` page to the site so you (or your boss) can
edit any page and publish new blog posts without coming back through Claude,
copying files, or touching code.

## How it works, in plain terms

Nothing about how the site is hosted changes. It's still the same GitHub repo
that Vercel already watches and redeploys from. The admin panel just adds a
new front door: someone logs in with a password, edits a page or writes a
blog post in the browser, and clicking **Publish** saves that change straight
into your GitHub repo &mdash; the exact same thing that happens when you push a
commit from a laptop. Vercel sees the new commit and rebuilds the live site
automatically, usually within about a minute. There's no database, nothing
extra to pay for, and nothing else to maintain.

This is often called a "git-based CMS" &mdash; the same idea behind tools like
Netlify CMS/Decap CMS, just built specifically for this site so the admin
panel matches your pages exactly.

## What you get

- **`/admin/login.html`** &mdash; a password gate. Nothing behind it is reachable
  without logging in first.
- **`/admin/index.html`** &mdash; the dashboard: a list of every page on the site,
  a list of blog posts, and a **+ New Blog Post** button.
- **Edit any page by clicking on it** &mdash; the page opens looking exactly like
  the live site. Click any heading, sentence, or bullet point and type, like
  a Word document. No code, ever.
- **Bullet lists** &mdash; press Enter in a bullet to add a new one below it, or
  use the "Delete this bullet" button.
- **Change a photo by pasting** &mdash; click any photo, copy the new one from
  anywhere (a website, an email, a text message), and press Ctrl+V (Cmd+V on
  a Mac). No need to save the photo to the computer first. Dragging a photo
  in or browsing for one also works. Photos are automatically resized so
  they load fast.
- **Change where a link goes**, and edit the page's Google title and
  description, from simple buttons and boxes.
- **Write a brand-new blog post** &mdash; a simple form: title, summary, a main
  photo (paste it in), and the article (type it, or paste it from Word or an
  email &mdash; the formatting is cleaned up automatically, and photos can be
  pasted right into the article too). Publishing builds a complete new page
  in the site's existing blog style, adds it to the Blog page, and adds it to
  the sitemap &mdash; all in one step.

## One-time setup (about 15 minutes)

You'll need access to: the GitHub repo for this site, and the Vercel project
it deploys to.

### Step 1 &mdash; Add these files to the repo

Copy everything in this delivered package into the **root** of your existing
GitHub repo, alongside the existing `.html` files:

```
/admin/          (the admin panel itself)
/api/            (the server-side code that talks to GitHub)
/lib/            (shared helper code used by /api)
package.json     (only needed for one setting; see note below)
```

**If you already have a `package.json`** in the repo, don't overwrite it &mdash;
just make sure `"engines": { "node": ">=18.0.0" }` is present somewhere in
it (this admin uses the browser's built-in `fetch`, which needs Node 18+).

You do **not** need a `vercel.json` for this to work. Vercel automatically
treats any `.js` file under `/api` as a serverless function for any project,
static sites included.

### Step 2 &mdash; Create a GitHub access token

The admin needs permission to commit to your repo on your behalf.

1. In GitHub, go to **Settings → Developer settings → Personal access tokens
   → Fine-grained tokens → Generate new token**.
2. Give it a name like `ati-site-admin`.
3. Under **Repository access**, choose **Only select repositories** and pick
   this site's repo.
4. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Leave everything else as No access.
5. Generate the token and copy it somewhere safe &mdash; GitHub only shows it
   once. This is the value for `GITHUB_TOKEN` below.

(A classic personal access token with the `repo` scope also works, if your
GitHub organization requires that instead.)

### Step 3 &mdash; Choose a password and a session secret

Pick a long, random admin password &mdash; this is what your boss will type in
to log in, so make it something a password manager can generate and store,
not something guessable. You also need a separate random "session secret,"
which is never typed in by anyone; it's just used internally to sign login
sessions securely. Any long random string works &mdash; for example, generate
one at <https://1password.com/password-generator> (32+ characters) or, if
you're comfortable with a terminal, run:

```
openssl rand -base64 32
```

Do this twice: once for `ADMIN_PASSWORD`, once for `SESSION_SECRET`. Keep
them different from each other.

### Step 4 &mdash; Add environment variables in Vercel

In your Vercel project: **Settings → Environment Variables**, add each of
these (Production environment at minimum):

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token from Step 2 |
| `GITHUB_OWNER` | your GitHub username or organization name |
| `GITHUB_REPO` | the repo name (e.g. `ati-products-site`) |
| `GITHUB_BRANCH` | the branch Vercel deploys from (usually `main`) |
| `ADMIN_USERNAME` | whatever you want the login username to be (e.g. `admin`) |
| `ADMIN_PASSWORD` | the password from Step 3 |
| `SESSION_SECRET` | the second random string from Step 3 |

Save, then trigger a redeploy (Vercel usually does this automatically the
next time you push, or you can click **Redeploy** in the Vercel dashboard).

### Step 5 &mdash; Commit and push

Commit the new `/admin`, `/api`, `/lib` folders (and `package.json` if it's
new) and push to the branch Vercel deploys from. Vercel will build and go
live automatically, same as any other change.

### Step 6 &mdash; Log in

Visit `https://www.ati-products.com/admin/login.html`, log in with the
username and password from Step 4, and you're in.

Give your boss the login URL and the password (ideally through a password
manager's secure sharing, not a plain text message or email).

## Using it day to day

**Changing words on a page:** click the page name on the left. The page
opens looking just like the website. Click on the words you want to change
and type. Anything you've changed gets a light yellow highlight so you can
see it. When you're done, click the green **Publish** button at the top (it
shows how many changes you've made). The live site updates within about a
minute. Changed your mind? **Undo All Changes** puts the page back.

**Bullet points:** click a bullet and press **Enter** to add a new bullet
below it. To remove one, click it and use **Delete this bullet** in the
black bar above the page.

**Links:** click on the linked words, then **Change where this link goes**.

**Changing a photo:** click the photo on the page. A box pops up. Copy the
new photo from wherever it is (right-click a photo on a website and choose
"Copy image," or copy one from an email or text), then press **Ctrl+V**
(**Cmd+V** on a Mac). Type a few words describing the photo (this helps
Google), click **Use This Photo**, then **Publish**.

**Google listing:** open **Google search listing** above the page to change
the title and description that show up in Google search results.

**Writing a new blog post:** click **+ New Blog Post**. Fill in the title and
a short summary, paste in a main photo, and type or paste the article. Use
the buttons above the article box for headings, bold, bullet lists, and
links. Click **Publish Post** and it's live in about a minute.

**Logging out:** click **Log Out** top right. Sessions also expire on their
own after 7 days.

### What can't be edited this way

- **The top menu and the footer** appear on every page, so they aren't
  editable from the page editor (changing them on one page would make that
  page different from all the others). Ask whoever manages the site for
  those changes.
- **Page layout** &mdash; adding a whole new section or moving things around &mdash;
  isn't possible by clicking; that's a design change.
- There's a small **"Advanced: edit code"** link on each page for anyone
  technical. Your boss never needs it.

### How it works behind the scenes

Your pages were each hand-built rather than generated from a template, so
the editor works directly on each page's real code: it finds every piece
of visible text and every photo, lets you edit them in place, and when you
publish, it writes back only what you changed &mdash; leaving everything else
(styling, search-engine data, scripts) exactly as it was. Before delivery,
every one of the 19 pages was verified to come back unchanged after being
opened and saved with no edits. If a sentence you change also appears
word-for-word in the page's hidden search-engine data (for example, an FAQ
question), that copy is updated too.

## Security notes

- The password gate is enforced on the server, not just hidden in the
  browser: every save, publish, and upload action independently checks for
  a valid, signed session before doing anything. Simply knowing the `/admin`
  URL doesn't expose any content or let anyone make changes.
- Session cookies are `HttpOnly` (invisible to page JavaScript) and expire
  automatically after 7 days.
- **Everyone has their own login.** An admin adds people on the
  **People & logins** screen (as an *Editor*, who can edit, or an *Admin*,
  who can also add and remove people). New people get a temporary password
  and choose their own on first login. Every change saved to GitHub records
  who made it, in the commit message and as the commit author.
- **The main admin account** (`ADMIN_USERNAME` / `ADMIN_PASSWORD` in Vercel)
  always works and can't be removed from inside the admin. Treat it as the
  spare key. Changing `ADMIN_PASSWORD` in Vercel (then redeploying) logs that
  account out everywhere.
- **Names.** Anyone can change the name they're shown under on the
  **My account** screen (including the main admin, whose name is saved in
  the encrypted user list; it defaults to "Main admin", or to the optional
  `ADMIN_NAME` Vercel setting). Usernames don't change.
- **Activity log** (admins only). Lists every change made through the
  admin, newest first, with who made it and when, filterable by person.
  There's no separate log to maintain: it reads the GitHub commit history
  through the same `GITHUB_TOKEN`, so it also shows changes made directly
  on GitHub (marked as such). Each entry links to the exact change on
  GitHub.
- **Removing someone or resetting their password** ends their sessions
  immediately, on every computer.
- **The list of people** is stored in the repo as `admin/users.enc.json`,
  encrypted with a key derived from `SESSION_SECRET`, with each password
  additionally scrambled one-way (scrypt). Anyone can download the file, but
  it's unreadable without the secret.
- **Don't change `SESSION_SECRET`.** Doing so locks the list of people
  (only the main admin can log in until either the old secret is put back,
  or the main admin uses **Start a Fresh List** on the People screen and
  re-adds everyone). To log someone out, reset their password or remove them.

## Troubleshooting

- **"The admin isn't set up yet. Missing Vercel setting(s): ..."** &mdash; the
  settings it names aren't set in Vercel, or the project hasn't been
  redeployed since you added them.
- **Login succeeds but every page/post fails to load** &mdash; almost always a
  `GITHUB_TOKEN`, `GITHUB_OWNER`, or `GITHUB_REPO` problem. Double-check the
  token has Contents: Read and write access to the exact repo named in
  `GITHUB_REPO`.
- **"The post template is missing from the repo"** &mdash; the
  `admin/templates/blog-post-template.html` file wasn't included when you
  copied files into the repo in Step 1. Re-copy the `/admin` folder.
  Editing or deleting this template later will change what new blog posts
  look like going forward.
- **"admin/content-manifest.json is missing from the repo"** &mdash; same fix
  as above; re-copy the `/admin` folder. This file is the list of pages
  and posts the admin knows about. Every time a new blog post is
  published, the admin adds an entry to this file automatically so the
  post shows up in the sidebar for editing later &mdash; you shouldn't need
  to edit it by hand, but it's a plain JSON file if you ever do.
- **A publish seems to succeed but nothing changes on the live site** &mdash;
  check the Vercel dashboard's Deployments tab; the commit should have
  triggered a new deployment. If it didn't, confirm `GITHUB_BRANCH` matches
  the branch your Vercel project is actually set to deploy from.
