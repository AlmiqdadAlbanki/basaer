/**
 * تشجير بصائر — رسم SVG عربي RTL وتحويله إلى PNG داخل المتصفح.
 *
 * ⚠️ الفخ الأساسي: عند تحويل SVG إلى canvas، يتجاهل المتصفح الخطوط الخارجية
 * تمامًا ويسقط على خط بديل يُفسد تشكيل العربية. لذلك يجب تضمين ملف الخط
 * نفسه بصيغة base64 داخل عنصر <style> في الـ SVG قبل التحويل.
 */
(function (global) {
  'use strict';

  var FONT_URL = '/assets/fonts/IBMPlexSansArabic-Regular.woff2';
  var fontB64Cache = null;

  var THEME = {
    primary: '#B5262C',
    primaryLight: '#B5262C',
    accent: '#8D1D22',
    text: '#1A1A1A',
    surface: '#F4F8F7',
    border: '#D9E2E0',
    line: '#C9A3A5',
  };

  var NODE_W = 190;
  var NODE_MIN_H = 46;
  var H_GAP = 70;   // المسافة الأفقية بين المستويات
  var V_GAP = 18;   // المسافة الرأسية بين الأشقاء
  var PAD = 40;
  var CHAR_PER_LINE = 22;

  // ── قياس وتخطيط ────────────────────────────────────────────────

  function wrap(text, perLine) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    words.forEach(function (w) {
      if ((cur + ' ' + w).trim().length > perLine && cur) { lines.push(cur); cur = w; }
      else cur = (cur ? cur + ' ' : '') + w;
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function measure(node, depth) {
    node._lines = wrap(node.label, CHAR_PER_LINE);
    node._h = Math.max(NODE_MIN_H, 18 + node._lines.length * 20);
    node._depth = depth;
    var kids = node.children || [];
    if (!kids.length || node._collapsed) {
      node._subtree = node._h;
      return node._h;
    }
    var total = 0;
    kids.forEach(function (k, i) {
      total += measure(k, depth + 1) + (i ? V_GAP : 0);
    });
    node._subtree = Math.max(node._h, total);
    return node._subtree;
  }

  /** التخطيط أفقي من اليمين لليسار: الجذر يمينًا والفروع تمتد يسارًا. */
  function place(node, x, yTop) {
    node._x = x;
    node._y = yTop + node._subtree / 2 - node._h / 2;
    var kids = (node._collapsed ? [] : node.children) || [];
    var cy = yTop + (node._subtree - kids.reduce(function (s, k, i) {
      return s + k._subtree + (i ? V_GAP : 0);
    }, 0)) / 2;
    kids.forEach(function (k) {
      place(k, x - NODE_W - H_GAP, cy);
      cy += k._subtree + V_GAP;
    });
  }

  function flatten(node, acc) {
    acc.push(node);
    ((node._collapsed ? [] : node.children) || []).forEach(function (k) { flatten(k, acc); });
    return acc;
  }

  // ── بناء الـ SVG ───────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function levelColor(d) {
    if (d === 0) return { fill: THEME.primary, text: '#FFFFFF', stroke: THEME.primary };
    if (d === 1) return { fill: THEME.primaryLight, text: '#FFFFFF', stroke: THEME.primaryLight };
    if (d === 2) return { fill: THEME.surface, text: THEME.text, stroke: THEME.primaryLight };
    return { fill: '#FFFFFF', text: THEME.text, stroke: THEME.border };
  }

  /**
   * @param {object} tree  { title, nodes: [...] }
   * @param {object} opts  { fontCss: string }  CSS لتضمين الخط (اختياري)
   * @returns {{svg:string, width:number, height:number}}
   */
  function buildSvg(tree, opts) {
    opts = opts || {};
    var roots = (tree && tree.nodes) || [];
    if (!roots.length) return { svg: '', width: 0, height: 0 };

    // جذر افتراضي إن تعددت العقد العليا
    var root = roots.length === 1 ? roots[0]
      : { id: 'root', label: tree.title || 'الموضوع الرئيسي', children: roots };

    var total = measure(root, 0);
    var maxDepth = 0;
    flatten(root, []).forEach(function (n) { maxDepth = Math.max(maxDepth, n._depth); });

    var width = PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * H_GAP;
    var height = PAD * 2 + total + 46; // مساحة إضافية للعنوان
    var rootX = width - PAD - NODE_W;

    place(root, rootX, PAD + 46);

    var nodes = flatten(root, []);
    var parts = [];

    // الوصلات — منحنيات بيزييه
    nodes.forEach(function (n) {
      ((n._collapsed ? [] : n.children) || []).forEach(function (k) {
        var x1 = n._x, y1 = n._y + n._h / 2;
        var x2 = k._x + NODE_W, y2 = k._y + k._h / 2;
        var mx = (x1 + x2) / 2;
        parts.push('<path d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ', ' +
          mx + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" fill="none" stroke="' +
          THEME.line + '" stroke-width="1.6"/>');
      });
    });

    // العقد
    nodes.forEach(function (n) {
      var c = levelColor(n._depth);
      parts.push('<g><rect x="' + n._x + '" y="' + n._y + '" width="' + NODE_W +
        '" height="' + n._h + '" rx="9" fill="' + c.fill + '" stroke="' + c.stroke +
        '" stroke-width="1.4"/>');
      if (n._depth === 0) {
        parts.push('<rect x="' + n._x + '" y="' + n._y + '" width="4" height="' +
          n._h + '" rx="2" fill="' + THEME.accent + '"/>');
      }
      var startY = n._y + n._h / 2 - ((n._lines.length - 1) * 20) / 2 + 6;
      n._lines.forEach(function (line, i) {
        parts.push('<text x="' + (n._x + NODE_W / 2) + '" y="' + (startY + i * 20) +
          '" text-anchor="middle" direction="rtl" fill="' + c.text +
          '" font-size="' + (n._depth === 0 ? 15 : 13.5) +
          '" font-weight="' + (n._depth <= 1 ? 700 : 400) + '">' + esc(line) + '</text>');
      });
      parts.push('</g>');
    });

    var fontCss = opts.fontCss || '';
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '" direction="rtl">' +
      '<style>' + fontCss +
      'text{font-family:"BasaerTree","IBM Plex Sans Arabic","Segoe UI",sans-serif;}' +
      '</style>' +
      '<rect width="100%" height="100%" fill="#FFFFFF"/>' +
      '<text x="' + (width - PAD) + '" y="' + (PAD + 6) + '" text-anchor="end" ' +
      'direction="rtl" fill="' + THEME.primary + '" font-size="19" font-weight="700">' +
      esc(tree.title || 'تشجير أفكار الملخص') + '</text>' +
      '<line x1="' + PAD + '" y1="' + (PAD + 18) + '" x2="' + (width - PAD) + '" y2="' +
      (PAD + 18) + '" stroke="' + THEME.accent + '" stroke-width="2"/>' +
      parts.join('') + '</svg>';

    return { svg: svg, width: width, height: height };
  }

  // ── تضمين الخط ─────────────────────────────────────────────────

  async function fontCss() {
    if (fontB64Cache === null) {
      try {
        var res = await fetch(FONT_URL);
        var buf = await res.arrayBuffer();
        var bin = '';
        var bytes = new Uint8Array(buf);
        for (var i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        fontB64Cache = btoa(bin);
      } catch (e) {
        console.warn('تعذّر تحميل الخط للتضمين؛ سيُستخدم خط النظام.', e);
        fontB64Cache = '';
      }
    }
    if (!fontB64Cache) return '';
    return '@font-face{font-family:"BasaerTree";src:url(data:font/woff2;base64,' +
      fontB64Cache + ') format("woff2");font-weight:400 700;}';
  }

  // ── واجهة عامة ─────────────────────────────────────────────────

  /** يرسم التشجير داخل عنصر الحاوية ويرجع كائن التحكم. */
  async function render(container, tree) {
    var css = await fontCss();
    var built = buildSvg(tree, { fontCss: css });
    container.innerHTML = built.svg;
    var svgEl = container.querySelector('svg');
    if (svgEl) {
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = 'auto';
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    return built;
  }

  /**
   * يحوّل التشجير إلى PNG عالي الدقة.
   * @param {object} tree
   * @param {number} scale معامل التكبير (2 = دقة مضاعفة)
   * @returns {Promise<Blob>}
   */
  async function toPng(tree, scale) {
    scale = scale || 2;
    var css = await fontCss();
    var built = buildSvg(tree, { fontCss: css });

    var blob = new Blob([built.svg], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);

    try {
      var img = await new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = function () { reject(new Error('فشل تحويل التشجير إلى صورة')); };
        im.src = url;
      });

      var canvas = document.createElement('canvas');
      canvas.width = Math.round(built.width * scale);
      canvas.height = Math.round(built.height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      return await new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/png');
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toSvgBlob(tree) {
    return fontCss().then(function (css) {
      return new Blob([buildSvg(tree, { fontCss: css }).svg],
        { type: 'image/svg+xml;charset=utf-8' });
    });
  }

  global.BasaerTree = {
    render: render,
    toPng: toPng,
    toSvgBlob: toSvgBlob,
    buildSvg: buildSvg,
    setTheme: function (t) { Object.assign(THEME, t); },
    setFontUrl: function (u) { FONT_URL = u; fontB64Cache = null; },
  };
})(window);
