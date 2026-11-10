// fetch.js — Single-file proxy with real Chrome 131 headers + Wayback Machine support
// SSRF-guarded, redirects followed, 4 MB cap, range-request support

const dns = require('dns').promises;
const net = require('net');

const PRIV = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;

async function assertPublic(u) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (addrs.some(x => PRIV.test(x.address))) throw new Error('hôte privé interdit');
}

// Realistic Chrome 131 request headers — matches render.js UA exactly so sub-resource
// requests look identical to the browser that loaded the page.
function browserHeaders(resourceType) {
  const base = {
    'user-agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language':  'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua':        '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'cache-control':    'no-cache',
    'pragma':           'no-cache',
  };
  // Mimic the correct Fetch Metadata for each resource type
  const meta = {
    document: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1' },
    script:   { accept: '*/*', 'sec-fetch-dest': 'script',  'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' },
    style:    { accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' },
    image:    { accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' },
    font:     { accept: '*/*', 'sec-fetch-dest': 'font', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
    xhr:      { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'x-requested-with': 'XMLHttpRequest' },
  };
  return Object.assign({}, base, meta[resourceType] || meta.image);
}

module.exports = async (req, res) => {
  try {
    // Block cross-origin calls to this proxy from other sites
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ error: 'accès refusé' });

    const u    = req.query.url;
    const type = req.query.type || 'image'; // resource type hint for header selection
    let   wb   = req.query.wb;              // optional Wayback Machine timestamp

    if (!/^https?:\/\//i.test(u || ''))  return res.status(400).json({ error: 'lien invalide' });
    if (wb && !/^\d{1,14}$/.test(wb)) wb = null;

    const h = browserHeaders(type);

    // Range request support (chunked downloads)
    const from = req.query.from, to = req.query.to;
    if (/^\d+$/.test(from || '') && /^\d+$/.test(to || ''))
      h.range = `bytes=${from}-${to}`;

    let cur = u, r;
    for (let i = 0; i < 8; i++) {
      if (!wb) await assertPublic(cur);
      const target = wb ? `https://web.archive.org/web/${wb}id_/${cur}` : cur;
      r = await fetch(target, {
        redirect: wb ? 'follow' : 'manual',
        headers:  h,
        signal:   AbortSignal.timeout(12000),
      });
      // Follow redirects manually so we update cur (for SSRF guard)
      const loc = r.headers.get('location');
      if (!wb && r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).href;
        continue;
      }
      break;
    }

    // Size guard — check header first, then actual body
    const cl = +(r.headers.get('content-length') || 0);
    if (cl > 5e6) return res.status(413).json({ error: 'fichier > 5 Mo' });

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5.5e6) return res.status(413).json({ error: 'fichier > 5 Mo' });

    // Forward useful upstream headers
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.setHeader('x-upstream-status', String(r.status));
    res.setHeader('x-final-url',       new URL(cur).href);
    const cr = r.headers.get('content-range');
    if (cr) {
      res.setHeader('content-range', cr);
      res.setHeader('x-total', cr.split('/')[1] || '');
    }
    res.setHeader('cache-control', 'public, s-maxage=3600');
    res.status(r.status === 206 ? 206 : 200).send(buf);

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
