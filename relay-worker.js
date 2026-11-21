// Cloudflare Worker (free plan): carries server.mjs's connection to F1's live timing feed, because F1's
// CDN answers 403 to cloud servers such as the Oracle VM. server.mjs uses it when F1_RELAY is set.
// Setup: Cloudflare dashboard > Workers > Create > paste this file > Deploy, then Settings > Variables
// and Secrets > add a Secret named RELAY_KEY (the same value as F1_RELAY_KEY on the VM).
const HUB = 'https://livetiming.formula1.com/signalrcore';

// A close code a WebSocket may send on: 1005, 1006 and 1015 only describe a close, they cannot be sent.
const sendable = code => code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000;

export default {
  async fetch(req, env) {
    // Only the VM may use it: without the key anyone could run their own feed through this account.
    if (!env.RELAY_KEY || req.headers.get('x-relay-key') !== env.RELAY_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(req.url);

    if (url.pathname === '/negotiate' && req.method === 'POST') {
      const r = await fetch(`${HUB}/negotiate?negotiateVersion=1`, { method: 'POST' });
      // fetch has already unpacked the body, so only its type and the cookies are passed on.
      const headers = new Headers({ 'content-type': r.headers.get('content-type') ?? 'application/json' });
      for (const c of r.headers.getSetCookie()) headers.append('set-cookie', c);
      return new Response(await r.text(), { status: r.status, headers });
    }

    if (url.pathname === '/' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const up = await fetch(`${HUB}?id=${encodeURIComponent(url.searchParams.get('id') ?? '')}`, {
        headers: { Upgrade: 'websocket', Cookie: req.headers.get('cookie') ?? '' },
      });
      if (!up.webSocket) return new Response(`feed answered ${up.status}`, { status: 502 });
      const feed = up.webSocket, [client, vm] = Object.values(new WebSocketPair());
      feed.accept();
      vm.accept();
      feed.addEventListener('message', e => vm.send(e.data));
      vm.addEventListener('message', e => feed.send(e.data));
      const end = ws => e => { try { ws.close(sendable(e.code), e.reason); } catch { /* already closed */ } };
      feed.addEventListener('close', end(vm));
      vm.addEventListener('close', end(feed));
      feed.addEventListener('error', () => end(vm)({ code: 1011, reason: 'feed error' }));
      vm.addEventListener('error', () => end(feed)({ code: 1011, reason: 'vm error' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  },
};
