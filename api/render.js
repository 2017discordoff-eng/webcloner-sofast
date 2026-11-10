// Ouvre la page dans un vrai Chrome, laisse le JavaScript s'exécuter, puis renvoie le DOM final
// + la liste de tous les fichiers réellement chargés (polices, images, chunks…).
// Sur Vercel, @sparticuz/chromium ne reconnaît pas toujours l'environnement et n'extrait pas ses bibliothèques (libnss3…)
process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs22.x';
process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs22.x';
process.env.LD_LIBRARY_PATH = ['/tmp', '/tmp/al2023/lib', '/tmp/al2/lib', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const dns = require('dns').promises, net = require('net');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const PRIV = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;
async function pub(u) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  const a = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (a.some(x => PRIV.test(x.address))) throw new Error('hôte privé interdit');
}
let browser;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
    defaultViewport: { width: 1440, height: 900 },
    executablePath: await chromium.executablePath(),
    env: { ...process.env },
    headless: 'shell',
  });
  return browser;
}
module.exports = async (req, res) => {
  let page;
  try {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ error: 'accès refusé' });
    const u = req.query.url, freeze = req.query.freeze === '1';
    if (!/^https?:\/\//i.test(u || '')) return res.status(400).json({ error: 'lien invalide' });
    await pub(u);
    page = await (await getBrowser()).newPage();
    // force le WebGL à conserver son image pour pouvoir la photographier
    await page.evaluateOnNewDocument(() => {
      const g = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, a) { if (/webgl/.test(t)) a = Object.assign({}, a, { preserveDrawingBuffer: true }); return g.call(this, t, a); };
    });
    const seen = new Map(), hosts = new Map();
    await page.setRequestInterception(true);
    page.on('request', async r => {
      const x = r.url();
      if (!/^https?:/.test(x)) return r.continue();
      try {
        const h = new URL(x).host;
        if (!hosts.has(h)) hosts.set(h, pub(x).then(() => true, () => false));
        if (!(await hosts.get(h))) return r.abort();
      } catch { return r.abort(); }
      seen.set(x, r.resourceType());
      r.continue();
    });
    const resp = await page.goto(u, { waitUntil: 'load', timeout: 20000 });
    if (resp && !/html/.test(resp.headers()['content-type'] || '')) return res.status(415).json({ error: 'pas une page HTML' });
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 6000 }).catch(() => {});
    await page.evaluate(async () => { // fait défiler : déclenche les animations « à l'apparition » et le chargement différé
      for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 80; y += 500, i++) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
      await new Promise(r => setTimeout(r, 700)); scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
    });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    // referme une fenêtre modale ouverte (clé API, cookies…) pour copier la page qui est derrière
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[role=dialog] button,[aria-modal=true] button,[role=dialog] [role=button]')]
        .find(x => /cancel|close|annuler|fermer|^\s*[×✕x]\s*$/i.test((x.getAttribute('aria-label') || '') + ' ' + x.textContent));
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 700));
    const html = await page.evaluate(freeze => {
      document.querySelectorAll('img').forEach(i => { if (i.currentSrc) i.setAttribute('src', i.currentSrc); ['srcset', 'loading', 'data-src'].forEach(a => i.removeAttribute(a)); });
      document.querySelectorAll('picture source').forEach(s => s.remove());
      if (freeze) {
        document.querySelectorAll('canvas').forEach(c => { // photographie les canvas (WebGL, particules…)
          try {
            let d = c.toDataURL('image/webp', .85); if (d.length > 1.2e6) d = c.toDataURL('image/webp', .55);
            if (d.length < 2000 || d.length > 1.6e6) return;
            const i = new Image(), cs = getComputedStyle(c);
            i.src = d; i.className = c.className; i.id = c.id; i.style.cssText = c.style.cssText; i.style.width = cs.width; i.style.height = cs.height;
            c.replaceWith(i);
          } catch {}
        });
        document.querySelectorAll('style').forEach(s => { try { if (s.sheet && s.sheet.cssRules.length) s.textContent = [...s.sheet.cssRules].map(r => r.cssText).join('\n'); } catch {} });
        (document.adoptedStyleSheets || []).forEach(sh => { const st = document.createElement('style'); st.textContent = [...sh.cssRules].map(r => r.cssText).join('\n'); document.head.append(st); });
        document.querySelectorAll('script,noscript,link[rel=modulepreload],link[rel=preload][as=script]').forEach(e => e.remove());
      }
      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    }, freeze);
    if (html.length > 4e6) return res.status(413).json({ error: 'page trop lourde (> 4 Mo)' });
    res.setHeader('cache-control', 'no-store');
    res.json({ url: page.url(), html, res: [...seen].map(([u, t]) => ({ u, t })) });
  } catch (e) { res.status(502).json({ error: e.message }); }
  finally { if (page) page.close().catch(() => {}); }
};
