// Proxy minimal : récupère UN fichier distant et le renvoie au navigateur (évite le blocage CORS).
const dns = require('dns').promises, net = require('net');
const UA = 'Mozilla/5.0 (compatible; SiteSaver/1.0)';
const PRIV = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;
async function pub(u) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  const a = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (a.some(x => PRIV.test(x.address))) throw new Error('hôte privé interdit');
}
module.exports = async (req, res) => {
  try {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ error: 'accès refusé' });
    const u = req.query.url; let wb = req.query.wb;
    if (!/^https?:\/\//i.test(u || '')) return res.status(400).json({ error: 'lien invalide' });
    if (wb && !/^\d{1,14}$/.test(wb)) wb = null;
    const h = { 'user-agent': UA, accept: '*/*' };
    if (/^\d+$/.test(req.query.from || '') && /^\d+$/.test(req.query.to || '')) h.range = `bytes=${req.query.from}-${req.query.to}`;
    let cur = u, r;
    for (let i = 0; i < 6; i++) {
      if (!wb) await pub(cur);
      r = await fetch(wb ? `https://web.archive.org/web/${wb}id_/${cur}` : cur, {
        redirect: wb ? 'follow' : 'manual', headers: h, signal: AbortSignal.timeout(9000),
      });
      const l = r.headers.get('location');
      if (!wb && r.status >= 300 && r.status < 400 && l) { cur = new URL(l, cur).href; continue; }
      break;
    }
    if ((+r.headers.get('content-length') || 0) > 4e6) return res.status(413).json({ error: 'fichier > 4 Mo' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4.4e6) return res.status(413).json({ error: 'fichier > 4 Mo' });
    res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('x-upstream-status', String(r.status));
    res.setHeader('x-total', (r.headers.get('content-range') || '').split('/')[1] || '');
    res.setHeader('x-final-url', new URL(cur).href);
    res.setHeader('cache-control', 'public, s-maxage=3600');
    res.status(200).send(buf);
  } catch (e) { res.status(502).json({ error: e.message }); }
};
