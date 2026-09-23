// admin/admin.js
//
// Plain vanilla JS for the /admin dashboard — no build step, no framework,
// no outside scripts. The page-editing engine lives in editor-core.js
// (window.CMS); this file is the screens and buttons around it.

(function () {
  'use strict';

  var CMS = window.CMS;
  var mainEl = document.getElementById('main');
  var pagesListEl = document.getElementById('pages-list');
  var postsListEl = document.getElementById('posts-list');
  var sidebarEl = document.getElementById('sidebar');

  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var PASTE_KEYS = IS_MAC ? '⌘V' : 'Ctrl+V';

  var state = {
    pages: [],
    // Set by whichever screen is open; returns true if it has unpublished work.
    hasUnsaved: function () { return false; },
    // Set by screens that want to catch pasted photos anywhere on the screen.
    onGlobalPaste: null,
  };

  // ---------- auth ----------

  function checkAuthOrRedirect() {
    return fetch('/api/me')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.authenticated) {
          window.location.href = '/admin/login.html';
          return false;
        }
        state.me = data.user;
        return true;
      })
      .catch(function () {
        window.location.href = '/admin/login.html';
        return false;
      });
  }

  document.getElementById('logout-btn').addEventListener('click', function () {
    if (!confirmLeave()) return;
    state.hasUnsaved = function () { return false; };
    fetch('/api/logout', { method: 'POST' }).then(function () {
      window.location.href = '/admin/login.html';
    });
  });

  window.addEventListener('beforeunload', function (e) {
    if (state.hasUnsaved()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function confirmLeave() {
    if (!state.hasUnsaved()) return true;
    return window.confirm('You have changes that haven’t been published yet. Leave without publishing them?');
  }

  // ---------- helpers ----------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else if (key.indexOf('on') === 0 && typeof attrs[key] === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      } else {
        node.setAttribute(key, attrs[key]);
      }
    });
    (children || []).forEach(function (child) {
      if (child == null) return;
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    });
    return node;
  }

  function setActiveNav(button) {
    Array.prototype.forEach.call(sidebarEl.querySelectorAll('.nav-item'), function (b) {
      b.classList.remove('active');
    });
    if (button) button.classList.add('active');
  }

  function showMessage(container, text, kind) {
    container.innerHTML = '';
    var box = el('div', { class: kind === 'error' ? 'error-msg' : 'success-msg' }, [text]);
    container.appendChild(box);
    return box;
  }

  var toastTimer = null;
  function toast(text) {
    var t = document.getElementById('cms-toast');
    if (!t) {
      t = el('div', { id: 'cms-toast', class: 'toast' });
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function apiJson(url, options) {
    return fetch(url, options).then(function (res) {
      if (res.status === 401) {
        state.hasUnsaved = function () { return false; };
        window.location.href = '/admin/login.html';
        throw new Error('Your login expired. Please log in again.');
      }
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong.');
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function uploadPhoto(photo, nameHint) {
    return apiJson('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: CMS.slugify(nameHint) + '.' + photo.ext,
        dataBase64: photo.dataUrl,
      }),
    }).then(function (data) { return data.path; });
  }

  // Any paste on the dashboard goes to whichever screen asked for it.
  document.addEventListener('paste', function (e) {
    if (typeof state.onGlobalPaste === 'function') state.onGlobalPaste(e);
  });

  // ---------- photo drop zone (paste / drag / browse) ----------
  //
  // Used for the blog post main photo and for replacing photos on pages.
  // onPhoto receives { dataUrl, ext, width, height } already resized.

  function createPhotoZone(opts) {
    var preview = el('img', { class: 'photo-zone-img', alt: '' });
    var label = el('div', { class: 'photo-zone-label' }, [
      el('strong', {}, ['Paste a photo here']),
      el('span', {}, [' — copy any photo, then press ' + PASTE_KEYS + '. You can also drag one in, or ']),
      el('u', {}, ['browse your computer']),
      el('span', {}, ['.']),
    ]);
    var status = el('div', { class: 'photo-zone-status' });
    var fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    var zone = el('div', { class: 'photo-zone', tabindex: '0', role: 'button', 'aria-label': 'Paste, drop, or choose a photo' }, [
      preview, label, status, fileInput,
    ]);

    if (opts.initialSrc) {
      preview.src = opts.initialSrc;
      zone.classList.add('has-photo');
    }

    function take(file) {
      if (!file) return;
      status.textContent = 'Getting the photo ready…';
      CMS.compressImage(file).then(function (photo) {
        preview.src = photo.dataUrl;
        zone.classList.add('has-photo');
        status.textContent = 'Photo ready. It will be uploaded when you publish.';
        opts.onPhoto(photo);
      }).catch(function (err) {
        status.textContent = err.message;
      });
    }

    zone.addEventListener('click', function () { fileInput.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () { take(fileInput.files && fileInput.files[0]); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('dragging'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('dragging'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('dragging');
      var file = CMS.imageFromDataTransfer(e.dataTransfer);
      if (file) take(file);
      else status.textContent = 'That wasn’t a photo — try dragging an image file.';
    });

    return {
      el: zone,
      // Returns true if the paste contained a photo (and took it).
      handlePaste: function (e) {
        var file = CMS.imageFromDataTransfer(e.clipboardData);
        if (!file) return false;
        e.preventDefault();
        take(file);
        return true;
      },
    };
  }

  // ---------- sidebar ----------

  function loadPagesList() {
    return apiJson('/api/pages').then(function (data) {
      state.pages = data.pages || [];
      renderSidebarLists();
    });
  }

  function renderSidebarLists() {
    pagesListEl.innerHTML = '';
    postsListEl.innerHTML = '';
    state.pages.forEach(function (page) {
      var btn = el('button', {
        class: 'nav-item',
        onClick: function () {
          if (!confirmLeave()) return;
          setActiveNav(btn);
          renderPageEditor(page);
        },
      }, [page.title]);
      if (page.group === 'Blog Posts') postsListEl.appendChild(btn);
      else pagesListEl.appendChild(btn);
    });
  }

  document.querySelector('[data-view="welcome"]').addEventListener('click', function (e) {
    if (!confirmLeave()) return;
    setActiveNav(e.currentTarget);
    renderWelcome();
  });
  document.querySelector('[data-view="new-post"]').addEventListener('click', function (e) {
    if (!confirmLeave()) return;
    setActiveNav(e.currentTarget);
    renderNewPostForm();
  });
  document.querySelector('[data-view="account"]').addEventListener('click', function (e) {
    if (!confirmLeave()) return;
    setActiveNav(e.currentTarget);
    renderAccount(false);
  });
  document.querySelector('[data-view="people"]').addEventListener('click', function (e) {
    if (!confirmLeave()) return;
    setActiveNav(e.currentTarget);
    renderPeople();
  });

  function resetScreen() {
    state.hasUnsaved = function () { return false; };
    state.onGlobalPaste = null;
    mainEl.innerHTML = '';
    mainEl.classList.remove('main-wide');
  }

  // ---------- welcome ----------

  function renderWelcome() {
    resetScreen();
    mainEl.appendChild(el('h1', {}, ['Welcome']));
    mainEl.appendChild(el('p', { class: 'sub' }, [
      'Pick a page on the left to change it, or write a new blog post. Publishing puts your changes on the live website, usually within about a minute.',
    ]));
    mainEl.appendChild(el('div', { class: 'card' }, [el('div', { class: 'welcome-grid' }, [
      el('div', { class: 'welcome-tile' }, [
        el('h3', {}, ['Change words on a page']),
        el('p', {}, ['Open a page, click on any sentence, heading, or bullet point, and type — just like a Word document. Press Enter in a bullet list to add a new bullet.']),
      ]),
      el('div', { class: 'welcome-tile' }, [
        el('h3', {}, ['Change a photo']),
        el('p', {}, ['Click on any photo on a page. Then copy the new photo from anywhere (a website, an email, a text) and press ' + PASTE_KEYS + '. No need to save it first.']),
      ]),
      el('div', { class: 'welcome-tile' }, [
        el('h3', {}, ['Write a blog post']),
        el('p', {}, ['Click “+ New Blog Post,” type a title and the article, paste in a photo, and publish. It’s added to the Blog page for you.']),
      ]),
    ])]));
  }

  // ---------- page editor: click-and-type ----------

  function renderPageEditor(page) {
    resetScreen();
    mainEl.classList.add('main-wide');
    mainEl.appendChild(el('h1', {}, [page.title]));
    var loading = el('div', { class: 'card' }, ['Opening the page…']);
    mainEl.appendChild(loading);

    apiJson('/api/pages?file=' + encodeURIComponent(page.file))
      .then(function (data) {
        loading.remove();
        buildVisualEditor(page, data.content);
      })
      .catch(function (err) {
        showMessage(loading, err.message, 'error');
      });
  }

  function buildVisualEditor(page, source) {
    var master = CMS.parse(source);
    var nextId = CMS.tagEditable(master);
    var dirty = new Set();
    var photos = {}; // imgId -> { photo, alt }
    var structureChanged = false;
    var previewDoc = null;
    var focusedId = null;
    var linkTarget = null;

    var seoTitle0 = CMS.normalizeText((master.querySelector('title') || {}).textContent || '');
    var descMeta = master.querySelector('meta[name="description"]');
    var seoDesc0 = CMS.normalizeText(descMeta ? descMeta.getAttribute('content') : '');

    function changeCount() {
      var seoChanged = (seoTitleInput.value.trim() !== seoTitle0 ? 1 : 0) + (seoDescInput.value.trim() !== seoDesc0 ? 1 : 0);
      return dirty.size + Object.keys(photos).length + seoChanged + (structureChanged && !dirty.size ? 1 : 0);
    }
    state.hasUnsaved = function () { return changeCount() > 0; };

    // --- top bar ---
    var messageHost = el('div', {});
    var publishBtn = el('button', { class: 'btn btn-primary', disabled: 'disabled' }, ['Publish Changes']);
    var discardBtn = el('button', { class: 'btn btn-secondary', disabled: 'disabled' }, ['Undo All Changes']);
    var advancedLink = el('button', { class: 'link-btn' }, ['Advanced: edit code']);

    var hint = el('span', { class: 'context-hint' }, ['Click any text to change it. Click any photo to replace it.']);
    var ctxActions = el('span', { class: 'context-actions' });
    var contextBar = el('div', { class: 'context-bar' }, [hint, ctxActions]);

    var seoTitleInput = el('input', { type: 'text' });
    seoTitleInput.value = seoTitle0;
    var seoDescInput = el('textarea', { rows: '2' });
    seoDescInput.value = seoDesc0;
    seoTitleInput.addEventListener('input', updateButtons);
    seoDescInput.addEventListener('input', updateButtons);
    var seoPanel = el('details', { class: 'seo-panel' }, [
      el('summary', {}, ['Google search listing (title & description)']),
      el('div', { class: 'seo-body' }, [
        el('div', { class: 'field' }, [el('label', {}, ['Title shown in Google & browser tab']), seoTitleInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Description shown under the title in Google']), seoDescInput,
          el('div', { class: 'hint' }, ['Aim for one or two sentences (about 150–160 characters).'])]),
      ]),
    ]);

    var toolbar = el('div', { class: 'editor-toolbar' }, [
      el('div', { class: 'editor-sub' }, ['Menus and the footer appear on every page, so they aren’t editable here. ', advancedLink]),
      el('div', { style: 'display:flex;gap:10px;' }, [discardBtn, publishBtn]),
    ]);

    var iframe = el('iframe', { class: 'visual-frame', title: 'Page editor' });

    mainEl.appendChild(messageHost);
    mainEl.appendChild(toolbar);
    mainEl.appendChild(seoPanel);
    mainEl.appendChild(contextBar);
    mainEl.appendChild(iframe);

    function updateButtons() {
      var n = changeCount();
      publishBtn.disabled = n === 0;
      discardBtn.disabled = n === 0;
      publishBtn.textContent = n === 0 ? 'Publish Changes' : 'Publish ' + n + ' Change' + (n === 1 ? '' : 's');
    }

    // --- context bar (what the selected thing can do) ---
    function refreshContext() {
      ctxActions.innerHTML = '';
      if (!previewDoc || !focusedId) {
        hint.textContent = 'Click any text to change it. Click any photo to replace it.';
        return;
      }
      var host = previewDoc.querySelector('[data-cms-id="' + focusedId + '"]');
      if (!host) { focusedId = null; return refreshContext(); }
      var isLi = host.tagName === 'LI';
      hint.textContent = isLi ? 'Editing a bullet point. Press Enter to add another below it.' : 'Editing text. Just type — it saves when you click Publish.';

      if (isLi) {
        ctxActions.appendChild(el('button', { class: 'chip', onClick: function () { addBulletAfter(focusedId); } }, ['+ Add bullet below']));
        ctxActions.appendChild(el('button', { class: 'chip chip-danger', onClick: function () { deleteBullet(focusedId); } }, ['Delete this bullet']));
      }
      if (linkTarget) {
        ctxActions.appendChild(el('button', { class: 'chip', onClick: changeLink }, ['Change where this link goes']));
      }
    }

    function changeLink() {
      if (!linkTarget) return;
      var current = linkTarget.getAttribute('href') || '';
      var next = window.prompt(
        'Where should this link go?\n\nFor another page on this site, use its name like "offerings.html". For another website, paste the full address starting with https://',
        current
      );
      if (next == null) return;
      next = next.trim();
      if (!next || next === current) return;
      linkTarget.setAttribute('href', next);
      var host = linkTarget.closest('[data-cms-id]') || linkTarget;
      markDirty(host.getAttribute('data-cms-id'));
      toast('Link updated.');
    }

    function markDirty(id) {
      if (!id) return;
      dirty.add(id);
      var host = previewDoc.querySelector('[data-cms-id="' + id + '"]');
      if (host) host.classList.add('cms-edited');
      updateButtons();
    }

    // --- bullets ---
    function wireEditable(node) {
      var mode = 'plaintext-only';
      node.setAttribute('contenteditable', mode);
      if (node.contentEditable !== mode) node.setAttribute('contenteditable', 'true');
      node.setAttribute('spellcheck', 'true');
      Array.prototype.forEach.call(node.querySelectorAll('img, svg'), function (x) {
        x.setAttribute('contenteditable', 'false');
      });
    }

    function selectAllIn(node) {
      var win = iframe.contentWindow;
      var range = previewDoc.createRange();
      range.selectNodeContents(node.lastChild && node.lastChild.nodeType === 3 ? node.lastChild : node);
      var sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function addBulletAfter(id) {
      var newId = String(nextId++);
      CMS.insertListItemAfter(master, id, newId, 'New bullet point');
      var item = CMS.insertListItemAfter(previewDoc, id, newId, 'New bullet point');
      if (!item) return;
      wireEditable(item);
      structureChanged = true;
      markDirty(newId);
      item.focus();
      selectAllIn(item);
      focusedId = newId;
      refreshContext();
    }

    function deleteBullet(id) {
      var host = previewDoc.querySelector('[data-cms-id="' + id + '"]');
      var label = host ? CMS.normalizeText(host.textContent).slice(0, 60) : '';
      if (!window.confirm('Delete this bullet point?\n\n“' + label + '”')) return;
      CMS.removeById(master, id);
      CMS.removeById(previewDoc, id);
      dirty.delete(id);
      structureChanged = true;
      focusedId = null;
      linkTarget = null;
      refreshContext();
      updateButtons();
    }

    // --- photos ---
    function openPhotoDialog(img) {
      var imgId = img.getAttribute('data-cms-img');
      var picked = null;
      var altInput = el('input', { type: 'text' });
      altInput.value = img.getAttribute('alt') || '';
      var zone = createPhotoZone({
        initialSrc: img.currentSrc || img.src,
        onPhoto: function (p) { picked = p; useBtn.disabled = false; },
      });
      var useBtn = el('button', { class: 'btn btn-primary', disabled: 'disabled' }, ['Use This Photo']);
      var cancelBtn = el('button', { class: 'btn btn-secondary' }, ['Cancel']);
      var modal = el('div', { class: 'modal-backdrop' }, [
        el('div', { class: 'modal', role: 'dialog', 'aria-label': 'Replace photo' }, [
          el('h2', {}, ['Replace this photo']),
          el('p', { class: 'sub' }, ['Copy the new photo from anywhere — a website, an email, a text message — then press ' + PASTE_KEYS + '.']),
          zone.el,
          el('div', { class: 'field', style: 'margin-top:16px;' }, [
            el('label', {}, ['Describe the photo in a few words (helps Google)']),
            altInput,
          ]),
          el('div', { class: 'modal-actions' }, [cancelBtn, useBtn]),
        ]),
      ]);

      var prevPaste = state.onGlobalPaste;
      state.onGlobalPaste = function (e) {
        if (!zone.handlePaste(e)) toast('That wasn’t a photo. Copy a photo, then paste.');
      };
      function close() {
        state.onGlobalPaste = prevPaste;
        document.removeEventListener('keydown', onKey);
        modal.remove();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      cancelBtn.addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      useBtn.addEventListener('click', function () {
        if (!picked) return;
        img.setAttribute('src', picked.dataUrl);
        img.removeAttribute('srcset');
        img.setAttribute('alt', altInput.value.trim() || img.getAttribute('alt') || '');
        photos[imgId] = { photo: picked, alt: altInput.value.trim() };
        img.classList.add('cms-edited');
        updateButtons();
        close();
        toast('Photo swapped. Click Publish to put it on the live site.');
      });
      document.body.appendChild(modal);
      zone.el.focus();
    }

    // --- load the page into the editor ---
    iframe.addEventListener('load', function () {
      previewDoc = iframe.contentDocument;
      if (!previewDoc || !previewDoc.body) return;

      Array.prototype.forEach.call(previewDoc.querySelectorAll('[data-cms-id]'), wireEditable);

      previewDoc.addEventListener('input', function (e) {
        var host = e.target && e.target.closest && e.target.closest('[data-cms-id]');
        if (host) markDirty(host.getAttribute('data-cms-id'));
      });

      previewDoc.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var host = e.target && e.target.closest && e.target.closest('[data-cms-id]');
        if (!host) return;
        e.preventDefault();
        if (host.tagName === 'LI') addBulletAfter(host.getAttribute('data-cms-id'));
        else host.blur();
      });

      // Pasting into text: plain words only, so formatting from Word or
      // email can't sneak in and break the page's look.
      previewDoc.addEventListener('paste', function (e) {
        var host = e.target && e.target.closest && e.target.closest('[data-cms-id]');
        if (!host) return;
        e.preventDefault();
        var text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        if (!text && CMS.imageFromDataTransfer(e.clipboardData)) {
          toast('To change a photo, click on the photo itself, then paste.');
          return;
        }
        text = text.replace(/\s*\n+\s*/g, ' ');
        previewDoc.execCommand('insertText', false, text);
      });

      previewDoc.addEventListener('drop', function (e) { e.preventDefault(); });
      previewDoc.addEventListener('dragover', function (e) { e.preventDefault(); });

      previewDoc.addEventListener('click', function (e) {
        var img = e.target.closest && e.target.closest('img[data-cms-img]');
        if (img) {
          e.preventDefault();
          openPhotoDialog(img);
          return;
        }
        if (e.target.closest && e.target.closest('a')) e.preventDefault();
      }, true);
      previewDoc.addEventListener('submit', function (e) { e.preventDefault(); }, true);

      function trackSelection() {
        var active = previewDoc.activeElement;
        var host = active && active.closest && active.closest('[data-cms-id]');
        focusedId = host ? host.getAttribute('data-cms-id') : null;
        linkTarget = null;
        if (host) {
          if (host.tagName === 'A') linkTarget = host;
          else {
            var sel = previewDoc.getSelection();
            var node = sel && sel.anchorNode;
            var elNode = node && (node.nodeType === 1 ? node : node.parentElement);
            var a = elNode && elNode.closest && elNode.closest('a');
            if (a && host.contains(a)) linkTarget = a;
          }
        }
        refreshContext();
      }
      previewDoc.addEventListener('focusin', trackSelection);
      previewDoc.addEventListener('selectionchange', trackSelection);
    });

    iframe.srcdoc = CMS.buildPreviewHtml(master, window.location.origin + '/');

    // --- buttons ---
    discardBtn.addEventListener('click', function () {
      if (!window.confirm('Throw away all changes on this page since it was last published?')) return;
      state.hasUnsaved = function () { return false; };
      renderPageEditor(page);
    });

    advancedLink.addEventListener('click', function () {
      if (!confirmLeave()) return;
      resetScreen();
      mainEl.appendChild(el('h1', {}, [page.title + ' — code']));
      buildCodeEditor(page, source);
    });

    publishBtn.addEventListener('click', function () {
      if (!window.confirm('Put these changes on the live website now?')) return;
      messageHost.innerHTML = '';
      publishBtn.disabled = true;
      discardBtn.disabled = true;
      publishBtn.textContent = 'Publishing…';

      var pending = Object.keys(photos);
      var uploaded = {};
      var chain = Promise.resolve();
      pending.forEach(function (imgId, i) {
        chain = chain.then(function () {
          publishBtn.textContent = 'Uploading photo ' + (i + 1) + ' of ' + pending.length + '…';
          var hint2 = photos[imgId].alt || page.title + ' photo';
          return uploadPhoto(photos[imgId].photo, hint2).then(function (path) {
            uploaded[imgId] = {
              path: path,
              alt: photos[imgId].alt,
              width: photos[imgId].photo.width,
              height: photos[imgId].photo.height,
            };
          });
        });
      });

      chain
        .then(function () {
          publishBtn.textContent = 'Publishing…';
          var html = CMS.applyEdits(master, previewDoc, dirty, uploaded, {
            title: seoTitleInput.value,
            description: seoDescInput.value,
          });
          return apiJson('/api/pages', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: page.file, content: html }),
          }).then(function () { return html; });
        })
        .then(function (html) {
          source = html;
          // Photos now point at their uploaded file; keep the on-screen
          // copy showing them.
          Object.keys(uploaded).forEach(function (id) {
            var img = previewDoc.querySelector('[data-cms-img="' + id + '"]');
            if (img) img.classList.remove('cms-edited');
          });
          Array.prototype.forEach.call(previewDoc.querySelectorAll('.cms-edited'), function (x) {
            x.classList.remove('cms-edited');
          });
          dirty.clear();
          photos = {};
          structureChanged = false;
          seoTitle0 = seoTitleInput.value.trim();
          seoDesc0 = seoDescInput.value.trim();
          updateButtons();
          showMessage(messageHost, 'Published! The live website will show your changes in about a minute.', 'success');
        })
        .catch(function (err) {
          showMessage(messageHost, 'Couldn’t publish: ' + err.message + ' Your changes are still here — try again.', 'error');
          updateButtons();
        });
    });
  }

  // ---------- advanced: raw code editor ----------

  function buildCodeEditor(page, originalContent) {
    var messageHost = el('div', {});
    var publishBtn = el('button', { class: 'btn btn-primary' }, ['Publish Code']);
    var backBtn = el('button', { class: 'btn btn-secondary' }, ['← Back to normal editing']);
    var refreshPreviewBtn = el('button', { class: 'btn btn-secondary' }, ['Refresh Preview']);
    var textarea = el('textarea', { spellcheck: 'false' });
    textarea.value = originalContent;
    var iframe = el('iframe', { title: 'Live preview' });

    state.hasUnsaved = function () { return textarea.value !== originalContent; };

    mainEl.appendChild(el('p', { class: 'sub' }, ['For technical users. If you’re not sure what this is, go back to normal editing.']));
    mainEl.appendChild(messageHost);
    mainEl.appendChild(el('div', { class: 'editor-toolbar' }, [
      el('div', { style: 'display:flex;gap:10px;' }, [backBtn, refreshPreviewBtn]),
      publishBtn,
    ]));
    mainEl.appendChild(el('div', { class: 'editor-split' }, [
      el('div', { class: 'editor-pane' }, [el('div', { class: 'editor-pane-label' }, ['HTML Source']), textarea]),
      el('div', { class: 'editor-pane' }, [el('div', { class: 'editor-pane-label' }, ['Preview']), iframe]),
    ]));

    function updatePreview() {
      var baseHref = window.location.origin + '/';
      iframe.srcdoc = textarea.value.replace(/<head(\s[^>]*)?>/i, function (m) {
        return m + '<base href="' + baseHref + '">';
      });
    }
    updatePreview();
    refreshPreviewBtn.addEventListener('click', updatePreview);

    backBtn.addEventListener('click', function () {
      if (!confirmLeave()) return;
      renderPageEditor(page);
    });

    publishBtn.addEventListener('click', function () {
      if (!window.confirm('Publish this code to ' + page.file + ' now?')) return;
      publishBtn.disabled = true;
      publishBtn.textContent = 'Publishing…';
      apiJson('/api/pages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: page.file, content: textarea.value }),
      })
        .then(function () {
          originalContent = textarea.value;
          showMessage(messageHost, 'Published. The live website will update in about a minute.', 'success');
        })
        .catch(function (err) { showMessage(messageHost, err.message, 'error'); })
        .finally(function () {
          publishBtn.disabled = false;
          publishBtn.textContent = 'Publish Code';
        });
    });
  }

  // ---------- new blog post ----------

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Makes sure the article is made of proper paragraphs (the browser can
  // leave loose lines or <div>s behind while typing).
  function tidyBody(container) {
    var doc = container.ownerDocument;
    var BLOCKS = /^(P|H2|H3|H4|UL|OL|BLOCKQUOTE|FIGURE|IMG)$/;
    var kids = Array.prototype.slice.call(container.childNodes);
    var para = null;
    kids.forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'DIV') {
        var p = doc.createElement('p');
        while (n.firstChild) p.appendChild(n.firstChild);
        container.replaceChild(p, n);
        para = null;
        return;
      }
      if (n.nodeType === 1 && BLOCKS.test(n.tagName)) { para = null; return; }
      if (n.nodeType === 3 && !n.nodeValue.trim()) { if (!para) return; }
      if (n.nodeType === 1 && n.tagName === 'BR') { para = null; container.removeChild(n); return; }
      if (!para) {
        para = doc.createElement('p');
        container.insertBefore(para, n);
      }
      para.appendChild(n);
    });
    Array.prototype.forEach.call(container.querySelectorAll('p'), function (p) {
      if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    });
  }

  function renderNewPostForm() {
    resetScreen();
    mainEl.appendChild(el('h1', {}, ['New Blog Post']));
    mainEl.appendChild(el('p', { class: 'sub' }, ['Fill this in and click Publish. The post gets its own page in the same style as the other articles, and is added to the Blog page automatically.']));

    var messageHost = el('div', {});
    mainEl.appendChild(messageHost);

    var heroPhoto = null;

    var titleInput = el('input', { type: 'text', placeholder: 'e.g. 5 Signs Your Site Needs a Debris Netting Upgrade' });
    var categoryInput = el('input', { type: 'text', placeholder: 'e.g. Job Site Safety', value: 'ATI Products' });
    var excerptInput = el('textarea', { rows: '2', placeholder: 'One or two sentences about the article. Shown on the Blog page and in Google.' });
    var heroAltInput = el('input', { type: 'text', placeholder: 'e.g. Debris netting installed on a high-rise job site' });
    var heroCaptionInput = el('input', { type: 'text', placeholder: 'Optional caption shown under the photo' });
    var slugInput = el('input', { type: 'text', placeholder: 'made from the title automatically' });
    var keywordsInput = el('input', { type: 'text', placeholder: 'optional, e.g. debris netting, construction safety' });

    var heroZone = createPhotoZone({ onPhoto: function (p) { heroPhoto = p; } });

    // Article body
    var rteToolbar = el('div', { class: 'rte-toolbar' });
    var rteBody = el('div', { class: 'rte-body', contenteditable: 'true', 'data-placeholder': 'Start writing the article here… You can paste text from Word or an email, and paste photos straight in too.' });
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* older browsers */ }

    [
      { label: 'B', cmd: 'bold', title: 'Bold' },
      { label: 'I', cmd: 'italic', title: 'Italic' },
      { label: 'Heading', cmd: 'formatBlock', arg: 'H2', title: 'Heading' },
      { label: 'Subheading', cmd: 'formatBlock', arg: 'H3', title: 'Subheading' },
      { label: 'Normal text', cmd: 'formatBlock', arg: 'P', title: 'Paragraph' },
      { label: '• Bullets', cmd: 'insertUnorderedList', title: 'Bullet list' },
      { label: '1. Numbers', cmd: 'insertOrderedList', title: 'Numbered list' },
      { label: 'Link', cmd: 'link', title: 'Insert link' },
      { label: 'Undo', cmd: 'undo', title: 'Undo' },
    ].forEach(function (c) {
      rteToolbar.appendChild(el('button', {
        type: 'button',
        title: c.title,
        onMousedown: function (e) { e.preventDefault(); }, // keep the text selection
        onClick: function () {
          rteBody.focus();
          if (c.cmd === 'link') {
            var url = window.prompt('Paste the web address for this link (select some words first):', 'https://');
            if (url && url !== 'https://') document.execCommand('createLink', false, url);
            return;
          }
          document.execCommand(c.cmd, false, c.arg || null);
        },
      }, [c.label]));
    });

    function insertBodyPhoto(file) {
      toast('Adding photo…');
      CMS.compressImage(file).then(function (p) {
        rteBody.focus();
        var html = '<img src="' + p.dataUrl + '" alt="" data-ext="' + p.ext + '" style="max-width:100%;height:auto;border-radius:12px;margin:12px 0;display:block;">';
        document.execCommand('insertHTML', false, html);
      }).catch(function (err) { toast(err.message); });
    }

    rteBody.addEventListener('paste', function (e) {
      var file = CMS.imageFromDataTransfer(e.clipboardData);
      var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      e.preventDefault();
      if (file && !text) { insertBodyPhoto(file); return; }
      if (!text) return;
      var paras = text.replace(/\r/g, '').split(/\n\s*\n|\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (paras.length <= 1) document.execCommand('insertText', false, paras[0] || text);
      else document.execCommand('insertHTML', false, paras.map(function (s) { return '<p>' + escapeHtml(s) + '</p>'; }).join(''));
    });
    rteBody.addEventListener('drop', function (e) {
      var file = CMS.imageFromDataTransfer(e.dataTransfer);
      if (!file) return;
      e.preventDefault();
      insertBodyPhoto(file);
    });

    // A photo pasted anywhere else on this screen becomes the main photo.
    state.onGlobalPaste = function (e) {
      if (rteBody.contains(e.target)) return;
      if (heroZone.handlePaste(e)) toast('Main photo added.');
    };

    state.hasUnsaved = function () {
      return !!(titleInput.value.trim() || rteBody.textContent.trim() || heroPhoto);
    };

    var moreOptions = el('details', { class: 'seo-panel' }, [
      el('summary', {}, ['More options (optional)']),
      el('div', { class: 'seo-body form-grid' }, [
        el('div', { class: 'field' }, [el('label', {}, ['Web address ending']), slugInput,
          el('div', { class: 'hint' }, ['The page will be at ' + window.location.host.replace(/^www\./, '') + '/this-ending'])]),
        el('div', { class: 'field' }, [el('label', {}, ['Search keywords']), keywordsInput]),
        el('div', { class: 'field field-full' }, [el('label', {}, ['Caption under the main photo']), heroCaptionInput]),
      ]),
    ]);

    mainEl.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field field-full' }, [el('label', {}, ['Title']), titleInput]),
        el('div', { class: 'field field-full' }, [el('label', {}, ['Short summary']), excerptInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Topic label']), categoryInput,
          el('div', { class: 'hint' }, ['Small label shown above the title, like “Job Site Safety”.'])]),
        el('div', { class: 'field' }, [el('label', {}, ['Describe the main photo']), heroAltInput,
          el('div', { class: 'hint' }, ['A few words about what’s in the photo (helps Google).'])]),
        el('div', { class: 'field field-full' }, [el('label', {}, ['Main photo']), heroZone.el]),
      ]),
      el('div', { class: 'field field-full', style: 'margin-top:8px;' }, [
        el('label', {}, ['Article']),
        rteToolbar,
        rteBody,
      ]),
      moreOptions,
    ]));

    var publishBtn = el('button', { class: 'btn btn-primary' }, ['Publish Post']);
    mainEl.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;gap:10px;margin-top:16px;' }, [publishBtn]));

    publishBtn.addEventListener('click', function () {
      messageHost.innerHTML = '';
      var title = titleInput.value.trim();
      if (!title) { showMessage(messageHost, 'Please type a title.', 'error'); titleInput.focus(); return; }
      if (rteBody.textContent.trim().length < 20) {
        showMessage(messageHost, 'Please write a bit more in the article before publishing.', 'error');
        return;
      }
      if (!window.confirm('Publish this blog post to the live website now?')) return;

      publishBtn.disabled = true;
      var slugHint = slugInput.value.trim() || title;

      // Work on a copy of the article so the screen stays as-is if anything fails.
      var bodyCopy = rteBody.cloneNode(true);
      tidyBody(bodyCopy);
      var bodyImgs = Array.prototype.filter.call(bodyCopy.querySelectorAll('img'), function (img) {
        return /^data:/.test(img.getAttribute('src') || '');
      });
      var total = bodyImgs.length + (heroPhoto ? 1 : 0);
      var done = 0;
      var heroPath = '';

      function progress() {
        publishBtn.textContent = total ? 'Uploading photo ' + Math.min(done + 1, total) + ' of ' + total + '…' : 'Publishing…';
      }
      progress();

      var chain = Promise.resolve();
      if (heroPhoto) {
        chain = chain.then(function () {
          return uploadPhoto(heroPhoto, slugHint).then(function (path) { heroPath = path; done++; progress(); });
        });
      }
      bodyImgs.forEach(function (img, i) {
        chain = chain.then(function () {
          var src = img.getAttribute('src');
          var ext = img.getAttribute('data-ext') || (src.indexOf('image/webp') > -1 ? 'webp' : 'jpg');
          return uploadPhoto({ dataUrl: src, ext: ext }, slugHint + '-' + (i + 1)).then(function (path) {
            img.setAttribute('src', path);
            img.removeAttribute('data-ext');
            if (!img.getAttribute('alt')) img.setAttribute('alt', title);
            done++;
            progress();
          });
        });
      });

      chain
        .then(function () {
          publishBtn.textContent = 'Publishing…';
          return apiJson('/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: title,
              slug: slugInput.value.trim(),
              category: categoryInput.value.trim(),
              metaDescription: excerptInput.value.trim(),
              metaKeywords: keywordsInput.value.trim(),
              excerpt: excerptInput.value.trim(),
              heroImageSrc: heroPath,
              heroImageAlt: heroAltInput.value.trim(),
              heroCaption: heroCaptionInput.value.trim(),
              bodyHtml: bodyCopy.innerHTML,
            }),
          });
        })
        .then(function (data) {
          state.hasUnsaved = function () { return false; };
          showMessage(messageHost, 'Published! Your post will be live at ' + data.url + ' in about a minute.', 'success');
          publishBtn.textContent = 'Published';
          return loadPagesList();
        })
        .catch(function (err) {
          showMessage(messageHost, 'Couldn’t publish: ' + err.message, 'error');
          publishBtn.disabled = false;
          publishBtn.textContent = 'Publish Post';
        });
    });
  }

  // ---------- your account: change password ----------

  function renderAccount(firstTime) {
    resetScreen();
    var me = state.me || {};
    mainEl.appendChild(el('h1', {}, [firstTime ? 'Welcome, ' + (me.name || '') + '!' : 'Change my password']));

    if (me.builtIn) {
      mainEl.appendChild(el('p', { class: 'sub' }, ['You’re logged in with the main admin account (username “' + me.username + '”).']));
      mainEl.appendChild(el('div', { class: 'card' }, [
        el('p', { style: 'margin:0 0 10px;' }, ['This account’s password is stored in Vercel, as the ADMIN_PASSWORD setting, so it can only be changed there (then redeploy).']),
        el('p', { style: 'margin:0;' }, ['Tip: add yourself on the ', el('b', {}, ['People & logins']), ' screen and use your own login day to day. Keep this main account as a spare key.']),
      ]));
      return;
    }

    mainEl.appendChild(el('p', { class: 'sub' }, [firstTime
      ? 'Before you start, please choose your own password. You’ll use it from now on instead of the temporary one you were given.'
      : 'Choose a new password. You’ll stay logged in here, and you’ll be logged out on any other computer.']));

    var messageHost = el('div', {});
    var current = el('input', { type: 'password', autocomplete: 'current-password' });
    var next = el('input', { type: 'password', autocomplete: 'new-password' });
    var again = el('input', { type: 'password', autocomplete: 'new-password' });
    var show = el('input', { type: 'checkbox', id: 'show-pw' });
    show.addEventListener('change', function () {
      [current, next, again].forEach(function (i) { i.type = show.checked ? 'text' : 'password'; });
    });
    var saveBtn = el('button', { class: 'btn btn-primary' }, ['Save New Password']);

    mainEl.appendChild(messageHost);
    mainEl.appendChild(el('div', { class: 'card', style: 'max-width:520px;' }, [
      el('div', { class: 'field' }, [el('label', {}, [firstTime ? 'Temporary password (the one you were given)' : 'Current password']), current]),
      el('div', { class: 'field' }, [el('label', {}, ['New password']), next,
        el('div', { class: 'hint' }, ['At least 10 characters. A short phrase is easy to remember, like “scaffold-blue-harbor”.'])]),
      el('div', { class: 'field' }, [el('label', {}, ['Type the new password again']), again]),
      el('label', { class: 'check-row' }, [show, ' Show passwords']),
      el('div', { style: 'margin-top:16px;display:flex;gap:10px;' }, [saveBtn]),
    ]));
    current.focus();

    saveBtn.addEventListener('click', function () {
      messageHost.innerHTML = '';
      if (next.value.length < 10) { showMessage(messageHost, 'Please choose a password with at least 10 characters.', 'error'); return; }
      if (next.value !== again.value) { showMessage(messageHost, 'The two new passwords don’t match.', 'error'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      apiJson('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
      })
        .then(function () {
          if (state.me) state.me.mustChangePassword = false;
          current.value = next.value = again.value = '';
          showMessage(messageHost, firstTime
            ? 'All set! Your new password is saved. Pick a page on the left to get started.'
            : 'Your new password is saved.', 'success');
        })
        .catch(function (err) { showMessage(messageHost, err.message, 'error'); })
        .finally(function () { saveBtn.disabled = false; saveBtn.textContent = 'Save New Password'; });
    });
  }

  // ---------- people & logins (admins only) ----------

  function loginMessage(name, username, password) {
    var address = window.location.origin + '/admin/login.html';
    return 'Hi ' + name.split(' ')[0] + ',\n\nHere’s your login for editing the ATI website:\n\n' +
      'Address:  ' + address + '\nUsername: ' + username + '\nTemporary password: ' + password +
      '\n\nYou’ll be asked to choose your own password the first time you log in.';
  }

  function showCredentials(title, name, username, password) {
    var msg = loginMessage(name, username, password);
    var box = el('textarea', { class: 'cred-box', readonly: 'readonly', rows: '8' });
    box.value = msg;
    var copyBtn = el('button', { class: 'btn btn-primary' }, ['Copy Login Details']);
    var doneBtn = el('button', { class: 'btn btn-secondary' }, ['Done']);
    var modal = el('div', { class: 'modal-backdrop' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-label': title }, [
        el('h2', {}, [title]),
        el('p', { class: 'sub' }, ['Send these to ' + name + ' privately (a text message or a password manager is better than email). ',
          el('b', {}, ['This temporary password is only shown once.'])]),
        el('div', { class: 'cred-grid' }, [
          el('span', {}, ['Username']), el('code', {}, [username]),
          el('span', {}, ['Temporary password']), el('code', { class: 'cred-pw' }, [password]),
        ]),
        box,
        el('div', { class: 'modal-actions' }, [doneBtn, copyBtn]),
      ]),
    ]);
    copyBtn.addEventListener('click', function () {
      var done = function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy Login Details'; }, 1600); };
      try {
        navigator.clipboard.writeText(msg).then(done, function () { box.select(); copyBtn.textContent = 'Press Ctrl+C'; });
      } catch (e) { box.select(); copyBtn.textContent = 'Press Ctrl+C'; }
    });
    doneBtn.addEventListener('click', function () {
      if (!window.confirm('Have you copied or written down the password? It won’t be shown again.')) return;
      modal.remove();
    });
    document.body.appendChild(modal);
  }

  function renderPeople() {
    resetScreen();
    mainEl.appendChild(el('h1', {}, ['People & logins']));
    mainEl.appendChild(el('p', { class: 'sub' }, ['Everyone here can log in to edit the website with their own username and password. Admins can also add and remove people.']));
    var messageHost = el('div', {});
    mainEl.appendChild(messageHost);
    var listCard = el('div', { class: 'card' }, ['Loading…']);
    mainEl.appendChild(listCard);

    // --- add someone ---
    var nameIn = el('input', { type: 'text', placeholder: 'e.g. Jane Smith' });
    var userIn = el('input', { type: 'text', placeholder: 'e.g. jsmith', autocapitalize: 'none', spellcheck: 'false' });
    var emailIn = el('input', { type: 'email', placeholder: 'optional' });
    var roleIn = el('select', {}, [
      el('option', { value: 'editor' }, ['Editor — can edit pages and write posts']),
      el('option', { value: 'admin' }, ['Admin — can also add and remove people']),
    ]);
    var userTouched = false;
    userIn.addEventListener('input', function () { userTouched = true; });
    nameIn.addEventListener('input', function () {
      if (userTouched) return;
      var parts = nameIn.value.trim().toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter(Boolean);
      userIn.value = parts.length > 1 ? parts[0][0] + parts[parts.length - 1] : (parts[0] || '');
    });
    var addBtn = el('button', { class: 'btn btn-primary' }, ['Add Person']);
    mainEl.appendChild(el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, ['Add someone']),
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [el('label', {}, ['Full name']), nameIn]),
        el('div', { class: 'field' }, [el('label', {}, ['Username']), userIn,
          el('div', { class: 'hint' }, ['What they’ll type to log in. Lowercase, no spaces.'])]),
        el('div', { class: 'field' }, [el('label', {}, ['Email']), emailIn,
          el('div', { class: 'hint' }, ['Optional. Shown next to their changes in GitHub.'])]),
        el('div', { class: 'field' }, [el('label', {}, ['What can they do?']), roleIn]),
      ]),
      el('div', { style: 'display:flex;justify-content:flex-end;' }, [addBtn]),
    ]));

    addBtn.addEventListener('click', function () {
      messageHost.innerHTML = '';
      if (!nameIn.value.trim()) { showMessage(messageHost, 'Please enter their full name.', 'error'); nameIn.focus(); return; }
      if (!userIn.value.trim()) { showMessage(messageHost, 'Please enter a username.', 'error'); userIn.focus(); return; }
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      apiJson('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', name: nameIn.value, username: userIn.value, email: emailIn.value, role: roleIn.value }),
      })
        .then(function (data) {
          showCredentials('Login created for ' + data.name, data.name, data.username, data.password);
          nameIn.value = userIn.value = emailIn.value = '';
          roleIn.value = 'editor';
          userTouched = false;
          loadList();
        })
        .catch(function (err) { showMessage(messageHost, err.message, 'error'); })
        .finally(function () { addBtn.disabled = false; addBtn.textContent = 'Add Person'; });
    });

    function act(payload, confirmText, onDone) {
      if (confirmText && !window.confirm(confirmText)) return;
      messageHost.innerHTML = '';
      apiJson('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (data) { if (onDone) onDone(data); loadList(); })
        .catch(function (err) { showMessage(messageHost, err.message, 'error'); loadList(); });
    }

    function loadList() {
      apiJson('/api/users')
        .then(function (data) {
          listCard.innerHTML = '';
          var table = el('table', { class: 'people' });
          table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', {}, ['Name']), el('th', {}, ['Username']), el('th', {}, ['Can']), el('th', {}, ['']),
          ])]));
          var tbody = el('tbody');
          data.people.forEach(function (p) {
            var isYou = p.username === data.you;
            var nameCell = el('td', {}, [
              el('b', {}, [p.name]),
              isYou ? el('span', { class: 'tag' }, ['you']) : null,
              p.mustChangePassword && !p.builtIn ? el('span', { class: 'tag tag-warn' }, ['hasn’t logged in yet']) : null,
              p.email ? el('div', { class: 'muted' }, [p.email]) : null,
            ]);
            var roleCell;
            if (p.builtIn) {
              roleCell = el('td', {}, [el('span', { class: 'muted' }, ['Admin (main account)'])]);
            } else {
              var sel = el('select', { 'aria-label': 'Role for ' + p.name }, [
                el('option', { value: 'editor' }, ['Editor']),
                el('option', { value: 'admin' }, ['Admin']),
              ]);
              sel.value = p.role;
              sel.addEventListener('change', function () {
                act({ action: 'role', username: p.username, role: sel.value },
                  sel.value === 'admin' ? 'Make ' + p.name + ' an admin? They’ll be able to add and remove people.' : 'Make ' + p.name + ' an editor? They won’t be able to manage people any more.',
                  function () { toast(p.name + ' is now ' + (sel.value === 'admin' ? 'an admin.' : 'an editor.')); });
              });
              roleCell = el('td', {}, [sel]);
            }
            var actions = el('td', { class: 'row-actions' });
            if (p.builtIn) {
              actions.appendChild(el('span', { class: 'muted' }, ['Password is set in Vercel']));
            } else {
              actions.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onClick: function () {
                act({ action: 'reset', username: p.username },
                  'Give ' + p.name + ' a new temporary password? Their current password will stop working and they’ll be logged out.',
                  function (d) { showCredentials('New password for ' + d.name, d.name, d.username, d.password); });
              } }, ['Reset password']));
              if (!isYou) {
                actions.appendChild(el('button', { class: 'btn btn-danger btn-sm', onClick: function () {
                  act({ action: 'remove', username: p.username },
                    'Remove ' + p.name + '? They won’t be able to log in any more. Their past changes stay on the website.',
                    function () { toast(p.name + ' was removed.'); });
                } }, ['Remove']));
              }
            }
            tbody.appendChild(el('tr', {}, [nameCell, el('td', {}, [el('code', {}, [p.username])]), roleCell, actions]));
          });
          table.appendChild(tbody);
          listCard.appendChild(el('div', { class: 'table-scroll' }, [table]));
        })
        .catch(function (err) {
          showMessage(listCard, err.message, 'error');
          if (err.data && err.data.locked && err.data.canReset) {
            var freshBtn = el('button', { class: 'btn btn-danger' }, ['Start a Fresh List']);
            freshBtn.addEventListener('click', function () {
              if (!window.confirm('Start a fresh, empty list of people? Everyone except the main admin will need to be added again.')) return;
              act({ action: 'start-fresh' }, null, function () { toast('Fresh list started. You can add people again now.'); });
            });
            listCard.appendChild(el('p', { class: 'muted', style: 'margin:4px 0 12px;' }, ['If the old SESSION_SECRET can\u2019t be put back, start a fresh list and add everyone again. Their old passwords won\u2019t work any more.']));
            listCard.appendChild(freshBtn);
          }
        });
    }
    loadList();
  }

  // ---------- boot ----------

  checkAuthOrRedirect().then(function (ok) {
    if (!ok) return;
    var me = state.me || {};
    document.getElementById('whoami').textContent = 'Signed in as ' + (me.name || me.username || '');
    if (me.role === 'admin') document.getElementById('people-nav').hidden = false;
    loadPagesList();
    if (me.mustChangePassword) {
      setActiveNav(document.querySelector('[data-view="account"]'));
      renderAccount(true);
    } else {
      renderWelcome();
    }
  });
})();
