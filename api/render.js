// render.js — Puppeteer full-page renderer with stealth bypass + human simulation
// Runtime: Node 22, Vercel serverless (maxDuration 60s)
// Deps: @sparticuz/chromium ^131, puppeteer-core ^23

process.env.AWS_EXECUTION_ENV       = process.env.AWS_EXECUTION_ENV       || 'AWS_Lambda_nodejs22.x';
process.env.AWS_LAMBDA_JS_RUNTIME   = process.env.AWS_LAMBDA_JS_RUNTIME   || 'nodejs22.x';
process.env.LD_LIBRARY_PATH         = ['/tmp', '/tmp/al2023/lib', '/tmp/al2/lib', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const dns      = require('dns').promises;
const net      = require('net');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// ── private-IP guard ──────────────────────────────────────────────────────────
const PRIV = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;
async function assertPublic(u) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (addrs.some(x => PRIV.test(x.address))) throw new Error('hôte privé interdit');
}

// ── stealth script injected before every page load ───────────────────────────
// Inline equivalent of puppeteer-extra-plugin-stealth (no extra dep needed)
const STEALTH_SCRIPT = `
(function() {
  // 1. Remove automation flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // 2. Realistic plugin array (Chrome 131 on Windows)
  const makeMT = (type, suf, desc) => ({ type, suffixes: suf, description: desc });
  const makePlugin = (name, file, mts) => {
    const p = Object.create(Plugin.prototype);
    Object.assign(p, { name, filename: file, description: '', length: mts.length });
    mts.forEach((mt, i) => { p[i] = Object.assign(Object.create(MimeType.prototype), mt, { enabledPlugin: p }); });
    return p;
  };
  const fakePlugins = [
    makePlugin('PDF Viewer', 'internal-pdf-viewer', [makeMT('application/pdf', 'pdf', 'Portable Document Format')]),
    makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', [makeMT('application/pdf', 'pdf', '')]),
    makePlugin('Chromium PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', [makeMT('application/pdf', 'pdf', '')]),
    makePlugin('Microsoft Edge PDF Viewer', 'msedge-pdf-viewer', [makeMT('application/pdf', 'pdf', '')]),
    makePlugin('WebKit built-in PDF', 'webkit-pdf-viewer', [makeMT('application/pdf', 'pdf', '')]),
  ];
  const pl = Object.create(PluginArray.prototype);
  fakePlugins.forEach((p, i) => { pl[i] = p; }); pl.length = fakePlugins.length;
  pl.item = i => pl[i]; pl.namedItem = n => fakePlugins.find(p => p.name === n) || null;
  Object.defineProperty(navigator, 'plugins', { get: () => pl, configurable: true });

  // 3. Languages matching a French Windows user
  Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'], configurable: true });

  // 4. window.chrome presence (required by many bot detectors)
  if (!window.chrome) {
    const c = { runtime: { id: undefined, connect: () => {}, sendMessage: () => {} } };
    Object.defineProperty(window, 'chrome', { get: () => c, configurable: true });
  }

  // 5. Permissions API — return 'prompt' instead of 'denied' for notifications
  const _permQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve(Object.assign(Object.create(PermissionStatus.prototype), { state: 'prompt', onchange: null }))
      : _permQuery(p);

  // 6. WebGL — spoof a real GPU (Intel Iris Xe, Windows)
  const _getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Google Inc. (Intel)';
    if (p === 37446) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return _getParam.call(this, p);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const _get2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return _get2.call(this, p);
    };
  }

  // 7. Hairline iframe detection fix
  const origDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  if (origDesc) {
    Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
      get() { const v = origDesc.get.call(this); return v === 0 ? 1 : v; },
      configurable: true,
    });
  }

  // 8. Remove CDP / automation artefacts sometimes left in global scope
  ['cdc_adoQpoasnfa76pfcZLmcfl_Array',
   'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
   'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
   '_phantom', 'callPhantom', '__nightmare', '__webdriver_evaluate',
   '__selenium_evaluate', '__webdriver_script_fn', '__fxdriver_evaluate',
   '__driver_unwrapped', '__webdriver_unwrapped', '__driver_evaluate',
   '__selenium_unwrapped', '__fxdriver_unwrapped',
  ].forEach(k => { try { delete window[k]; } catch {} });

  // 9. Consistent navigator.hardwareConcurrency / deviceMemory
  if (navigator.hardwareConcurrency < 4)
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  try { if (navigator.deviceMemory < 4)
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch {}
})();
`;

// ── realistic Chrome 131 headers ─────────────────────────────────────────────
const UA_CHROME131 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EXTRA_HEADERS = {
  'user-agent':                 UA_CHROME131,
  'accept-language':            'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua':                  '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile':           '?0',
  'sec-ch-ua-platform':         '"Windows"',
  'sec-fetch-dest':             'document',
  'sec-fetch-mode':             'navigate',
  'sec-fetch-site':             'none',
  'sec-fetch-user':             '?1',
  'upgrade-insecure-requests':  '1',
};

// ── browser singleton ─────────────────────────────────────────────────────────
let browser;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const args = [
    ...chromium.args,
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled',  // KEY: hides automation
    '--disable-features=IsolateOrigins,site-per-process',
    '--flag-switches-begin',
    '--disable-site-isolation-trials',
    '--flag-switches-end',
  ];
  browser = await puppeteer.launch({
    args,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    env: { ...process.env },
    headless: 'shell',
    ignoreHTTPSErrors: true,
  });
  return browser;
}

// ── human-like scroll ─────────────────────────────────────────────────────────
async function humanScroll(page) {
  await page.evaluate(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const jitter = (base, pct = 0.35) => Math.max(50, base * (1 + (Math.random() * 2 - 1) * pct));
    const h = document.documentElement.scrollHeight;
    let y = 0;
    while (y < h) {
      const step = Math.floor(jitter(280, 0.5));
      y = Math.min(y + step, h);
      window.scrollTo({ top: y, behavior: 'smooth' });
      await delay(jitter(140, 0.45));
      // Occasionally pause longer (like a human reading)
      if (Math.random() < 0.08) await delay(jitter(900, 0.4));
    }
    await delay(jitter(400, 0.3));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await delay(jitter(300, 0.3));
  });
}

// ── human-like mouse movements ────────────────────────────────────────────────
async function humanMouse(page) {
  const vp = page.viewport() || { width: 1440, height: 900 };
  const count = 3 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const x = 100 + Math.floor(Math.random() * (vp.width - 200));
    const y = 100 + Math.floor(Math.random() * (vp.height * 0.6));
    await page.mouse.move(x, y, { steps: 15 + Math.floor(Math.random() * 25) });
    await new Promise(r => setTimeout(r, 60 + Math.random() * 180));
  }
}

// ── GDPR / cookie banner dismissal ───────────────────────────────────────────
const COOKIE_ACCEPT_SELECTORS = [
  // OneTrust
  '#onetrust-accept-btn-handler',
  '#accept-recommended-btn-handler',
  'button#onetrust-accept-btn-handler',
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'a#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  // Axeptio
  '.axeptio_btn_acceptAll',
  'button.axeptio_btn_acceptAll',
  // Didomi
  '#didomi-notice-agree-button',
  'button#didomi-notice-agree-button',
  // TrustArc
  'a.call',
  '.truste_popframe .call',
  // Quantcast
  '.qc-cmp2-summary-buttons button:last-child',
  // Google consent
  'button[aria-label="Accept all"]',
  'button[aria-label="Tout accepter"]',
  'button[aria-label="Accepter tout"]',
  // Generic patterns
  'button[id*="accept"][id*="cookie" i]',
  'button[class*="accept"][class*="cookie" i]',
  'button[class*="cookie"][class*="accept" i]',
  'a[id*="accept"][id*="cookie" i]',
  '[data-testid*="accept-cookies"]',
  '[data-testid="cookie-accept"]',
  '[data-cy="cookie-accept"]',
  // French text buttons
  'button:has-text("Tout accepter")',
  'button:has-text("J\'accepte")',
  'button:has-text("Accepter")',
  // English text buttons
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I Accept")',
  'button:has-text("Accept Cookies")',
  // Catch-all — last resort
  '[class*="cookie"] button[class*="accept" i]',
  '[class*="gdpr"] button[class*="accept" i]',
  '[class*="consent"] button[class*="accept" i]',
];

async function dismissBanners(page) {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    try {
      // :has-text() is CSS4 / Playwright syntax — puppeteer doesn't support it natively
      if (sel.includes(':has-text(')) continue;
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await new Promise(r => setTimeout(r, 350));
        return; // one successful click is enough
      }
    } catch {}
  }
  // Fallback: evaluate JS to find buttons by text content
  await page.evaluate(() => {
    const keywords = ['tout accepter', 'accepter tout', 'j\'accepte', 'accepter', 'accept all', 'i accept', 'accept cookies', 'allow all', 'allow cookies'];
    const btns = [...document.querySelectorAll('button, a[role="button"], [role="button"]')];
    for (const kw of keywords) {
      const btn = btns.find(b => b.textContent.trim().toLowerCase().startsWith(kw));
      if (btn) { btn.click(); return; }
    }
  });
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('Escape').catch(() => {});
}

// ── paywall / overlay removal ─────────────────────────────────────────────────
async function removeOverlays(page) {
  await page.evaluate(() => {
    // Remove blur/overflow:hidden on body (classic paywall trick)
    ['blur', '-webkit-filter'].forEach(prop => {
      if (getComputedStyle(document.body)[prop] && getComputedStyle(document.body)[prop] !== 'none') {
        document.body.style[prop] = 'none';
      }
    });
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';

    // Remove full-screen overlays with high z-index that have no content
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      if (
        +cs.zIndex > 999 &&
        (cs.position === 'fixed' || cs.position === 'absolute') &&
        cs.display !== 'none' &&
        el.tagName !== 'VIDEO' && el.tagName !== 'HEADER' && el.tagName !== 'NAV'
      ) {
        // Only remove if it looks like a modal/overlay (covers large area)
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.6 && rect.height > window.innerHeight * 0.5) {
          const hasText = el.textContent.trim().length;
          // Don't remove cookie banners we already handled, menus, etc.
          if (!hasText || el.children.length < 3) el.remove();
        }
      }
    });
  });
}

// ── main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  let page;
  try {
    // SSRF guard on same-origin
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ error: 'accès refusé' });

    const u      = req.query.url;
    const freeze = req.query.freeze === '1';

    if (!/^https?:\/\//i.test(u || '')) return res.status(400).json({ error: 'lien invalide' });
    await assertPublic(u);

    const br = await getBrowser();
    page = await br.newPage();

    // Inject stealth script before any page script runs
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);

    // Set realistic headers
    await page.setExtraHTTPHeaders(EXTRA_HEADERS);

    // Preserve WebGL draw buffer for canvas capture
    await page.evaluateOnNewDocument(() => {
      const g = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(t, a) {
        if (/webgl/.test(t)) a = Object.assign({}, a, { preserveDrawingBuffer: true });
        return g.call(this, t, a);
      };
    });

    // Track loaded resources
    const seen = new Map(), hosts = new Map();
    await page.setRequestInterception(true);
    page.on('request', async r => {
      const x = r.url();
      if (!/^https?:/.test(x)) return r.continue();
      try {
        const h = new URL(x).host;
        if (!hosts.has(h)) hosts.set(h, assertPublic(x).then(() => true, () => false));
        if (!(await hosts.get(h))) return r.abort();
      } catch { return r.abort(); }
      seen.set(x, r.resourceType());
      // Override user-agent on sub-requests too
      r.continue({ headers: { ...r.headers(), 'user-agent': UA_CHROME131 } });
    });

    // Initial mouse movement (pre-load — tricks some detectors that check for pre-load mouse)
    await page.mouse.move(
      300 + Math.floor(Math.random() * 500),
      200 + Math.floor(Math.random() * 200),
      { steps: 10 }
    );

    const resp = await page.goto(u, { waitUntil: 'load', timeout: 25000 });
    if (resp && !/html/i.test(resp.headers()['content-type'] || '')) {
      return res.status(415).json({ error: 'pas une page HTML' });
    }

    // Let JS settle
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 7000 }).catch(() => {});

    // Dismiss cookie banners / GDPR popups
    await dismissBanners(page);
    await new Promise(r => setTimeout(r, 400));

    // Human-like mouse then scroll
    await humanMouse(page);
    await humanScroll(page);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});

    // Remove paywalls / overflow locks
    await removeOverlays(page);
    await new Promise(r => setTimeout(r, 300));

    const html = await page.evaluate(freeze => {
      // Fix lazy-loaded images
      document.querySelectorAll('img').forEach(img => {
        const src = img.currentSrc || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
        if (src) img.setAttribute('src', src);
        ['srcset', 'loading', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy'].forEach(a => img.removeAttribute(a));
      });
      document.querySelectorAll('picture source').forEach(s => s.remove());

      if (freeze) {
        // Capture canvas elements (WebGL, three.js, particles…)
        document.querySelectorAll('canvas').forEach(c => {
          try {
            let d = c.toDataURL('image/webp', 0.85);
            if (d.length > 1.4e6) d = c.toDataURL('image/webp', 0.5);
            if (d.length < 2000 || d.length > 1.8e6) return;
            const i = new Image();
            const cs = getComputedStyle(c);
            i.src = d; i.className = c.className; i.id = c.id;
            i.style.cssText = c.style.cssText;
            i.style.width = cs.width; i.style.height = cs.height;
            c.replaceWith(i);
          } catch {}
        });
        // Inline computed styles into <style> blocks
        document.querySelectorAll('style').forEach(s => {
          try {
            if (s.sheet && s.sheet.cssRules && s.sheet.cssRules.length)
              s.textContent = [...s.sheet.cssRules].map(r => r.cssText).join('\n');
          } catch {}
        });
        // Inline adopted stylesheets
        (document.adoptedStyleSheets || []).forEach(sh => {
          const st = document.createElement('style');
          try { st.textContent = [...sh.cssRules].map(r => r.cssText).join('\n'); document.head.append(st); } catch {}
        });
        // Strip scripts
        document.querySelectorAll('script, noscript, link[rel=modulepreload], link[rel=preload][as=script]')
          .forEach(e => e.remove());
      }

      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    }, freeze);

    if (html.length > 4.2e6) return res.status(413).json({ error: 'page trop lourde (> 4 Mo)' });

    res.setHeader('cache-control', 'no-store');
    res.json({
      url:  page.url(),
      html,
      res:  [...seen].map(([u, t]) => ({ u, t })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally {
    if (page) page.close().catch(() => {});
  }
};
