// admin/editor-core.js
//
// The engine behind "click on the page and type" editing. Kept separate
// from admin.js (which is all buttons and screens) so this logic can be
// tested on its own.
//
// How it works, briefly:
//   1. The page's HTML is parsed into an inert, script-free document (the
//      "master copy"). Every piece of visible text and every photo gets a
//      numbered tag (data-cms-id / data-cms-img).
//   2. A copy of that is shown in the editor as the live page, with the
//      page's own scripts removed so nothing moves around while editing,
//      and the tagged text made directly typeable.
//   3. On Publish, only the pieces that were actually edited are copied
//      back into the master copy by their number, the numbers are
//      stripped, and the result is saved. Everything else on the page —
//      styles, scripts, SEO data, layout — is carried through untouched.
//
// Exposed as window.CMS.

(function () {
  'use strict';

  // Elements whose whole contents count as one editable block of text.
  var BLOCK_TAGS = {
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, FIGCAPTION: 1,
    BLOCKQUOTE: 1, TD: 1, TH: 1, DT: 1, DD: 1, SUMMARY: 1, LABEL: 1, CAPTION: 1,
  };

  // Never editable in page mode. Menus and footer are copied into every
  // page, so editing them on one page would make the site inconsistent.
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, TEMPLATE: 1, IFRAME: 1, BUTTON: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, NAV: 1, FOOTER: 1, HEAD: 1,
  };

  // Styles applied only inside the editor preview (never saved).
  var EDITOR_CSS = [
    '[data-cms-id]{cursor:text;outline:1px dashed rgba(0,112,58,0);outline-offset:3px;border-radius:3px;transition:outline-color .12s,background-color .12s}',
    '[data-cms-id]:hover{outline-color:rgba(0,112,58,.6)}',
    '[data-cms-id]:focus{outline:2px solid #00703a;outline-offset:3px;background-color:rgba(0,112,58,.07)}',
    '[data-cms-id].cms-edited{background-color:rgba(245,158,11,.14)}',
    'img[data-cms-img]{cursor:pointer;outline:4px solid transparent;outline-offset:-4px;transition:filter .12s,outline-color .12s}',
    'img[data-cms-img]:hover{filter:brightness(.82);outline-color:#00703a}',
    '.reveal{opacity:1!important;transform:none!important;transition:none!important}',
    // Homepage sideways-scrolling section: stack it, same as the site does on phones.
    '.hscroll-wrap{height:auto!important}',
    '.hscroll-sticky{position:static!important;height:auto!important;flex-direction:column!important;overflow:visible!important}',
    '.hscroll-track{width:100%!important;flex-direction:column!important;transform:none!important;height:auto!important}',
    '.hscroll-panel{width:100%!important;height:auto!important;padding:56px 0!important}',
    '.mobile-nav{display:none!important}',
  ].join('\n');

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    return false;
  }

  function isSkipped(el) {
    var tag = el.tagName.toUpperCase();
    if (SKIP_TAGS[tag]) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.id === 'mobile-nav-drawer') return true;
    if (el.classList && (el.classList.contains('sr-only') || el.classList.contains('mobile-nav'))) return true;
    return false;
  }

  // Tags every editable text block and photo in the document. Returns the
  // next unused id number, so the editor can keep numbering new bullets.
  function tagEditable(doc) {
    var nextId = 1;

    function tagImagesWithin(el) {
      var imgs = el.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imgs[i].setAttribute('data-cms-img', String(nextId++));
    }

    function walk(el) {
      if (isSkipped(el)) return;
      var tag = el.tagName.toUpperCase();
      if (tag === 'IMG') {
        el.setAttribute('data-cms-img', String(nextId++));
        return;
      }
      var text = (el.textContent || '').trim();
      if (text && (BLOCK_TAGS[tag] || hasDirectText(el))) {
        // Animated counters with extra markup inside: leave alone.
        if (el.hasAttribute('data-count-to') && el.children.length) return;
        el.setAttribute('data-cms-id', String(nextId++));
        tagImagesWithin(el);
        return;
      }
      var kids = Array.prototype.slice.call(el.children);
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    }

    if (doc.body) walk(doc.body);
    return nextId;
  }

  function parse(source) {
    return new DOMParser().parseFromString(source, 'text/html');
  }

  function serialize(doc) {
    // No trailing newline: the browser folds anything after </html> into
    // the page body, so adding one would grow the page by a blank line on
    // every save.
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  // Builds the HTML shown in the editor: the tagged master copy, minus the
  // page's own scripts (JSON-LD data blocks are harmless and kept), plus a
  // <base> so relative image paths load, plus the editor-only styles.
  function buildPreviewHtml(taggedDoc, baseHref) {
    var copy = taggedDoc.cloneNode(true);
    var scripts = copy.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var type = (scripts[i].getAttribute('type') || '').toLowerCase();
      if (type !== 'application/ld+json') scripts[i].parentNode.removeChild(scripts[i]);
    }
    // Inline onclick="" etc. would also be script; strip from the preview only.
    var all = copy.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var attrs = Array.prototype.slice.call(all[j].attributes);
      for (var k = 0; k < attrs.length; k++) {
        if (/^on/i.test(attrs[k].name)) all[j].removeAttribute(attrs[k].name);
      }
    }
    // Show counters at their final value, which is what visitors actually see.
    var counters = copy.querySelectorAll('[data-cms-id][data-count-to]');
    for (var c = 0; c < counters.length; c++) {
      counters[c].textContent = counters[c].getAttribute('data-count-to') + (counters[c].getAttribute('data-suffix') || '');
    }
    var head = copy.head || copy.querySelector('head');
    var base = copy.createElement('base');
    base.setAttribute('href', baseHref);
    head.insertBefore(base, head.firstChild);
    var style = copy.createElement('style');
    style.setAttribute('id', 'cms-editor-style');
    style.textContent = EDITOR_CSS;
    head.appendChild(style);
    return serialize(copy);
  }

  // Copy of an edited element's inner markup, minus editor-only attributes
  // (photo tags are kept so replaced photos can be matched up afterwards).
  function cleanInnerHtml(el) {
    var clone = el.cloneNode(true);
    var nodes = clone.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('contenteditable');
      nodes[i].removeAttribute('spellcheck');
      nodes[i].removeAttribute('data-cms-id');
    }
    // An element emptied completely can leave a stray <br> behind.
    if (!clone.textContent.trim() && !clone.querySelector('img,svg')) return '';
    return clone.innerHTML;
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // If a sentence that was edited on the page also appears word-for-word
  // in the page's search-engine data (e.g. an FAQ question), update it
  // there too so the two stay in sync.
  function syncJsonLd(doc, pairs) {
    if (!pairs.length) return 0;
    var changed = 0;
    var blocks = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var b = 0; b < blocks.length; b++) {
      var data;
      try { data = JSON.parse(blocks[b].textContent); } catch (e) { continue; }
      var hits = 0;
      var walk = function (node) {
        if (Array.isArray(node)) {
          for (var i = 0; i < node.length; i++) {
            if (typeof node[i] === 'string') {
              var r = replaceString(node[i]);
              if (r !== node[i]) { node[i] = r; hits++; }
            } else if (node[i] && typeof node[i] === 'object') walk(node[i]);
          }
        } else if (node && typeof node === 'object') {
          Object.keys(node).forEach(function (k) {
            if (typeof node[k] === 'string') {
              var r = replaceString(node[k]);
              if (r !== node[k]) { node[k] = r; hits++; }
            } else if (node[k] && typeof node[k] === 'object') walk(node[k]);
          });
        }
      };
      var replaceString = function (s) {
        var n = normalizeText(s);
        for (var p = 0; p < pairs.length; p++) {
          if (n === pairs[p][0]) return pairs[p][1];
        }
        return s;
      };
      walk(data);
      if (hits) {
        blocks[b].textContent = '\n' + JSON.stringify(data) + '\n';
        changed += hits;
      }
    }
    return changed;
  }

  function stripTags(doc) {
    var copy = doc.cloneNode(true);
    var tagged = copy.querySelectorAll('[data-cms-id],[data-cms-img]');
    for (var i = 0; i < tagged.length; i++) {
      tagged[i].removeAttribute('data-cms-id');
      tagged[i].removeAttribute('data-cms-img');
    }
    return copy;
  }

  // Applies everything edited in the preview back onto the master copy and
  // returns the final page HTML to save.
  //   master:    tagged inert document (kept tagged; a clean copy is saved)
  //   preview:   the live editor document
  //   dirtyIds:  ids of text blocks the user actually typed in
  //   photos:    { imgId: { path, alt, width, height } } for replaced photos
  //   seo:       { title, description } or null
  function applyEdits(master, preview, dirtyIds, photos, seo) {
    var pairs = [];

    dirtyIds.forEach(function (id) {
      var sel = '[data-cms-id="' + id + '"]';
      var src = preview.querySelector(sel);
      var dst = master.querySelector(sel);
      if (!src || !dst) return;

      if (dst.hasAttribute('data-count-to')) {
        var t = normalizeText(src.textContent);
        var m = t.match(/^(\d[\d,]*(?:\.\d+)?)(.*)$/);
        if (m) {
          dst.setAttribute('data-count-to', m[1].replace(/,/g, ''));
          if (m[2].trim()) dst.setAttribute('data-suffix', m[2].trim());
          else dst.removeAttribute('data-suffix');
        } else {
          dst.removeAttribute('data-count-to');
          dst.removeAttribute('data-suffix');
          dst.textContent = t;
        }
        return;
      }

      var before = normalizeText(dst.textContent);
      dst.innerHTML = cleanInnerHtml(src);
      if (dst.tagName.toUpperCase() === 'A' && src.getAttribute('href') !== null) {
        dst.setAttribute('href', src.getAttribute('href'));
      }
      var after = normalizeText(dst.textContent);
      if (before && after && before !== after) pairs.push([before, after]);
    });

    Object.keys(photos).forEach(function (imgId) {
      var img = master.querySelector('[data-cms-img="' + imgId + '"]');
      var p = photos[imgId];
      if (!img || !p || !p.path) return;
      img.setAttribute('src', p.path);
      img.removeAttribute('srcset');
      if (p.alt) img.setAttribute('alt', p.alt);
      if (p.width && p.height) {
        img.setAttribute('width', String(p.width));
        img.setAttribute('height', String(p.height));
      }
    });

    if (seo) {
      var titleEl = master.querySelector('title');
      var oldTitle = titleEl ? normalizeText(titleEl.textContent) : '';
      if (titleEl && seo.title && normalizeText(seo.title) !== oldTitle) {
        titleEl.textContent = seo.title.trim();
        ['meta[property="og:title"]', 'meta[name="twitter:title"]'].forEach(function (s) {
          var el = master.querySelector(s);
          if (el && normalizeText(el.getAttribute('content')) === oldTitle) el.setAttribute('content', seo.title.trim());
        });
      }
      var descEl = master.querySelector('meta[name="description"]');
      var oldDesc = descEl ? normalizeText(descEl.getAttribute('content')) : '';
      if (descEl && seo.description != null && normalizeText(seo.description) !== oldDesc && seo.description.trim()) {
        descEl.setAttribute('content', seo.description.trim());
        ['meta[property="og:description"]', 'meta[name="twitter:description"]'].forEach(function (s) {
          var el = master.querySelector(s);
          if (el && normalizeText(el.getAttribute('content')) === oldDesc) el.setAttribute('content', seo.description.trim());
        });
        if (oldDesc) pairs.push([oldDesc, seo.description.trim()]);
      }
    }

    syncJsonLd(master, pairs);
    return serialize(stripTags(master));
  }

  // Structural helpers used for bullet points. Applied identically to the
  // preview and the master copy so they stay matched up.
  function makeBlankListItem(li, newId, text) {
    var clone = li.cloneNode(true);
    clone.setAttribute('data-cms-id', String(newId));
    if (clone.classList) clone.classList.remove('cms-edited');
    var kids = Array.prototype.slice.call(clone.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      var keep = n.nodeType === 1 && (/^(svg|img)$/i.test(n.tagName) || (n.textContent || '').trim().length <= 2);
      if (!keep) clone.removeChild(n);
    }
    // Any images copied along come from the original bullet; untag them.
    var imgs = clone.querySelectorAll('[data-cms-img]');
    for (var j = 0; j < imgs.length; j++) imgs[j].removeAttribute('data-cms-img');
    clone.appendChild(clone.ownerDocument.createTextNode(text));
    return clone;
  }

  function insertListItemAfter(doc, id, newId, text) {
    var li = doc.querySelector('[data-cms-id="' + id + '"]');
    if (!li) return null;
    var item = makeBlankListItem(li, newId, text);
    li.parentNode.insertBefore(item, li.nextSibling);
    return item;
  }

  function removeById(doc, id) {
    var el = doc.querySelector('[data-cms-id="' + id + '"]');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ---------- text color ----------
  //
  // Colors the selected words inside one block of text (or the whole
  // block when nothing is selected). color = '#rrggbb', or null for
  // "normal" (back to the block's own color). Works on plain
  // contenteditable text, so it's the same code for the page editor and
  // the article editor. Keeps the markup tidy: one <span style="color:…">
  // per colored run, no nesting pile-ups, nothing else touched.

  var COLOR_SPAN_RE = /^\s*color\s*:\s*[^;]+;?\s*$/i;

  function isColorSpan(n) {
    return !!(n && n.nodeType === 1 && n.tagName === 'SPAN' && n.attributes.length === 1 &&
      n.hasAttribute('style') && COLOR_SPAN_RE.test(n.getAttribute('style')));
  }

  function textNodesIn(root) {
    var out = [];
    var walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */, null, false);
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function unwrap(el) {
    var parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function hasColoredAncestor(node, block) {
    for (var p = node.parentNode; p && p !== block; p = p.parentNode) {
      if (p.nodeType === 1 && p.style && p.style.color) return true;
    }
    return false;
  }

  function tidyColorSpans(block) {
    // Drop empty color spans, merge neighbours with the same color, then
    // unwrap a color span whose only child is another color span.
    var i, sp, spans = Array.prototype.slice.call(block.querySelectorAll('span'));
    for (i = 0; i < spans.length; i++) {
      sp = spans[i];
      if (isColorSpan(sp) && sp.parentNode && !sp.textContent.length) sp.parentNode.removeChild(sp);
    }
    spans = Array.prototype.slice.call(block.querySelectorAll('span'));
    for (i = 0; i < spans.length; i++) {
      sp = spans[i];
      if (!isColorSpan(sp) || !sp.parentNode) continue;
      var next = sp.nextSibling;
      while (next && isColorSpan(next) && next.style.color === sp.style.color) {
        while (next.firstChild) sp.appendChild(next.firstChild);
        var gone = next;
        next = next.nextSibling;
        gone.parentNode.removeChild(gone);
      }
    }
    // Innermost first, so chains of wrappers collapse fully.
    spans = Array.prototype.slice.call(block.querySelectorAll('span')).reverse();
    for (i = 0; i < spans.length; i++) {
      sp = spans[i];
      if (isColorSpan(sp) && sp.parentNode && sp.childNodes.length === 1 && isColorSpan(sp.firstChild)) unwrap(sp);
    }
    block.normalize();
  }

  function applyColor(block, range, color) {
    var doc = block.ownerDocument;
    var r = doc.createRange();
    if (!range || range.collapsed || !block.contains(range.commonAncestorContainer)) {
      r.selectNodeContents(block);
    } else {
      r.setStart(range.startContainer, range.startOffset);
      r.setEnd(range.endContainer, range.endOffset);
    }

    // Split the text at the selection edges so whole text nodes can be wrapped.
    var sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    if (ec.nodeType === 3 && eo > 0 && eo < ec.nodeValue.length) ec.splitText(eo);
    if (sc.nodeType === 3 && so > 0 && so < sc.nodeValue.length) {
      var tail = sc.splitText(so);
      if (ec === sc) { ec = tail; eo = eo - so; }
      sc = tail; so = 0;
    }
    if (sc.nodeType === 3 && so >= sc.nodeValue.length && sc.nodeValue.length) {
      // selection starts at the very end of a text node: begin with the next one
      so = sc.nodeValue.length;
    }

    var all = textNodesIn(block);
    var picked;
    if (sc.nodeType === 3 && ec.nodeType === 3) {
      var i0 = all.indexOf(sc), i1 = all.indexOf(ec);
      if (so >= sc.nodeValue.length) i0++;
      if (eo === 0) i1--;
      picked = i0 >= 0 && i1 >= i0 ? all.slice(i0, i1 + 1) : [];
    } else {
      var rr = doc.createRange();
      rr.setStart(sc, so);
      rr.setEnd(ec, eo);
      picked = all.filter(function (t) { return rr.intersectsNode(t); });
    }
    picked = picked.filter(function (t) { return t.nodeValue.length && !(t.parentNode && /^(SCRIPT|STYLE)$/.test(t.parentNode.tagName)); });
    if (!picked.length) return null;

    var win = doc.defaultView;
    var normalColor = null;
    picked.forEach(function (t) {
      var parent = t.parentNode;
      var soleChild = parent !== block && isColorSpan(parent) && parent.childNodes.length === 1;
      if (color) {
        if (soleChild) { parent.style.color = color; return; }
        var sp = doc.createElement('span');
        sp.setAttribute('style', 'color:' + color);
        parent.insertBefore(sp, t);
        sp.appendChild(t);
      } else {
        if (soleChild) {
          unwrap(parent);
          if (!hasColoredAncestor(t, block)) return;
        } else if (!hasColoredAncestor(t, block)) {
          return;
        }
        // Still inside something colored: pin it back to the block's own color.
        if (!normalColor) normalColor = win && win.getComputedStyle ? rgbToHex(win.getComputedStyle(block).color) : '';
        if (!normalColor) return;
        var sp2 = doc.createElement('span');
        sp2.setAttribute('style', 'color:' + normalColor);
        t.parentNode.insertBefore(sp2, t);
        sp2.appendChild(t);
      }
    });
    tidyColorSpans(block);

    // Hand back a range covering what was changed, so it can stay selected.
    var first = picked[0], last = picked[picked.length - 1];
    if (!first.parentNode || !last.parentNode || !block.contains(first) || !block.contains(last)) return null;
    var out = doc.createRange();
    out.setStart(first, 0);
    out.setEnd(last, last.nodeValue.length);
    return out;
  }

  function rgbToHex(rgb) {
    var m = String(rgb || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return /^#/.test(rgb) ? rgb : '';
    return '#' + [m[1], m[2], m[3]].map(function (x) { return ('0' + parseInt(x, 10).toString(16)).slice(-2); }).join('');
  }

  // ---------- photos ----------

  // Resizes and re-encodes any photo (pasted, dropped, or chosen) so it
  // uploads quickly and stays well under the server's size limit. Uses
  // WebP like the rest of the site, falling back to JPEG in browsers that
  // can't create WebP.
  function compressImage(blob, maxSide, quality) {
    maxSide = maxSide || 1920;
    quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        var dataUrl = canvas.toDataURL('image/webp', quality);
        var ext = 'webp';
        if (dataUrl.indexOf('data:image/webp') !== 0) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          dataUrl = canvas.toDataURL('image/jpeg', quality);
          ext = 'jpg';
        }
        URL.revokeObjectURL(url);
        if (dataUrl.length > 3800000 && maxSide > 1000) {
          compressImage(blob, 1280, 0.72).then(resolve, reject);
          return;
        }
        resolve({ dataUrl: dataUrl, ext: ext, width: cw, height: ch });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("That file couldn't be read as a photo. Try a JPG or PNG (iPhone HEIC photos may need to be exported as JPG first)."));
      };
      img.src = url;
    });
  }

  // Pulls a photo out of a paste or drop event, if there is one.
  function imageFromDataTransfer(dt) {
    if (!dt) return null;
    var i;
    if (dt.files && dt.files.length) {
      for (i = 0; i < dt.files.length; i++) {
        if (/^image\//.test(dt.files[i].type)) return dt.files[i];
      }
    }
    if (dt.items) {
      for (i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          var f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'photo';
  }

  window.CMS = {
    tagEditable: tagEditable,
    parse: parse,
    serialize: serialize,
    buildPreviewHtml: buildPreviewHtml,
    applyEdits: applyEdits,
    stripTags: stripTags,
    insertListItemAfter: insertListItemAfter,
    removeById: removeById,
    compressImage: compressImage,
    imageFromDataTransfer: imageFromDataTransfer,
    normalizeText: normalizeText,
    slugify: slugify,
    applyColor: applyColor,
    rgbToHex: rgbToHex,
  };
})();
