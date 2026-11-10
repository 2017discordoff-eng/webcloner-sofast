// crawl.js — Recursive full-site cloner: renders every page, downloads all assets,
//            rewrites URLs to relative paths, streams a ZIP back.
//
// Runtime: Node 22, Vercel (maxDuration 60s hobby / 300s pro)
// Deps: @sparticuz/chromium ^131, puppeteer-core ^23, archiver ^7
//
// Query params:
//   url      (required) — start URL, e.g. https://example.com
//   depth    (default 2) — 1=start page only, 2=+linked pages, 3=+their links, max 3
//   maxPages (default 30, max 60) — safety cap on total pages crawled
//   assets   (default 1) — set 0 to skip asset download (HTML only)
//   freeze   (default 1) — serialize rendered DOM + strip all scripts (required for SPAs:
//                          Next.js, Nuxt, React, Vue, etc. — prevents black screen offline)

process.env.AWS_EXECUTION_ENV     = process.env.AWS_EXECUTION_ENV     || 'AWS_Lambda_nodejs22.x';
process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs22.x';
process.env.LD_LIBRARY_PATH       = ['/tmp', '/tmp/al2023/lib', '/tmp/al2/lib', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const dns       = require('dns').promises;
const net       = require('net');
const path      = require('path');
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const archiver  = require('archiver');

// ── private-IP guard ──────────────────────────────────────────────────────────
const PRIV = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;
async function assertPublic(u) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  const a = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (a.some(x => PRIV.test(x.address))) throw new Error('hôte privé interdit');
}

// ── stealth script (same as render.js) ───────────────────────────────────────
const STEALTH = `
(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages',  { get: () => ['fr-FR','fr','en-US','en'], configurable: true });
  if (!window.chrome) window.chrome = { runtime: { id: undefined, connect: ()=>{}, sendMessage: ()=>{} } };
  const _pq = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = p => p && p.name === 'notifications'
    ? Promise.resolve(Object.assign(Object.create(PermissionStatus.prototype), { state: 'prompt', onchange: null }))
    : _pq(p);
  const _gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Google Inc. (Intel)';
    if (p === 37446) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return _gp.call(this, p);
  };
  ['cdc_adoQpoasnfa76pfcZLmcfl_Array','cdc_adoQpoasnfa76pfcZLmcfl_Promise','cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
   '_phantom','callPhantom','__nightmare'].forEach(k => { try { delete window[k]; } catch {} });
})();
`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_HEADERS = {
  'user-agent':                 UA,
  'accept-language':            'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua':                  '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile':           '?0',
  'sec-ch-ua-platform':         '"Windows"',
  'sec-fetch-dest':             'document',
  'sec-fetch-mode':             'navigate',
  'sec-fetch-site':             'none',
  'upgrade-insecure-requests':  '1',
};

// ── browser singleton ─────────────────────────────────────────────────────────
let _browser;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--hide-scrollbars', '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1440, height: 900 },
    executablePath: await chromium.executablePath(),
    env: { ...process.env },
    headless: 'shell',
    ignoreHTTPSErrors: true,
  });
  return _browser;
}

// ── URL → archive path mapping ────────────────────────────────────────────────
// Pages:  https://example.com/foo/bar  → pages/foo/bar/index.html
//         https://example.com/         → pages/index.html
// Assets: https://example.com/a/b.css → assets/example.com/a/b.css
//         https://cdn.other.com/x.js  → assets/cdn.other.com/x.js
function pageArchivePath(u, origin) {
  const url = new URL(u);
  let p = url.pathname.replace(/\/$/, '') || '/';
  // Append extension if the pathname already has one (e.g. /page.html → pages/page.html)
  if (path.extname(p) && path.extname(p) !== '.html') {
    // non-html resource linked as a page — treat as asset
    return `assets/${url.host}${p}${url.search ? '_' + url.search.slice(1).replace(/[^a-z0-9]/gi, '_') : ''}`;
  }
  if (p === '/') return 'pages/index.html';
  return `pages${p}/index.html`;
}

function assetArchivePath(u) {
  const url = new URL(u);
  let p = url.pathname;
  // Strip common CDN query params from filename but keep them for cache-busting key
  const ext = path.extname(p.split('?')[0]);
  const name = path.basename(p.split('?')[0]);
  const dir  = path.dirname(p);
  return `assets/${url.host}${dir}/${name}`;
}

// ── rewrite all URLs in HTML to relative paths ────────────────────────────────
// assetMap: Map<originalUrl, archivePath>
// pageMap:  Map<originalUrl, archivePath>
// currentArchivePath: the archive path of the HTML file being rewritten
function rewriteHtml(html, originHost, currentArchivePath, assetMap, pageMap) {
  const currentDir = path.dirname(currentArchivePath);

  function relative(targetArchivePath) {
    // Compute relative path from currentDir to target
    const rel = path.relative(currentDir, targetArchivePath).replace(/\\/g, '/');
    return rel.startsWith('.') ? rel : './' + rel;
  }

  // Replace all absolute URLs we know about
  const allMap = new Map([...assetMap, ...pageMap]);

  let out = html;

  // Replace URLs in HTML attributes: src, href, srcset, action, data-src, poster, etc.
  out = out.replace(/((?:src|href|action|poster|data-src|data-lazy|data-original|data-bg|content|srcset)\s*=\s*["'])([^"'>\s]+)(["'])/gi, (match, pre, url, post) => {
    // Skip data: and javascript: and # anchors
    if (/^(data:|javascript:|#|mailto:|tel:)/i.test(url)) return match;
    try {
      const abs = new URL(url, `https://${originHost}`).href;
      if (allMap.has(abs)) return pre + relative(allMap.get(abs)) + post;
    } catch {}
    return match;
  });

  // Replace URLs in srcset (comma-separated list of "url [descriptor]")
  out = out.replace(/(srcset\s*=\s*["'])([^"']+)(["'])/gi, (match, pre, srcset, post) => {
    const rewritten = srcset.split(',').map(entry => {
      const [rawUrl, ...rest] = entry.trim().split(/\s+/);
      try {
        const abs = new URL(rawUrl, `https://${originHost}`).href;
        if (assetMap.has(abs)) return [relative(assetMap.get(abs)), ...rest].join(' ');
      } catch {}
      return entry;
    });
    return pre + rewritten.join(', ') + post;
  });

  // Replace URLs in <style> blocks and inline style= attributes
  out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, q, url) => {
    if (/^(data:|#)/i.test(url)) return match;
    try {
      const abs = new URL(url, `https://${originHost}`).href;
      if (assetMap.has(abs)) return `url(${q}${relative(assetMap.get(abs))}${q})`;
    } catch {}
    return match;
  });

  return out;
}

// ── rewrite CSS url() references ─────────────────────────────────────────────
function rewriteCss(css, originHost, currentArchivePath, assetMap) {
  const currentDir = path.dirname(currentArchivePath);
  function relative(t) {
    const rel = path.relative(currentDir, t).replace(/\\/g, '/');
    return rel.startsWith('.') ? rel : './' + rel;
  }
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, q, url) => {
    if (/^(data:|#)/i.test(url)) return match;
    try {
      const abs = new URL(url, `https://${originHost}`).href;
      if (assetMap.has(abs)) return `url(${q}${relative(assetMap.get(abs))}${q})`;
    } catch {}
    return match;
  });
}

// ── dismiss cookie banners quickly ───────────────────────────────────────────
async function dismissBanners(page) {
  await page.evaluate(() => {
    const kw = ['tout accepter','accepter tout','j\'accepte','accepter','accept all','i accept','allow all'];
    const btns = [...document.querySelectorAll('button,[role="button"],a')];
    for (const k of kw) {
      const b = btns.find(x => x.textContent.trim().toLowerCase().startsWith(k));
      if (b) { b.click(); return; }
    }
  });
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('Escape').catch(() => {});
}

// ── render one page, return { html, links, assetUrls } ───────────────────────
// freeze=true: serialize final DOM and strip all scripts (offline SPA fix)
async function renderPage(url, originHost, freeze = true) {
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.evaluateOnNewDocument(STEALTH);
    await page.setExtraHTTPHeaders(NAV_HEADERS);

    const assetUrls = new Set();
    await page.setRequestInterception(true);
    page.on('request', r => {
      const x = r.url();
      if (/^https?:/.test(x)) assetUrls.add(x);
      r.continue({ headers: { ...r.headers(), 'user-agent': UA } }).catch(() => {});
    });

    const resp = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    if (resp && !/html/i.test(resp.headers()['content-type'] || '')) return null;
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 5000 }).catch(() => {});
    await dismissBanners(page);

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const h = document.documentElement.scrollHeight;
      for (let y = 0; y < h; y += 400) { scrollTo(0, y); await delay(100); }
      scrollTo(0, 0); await delay(300);
    });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});

    // Extract same-origin links
    const links = await page.evaluate(originHost => {
      return [...new Set(
        [...document.querySelectorAll('a[href]')]
          .map(a => { try { return new URL(a.href).href; } catch { return null; } })
          .filter(u => u && new URL(u).host === originHost && !/\.(pdf|zip|exe|dmg|pkg|gz|tar|mp4|mp3|avi|mkv)$/i.test(new URL(u).pathname))
      )];
    }, originHost);

    // Also pick up asset URLs from the DOM (not just network traffic)
    const domAssets = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img[src],img[data-src],source[src],link[href],script[src],video[src],video poster,audio[src]').forEach(el => {
        ['src','data-src','href','poster'].forEach(attr => { const v = el.getAttribute(attr); if (v && /^https?:/.test(v)) urls.add(v); });
      });
      return [...urls];
    });
    domAssets.forEach(u => assetUrls.add(u));

    // Fix lazy images and serialize DOM — with optional freeze (SPA offline fix)
    const html = await page.evaluate(freeze => {
      // Fix lazy-loaded images regardless of freeze mode
      document.querySelectorAll('img').forEach(img => {
        const src = img.currentSrc || img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.dataset.lazy;
        if (src) img.setAttribute('src', src);
        ['srcset','loading','data-src','data-lazy-src','data-original','data-lazy','data-bg'].forEach(a => img.removeAttribute(a));
      });
      document.querySelectorAll('picture source').forEach(s => s.remove());

      if (freeze) {
        // ── Capture canvas elements (WebGL, three.js, particles…) ──
        document.querySelectorAll('canvas').forEach(c => {
          try {
            let d = c.toDataURL('image/webp', 0.85);
            if (d.length > 1.4e6) d = c.toDataURL('image/webp', 0.5);
            if (d.length < 2000 || d.length > 1.8e6) return;
            const img = new Image();
            const cs = getComputedStyle(c);
            img.src = d; img.className = c.className; img.id = c.id;
            img.style.cssText = c.style.cssText;
            img.style.width = cs.width; img.style.height = cs.height;
            c.replaceWith(img);
          } catch {}
        });

        // ── Inline computed stylesheets (CSSOM → <style> text) ──
        // This is crucial: Next.js / CSS modules inject rules via CSSOM,
        // the linked .css file on disk may be empty or minimal.
        document.querySelectorAll('style').forEach(s => {
          try {
            if (s.sheet && s.sheet.cssRules && s.sheet.cssRules.length)
              s.textContent = [...s.sheet.cssRules].map(r => r.cssText).join('\n');
          } catch {}
        });
        // Adopted stylesheets (CSS Modules, Shadow DOM)
        (document.adoptedStyleSheets || []).forEach(sh => {
          const st = document.createElement('style');
          try { st.textContent = [...sh.cssRules].map(r => r.cssText).join('\n'); document.head.append(st); } catch {}
        });

        // ── THE KEY FIX: strip all scripts ──
        // Without this, the HTML shell tries to re-run React/Next/Vue from
        // /_next/static/... which doesn't exist offline → black screen.
        document.querySelectorAll(
          'script, noscript, ' +
          'link[rel="modulepreload"], ' +
          'link[rel="preload"][as="script"], ' +
          'link[rel="prefetch"][as="script"]'
        ).forEach(e => e.remove());

        // ── Remove Next.js/Nuxt hydration markers (unused without JS) ──
        document.querySelectorAll(
          '[data-reactroot], [data-reactid], ' +
          'template[id^="__next"], #__NEXT_DATA__'
        ).forEach(e => e.removeAttribute('data-reactroot'));

        // ── Add base tag so relative URLs resolve from origin ──
        // (belt+suspenders alongside our server-side URL rewriting)
        if (!document.querySelector('base')) {
          const base = document.createElement('base');
          base.href = location.href;
          document.head.prepend(base);
        }
      }

      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    }, freeze);

    return { html, links: links.map(l => { try { const u = new URL(l); u.hash = ''; u.search = ''; return u.href; } catch { return null; } }).filter(Boolean), assetUrls: [...assetUrls] };
  } finally {
    if (page) page.close().catch(() => {});
  }
}

// ── download one asset, return Buffer or null ─────────────────────────────────
async function fetchAsset(url) {
  const headers = {
    'user-agent':       UA,
    'accept':           '*/*',
    'accept-language':  'fr-FR,fr;q=0.9',
    'sec-fetch-dest':   'empty',
    'sec-fetch-mode':   'no-cors',
    'sec-fetch-site':   'cross-site',
    'cache-control':    'no-cache',
  };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'follow' });
    if (!r.ok) return null;
    const cl = +(r.headers.get('content-length') || 0);
    if (cl > 8e6) return null; // skip files > 8 MB
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8.5e6) return null;
    return { buf, ct: r.headers.get('content-type') || 'application/octet-stream' };
  } catch {
    return null;
  }
}

// ── ASSET TYPES worth downloading ─────────────────────────────────────────────
const ASSET_EXTS = /\.(css|js|mjs|json|woff|woff2|ttf|otf|eot|svg|png|jpg|jpeg|gif|webp|avif|ico|mp4|webm|ogg|mp3|wav|pdf|map)(\?|$)/i;
function isWorthDownloading(url) {
  try {
    const u = new URL(url);
    // Always fetch CSS and fonts (needed for rendering)
    if (/\.(css|woff2?|ttf|otf|eot)(\?|$)/i.test(u.pathname)) return true;
    return ASSET_EXTS.test(u.pathname);
  } catch { return false; }
}

// ── main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ error: 'accès refusé' });

    const startUrl  = req.query.url;
    const depth     = Math.min(3, Math.max(1, +(req.query.depth   || 2)));
    const maxPages  = Math.min(60, Math.max(1, +(req.query.maxPages || 30)));
    const getAssets = req.query.assets !== '0';
    // freeze=1 (default): serialize rendered DOM then strip all <script> tags.
    // Critical for SPAs (Next.js, Nuxt, React, Vue) — without it the downloaded HTML
    // is just a shell that tries to load /_next/... from file:// → black screen.
    const freeze    = req.query.freeze !== '0';

    if (!/^https?:\/\//i.test(startUrl || '')) return res.status(400).json({ error: 'lien invalide' });
    await assertPublic(startUrl);

    const origin     = new URL(startUrl);
    const originHost = origin.host;
    const originBase = origin.origin; // https://example.com

    // ── BFS crawl ─────────────────────────────────────────────────────────────
    // pageMap:   canonical URL → archive path
    // assetMap:  asset URL → archive path
    // pageData:  archive path → { html, rawAssetUrls }
    const pageMap   = new Map(); // url → archivePath
    const assetMap  = new Map(); // url → archivePath
    const pageData  = new Map(); // archivePath → { html, rawAssetUrls }

    const queue = [{ url: startUrl, d: 0 }];
    const seen  = new Set([startUrl]);

    while (queue.length && pageMap.size < maxPages) {
      const { url: pageUrl, d } = queue.shift();
      const ap = pageArchivePath(pageUrl, originBase);

      let result;
      try { result = await renderPage(pageUrl, originHost, freeze); } catch { continue; }
      if (!result) continue;

      pageMap.set(pageUrl, ap);
      pageData.set(ap, { html: result.html, rawAssetUrls: result.assetUrls });

      // Map asset URLs → archive paths
      result.assetUrls.forEach(u => {
        if (!assetMap.has(u) && isWorthDownloading(u)) {
          assetMap.set(u, assetArchivePath(u));
        }
      });

      // Enqueue same-origin links up to depth limit
      if (d < depth - 1) {
        result.links.forEach(l => {
          if (!seen.has(l) && new URL(l).host === originHost) {
            seen.add(l);
            queue.push({ url: l, d: d + 1 });
          }
        });
      }
    }

    // ── Download assets in parallel batches ───────────────────────────────────
    const assetBuffers = new Map(); // archivePath → { buf, ct }
    if (getAssets) {
      const assetEntries = [...assetMap.entries()];
      const BATCH = 10;
      for (let i = 0; i < assetEntries.length; i += BATCH) {
        const batch = assetEntries.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(([url, ap]) => fetchAsset(url).then(r => r ? [ap, r] : null))
        );
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            const [ap, data] = r.value;
            assetBuffers.set(ap, data);
          }
        });
      }
    }

    // ── Rewrite HTML URLs to relative ─────────────────────────────────────────
    const rewrittenPages = new Map(); // archivePath → rewrittenHtml
    pageData.forEach(({ html }, ap) => {
      rewrittenPages.set(ap, rewriteHtml(html, originHost, ap, assetMap, pageMap));
    });

    // ── Rewrite CSS urls() ────────────────────────────────────────────────────
    assetBuffers.forEach(({ buf, ct }, ap) => {
      if (/css/i.test(ct)) {
        const rewritten = rewriteCss(buf.toString('utf8'), originHost, ap, assetMap);
        assetBuffers.set(ap, { buf: Buffer.from(rewritten, 'utf8'), ct });
      }
    });

    // ── Build ZIP and stream it ───────────────────────────────────────────────
    const siteName = originHost.replace(/[^a-z0-9]/gi, '_');
    res.setHeader('content-type',        'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${siteName}.zip"`);
    res.setHeader('cache-control',       'no-store');
    res.setHeader('x-pages',             String(rewrittenPages.size));
    res.setHeader('x-assets',            String(assetBuffers.size));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { try { res.destroy(err); } catch {} });
    archive.pipe(res);

    // Add pages
    rewrittenPages.forEach((html, ap) => {
      archive.append(Buffer.from(html, 'utf8'), { name: ap });
    });

    // Add assets
    assetBuffers.forEach(({ buf }, ap) => {
      archive.append(buf, { name: ap });
    });

    // Add a simple index redirect at root
    const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=pages/index.html">
<title>${originHost}</title></head>
<body><a href="pages/index.html">Open site</a></body></html>`;
    archive.append(Buffer.from(indexHtml, 'utf8'), { name: 'index.html' });

    // Add crawl manifest
    const manifest = {
      origin: originBase,
      crawledAt: new Date().toISOString(),
      freeze,
      pages: [...pageMap.entries()].map(([url, ap]) => ({ url, path: ap })),
      assets: assetBuffers.size,
      assetsSkipped: assetMap.size - assetBuffers.size,
      note: freeze ? 'Scripts stripped — static snapshot, works offline for SPAs (Next.js, Nuxt, React, Vue)' : 'Scripts kept — may need a local server for SPA sites',
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    await archive.finalize();

  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
};
