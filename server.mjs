// Records F1's live timing feed (the part that needs no login) and serves it with the app.
// Run: node server.mjs   then open http://localhost:8765
// No login means no car positions: F1 only sends Position.z and CarData.z to F1TV subscribers.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

const PORT = 8765;
const HUB = 'livetiming.formula1.com/signalrcore';
// F1's CDN answers 403 to cloud servers (the Oracle VM). There, F1_RELAY names a Cloudflare Worker running
// relay-worker.js and F1_RELAY_KEY its RELAY_KEY, and the feed comes through Cloudflare instead.
const RELAY = process.env.F1_RELAY?.replace(/\/+$/, ''), RELAY_KEY = process.env.F1_RELAY_KEY ?? '';
const via = RELAY ? { 'x-relay-key': RELAY_KEY } : {};
// SessionInfo first: it names the session, and nothing is recorded before it.
const TOPICS = ['SessionInfo', 'SessionData', 'DriverList', 'LapCount', 'TimingData', 'TimingAppData',
  'RaceControlMessages', 'TeamRadio', 'PitLaneTimeCollection'];
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/map3d.js': ['map3d.js', 'text/javascript'],
  '/archivo.woff2': ['archivo.woff2', 'font/woff2'] }; // Archivo variable (weight and width), SIL Open Font License
const dir = new URL('./recordings/', import.meta.url);
mkdirSync(dir, { recursive: true });

let key = null, last = 0, lines = []; // the current session and its recorded messages, one JSON string each
let all = { n: -1, body: '' }; // every message joined, kept for the newcomers who ask for all of them (since=0)
const CLIP_MAX = 5e6; // bytes; a radio clip is well under 1 MB

// Every message is kept as [topic, data, time] so a viewer who joins late can replay from the start.
function record(topic, data, time) {
  if (topic === 'SessionInfo') open(data);
  if (key === null) return;
  const line = JSON.stringify([topic, data, time]);
  last = Date.now();
  lines.push(line);
  appendFileSync(new URL(`${key}.jsonl`, dir), line + '\n');
}

// Switch to a session, picking up what an earlier run recorded for it.
function open(info) {
  // The key names a file, so it must be a plain number: the feed is unofficial and could send anything.
  if (!/^\d+$/.test(info.Key) || String(info.Key) === key) return;
  key = String(info.Key);
  const file = new URL(`${key}.jsonl`, dir);
  lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  all = { n: -1, body: '' };
  console.log(`session ${key}: ${info.Meeting?.Name} ${info.Name}, ${lines.length} messages on disk`);
}

// The answer to Subscribe is the full current state of every topic.
function snapshot(state) {
  const info = state.SessionInfo;
  if (!info) return;
  // Between sessions the feed still shows the last one. Stamping that with today's time would
  // corrupt the timeline, so a finished session is only ever served from what was recorded live.
  if (/Finalised|Ends/.test(info.SessionStatus)) {
    if (/^\d+$/.test(info.Key) && existsSync(new URL(`${info.Key}.jsonl`, dir))) open(info);
    else console.log(`no live session (last: ${info.Meeting?.Name} ${info.Name}); waiting for the next one`);
    return;
  }
  const now = new Date().toISOString();
  for (const topic of TOPICS) if (state[topic]) record(topic, state[topic], now);
  if (!lines.some(l => l.startsWith('["Ref"'))) reference(info);
}

// What the app needs from OpenF1 for a live session, fetched once and kept in the recording as a
// "Ref" message: a reference lap of this circuit (for the estimated map) and the standings before
// this session, sprint points included. Start the server at least 30 minutes before a session:
// OpenF1's free tier may refuse requests while one is live.
// While a session is live OpenF1 refuses everyone without a key, so a server started then gets no lap
// from it. This builds a stand-in from MultiViewer's free circuit outline (F1's own coordinates, starting
// at the timing line) and times it with a simple lap model: each bend's speed from its curvature, then
// limits on accelerating and braking. calibrate() in app.js corrects the times from real mini-sectors.
// shortcut: the sector split is a guess of thirds, so the sector lines on the map are approximate; take
// the real split from the feed's sector times if they matter.
async function outline(circuit) {
  const r = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuit}/${new Date().getUTCFullYear()}`,
    { headers: { 'user-agent': 'f1-replay' } });
  if (!r.ok) throw new Error(`MultiViewer answered ${r.status}`);
  const { x, y } = await r.json();
  if (!(x?.length > 50)) throw new Error('MultiViewer has no outline');
  // Points every 5 m (50 units) round the closed loop.
  const raw = x.map((v, i) => ({ x: v, y: y[i] })), pts = [];
  raw.push(raw[0]);
  for (let i = 1, carry = 0; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    for (let s = carry; s < d; s += 50) pts.push({ x: a.x + (b.x - a.x) * s / d, y: a.y + (b.y - a.y) * s / d });
    carry = (carry - d) % 50; if (carry < 0) carry += 50;
  }
  const n = pts.length, ds = 5; // metres between points
  const ring = i => (i % n + n) % n;
  // The outline is a polyline with a corner every 10 m or so: smooth it over ±15 m first, or every
  // vertex reads as a little bend.
  const sm = pts.map((_, i) => {
    let x = 0, y = 0;
    for (let j = -3; j <= 3; j++) { x += pts[ring(i + j)].x; y += pts[ring(i + j)].y; }
    return { x: x / 7, y: y / 7 };
  });
  // Curvature (1/m) from the circle through points 25 m either side, then averaged over ±20 m with
  // weights that fade out, so speed changes evenly through a corner instead of in steps.
  const bend = sm.map((_, i) => {
    const a = sm[ring(i - 5)], b = sm[i], c = sm[ring(i + 5)];
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const abc = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * Math.hypot(c.x - a.x, c.y - a.y);
    return abc ? 2 * cross / abc * 10 : 0; // positions are in 1/10 m
  });
  const kappa = bend.map((_, i) => {
    let sum = 0, w = 0;
    for (let j = -4; j <= 4; j++) { const f = 5 - Math.abs(j); sum += bend[ring(i + j)] * f; w += f; }
    return sum / w;
  });
  // Grip grows with speed (downforce): lateral 1.5 g plus 2.5 g × (v/VMAX)², so v² κ = that gives the
  // corner speed directly. Braking also grows with speed; accelerating fades towards top speed.
  const G = 9.81, VMAX = 95; // m/s: a low-downforce car on a long straight
  const v = kappa.map(k => { const d = k - 2.5 * G / VMAX ** 2; return d > 0 ? Math.min(VMAX, Math.sqrt(1.5 * G / d)) : VMAX; });
  const acc = u => 12 * (1 - u / VMAX), brake = u => G * (2 + 3 * (u / VMAX) ** 2);
  for (let pass = 0; pass < 2; pass++) { // twice round, so the limits carry over the line
    for (let i = 1; i <= n; i++) { const k = i % n, p = v[i - 1]; v[k] = Math.min(v[k], Math.sqrt(p * p + 2 * acc(p) * ds)); }
    for (let i = n - 2; i >= -1; i--) { const k = ring(i), q = v[ring(k + 1)]; v[k] = Math.min(v[k], Math.sqrt(q * q + 2 * brake(q) * ds)); }
  }
  let t = 0;
  const out = sm.map((p, i) => { // timed over the real spacing: smoothing draws corner points closer together
    const pt = { t, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }, q = sm[ring(i + 1)];
    t += Math.hypot(q.x - p.x, q.y - p.y) / 10 / ((v[i] + v[ring(i + 1)]) / 2) * 1000;
    return pt;
  });
  return { lap: t, s1: t / 3, s2: t / 3, pts: out, estimated: true };
}

async function reference(info) {
  const get = async path => {
    await new Promise(r => setTimeout(r, 400)); // free tier: 3 requests a second
    const r = await fetch(`https://api.openf1.org/v1/${path}`);
    if (r.status === 404) return []; // OpenF1 answers 404 for "no rows"
    if (!r.ok) throw new Error(`OpenF1 answered ${r.status}`);
    return r.json();
  };
  const free = s => !s.is_cancelled && Date.now() > Date.parse(s.date_end) + 30 * 60e3;
  const latest = list => list.filter(free).sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start)).pop();
  try {
    let track = null;
    const here = latest(await get(`sessions?circuit_key=${info.Meeting.Circuit.Key}`));
    if (here) {
      const k = `session_key=${here.session_key}`;
      const best = (await get(`laps?${k}`))
        .filter(l => l.lap_duration && l.date_start && !l.is_pit_out_lap && l.lap_number > 1 && l.duration_sector_1 && l.duration_sector_2)
        .sort((a, b) => a.lap_duration - b.lap_duration)[0];
      if (best) {
        const t0 = Date.parse(best.date_start), iso = t => new Date(t).toISOString();
        const pts = (await get(`location?${k}&driver_number=${best.driver_number}&date>=${iso(t0)}&date<=${iso(t0 + best.lap_duration * 1000)}`))
          .filter(p => p.x || p.y).map(p => ({ t: Date.parse(p.date) - t0, x: p.x, y: p.y }));
        if (pts.length > 10) track = { lap: best.lap_duration * 1000, s1: best.duration_sector_1 * 1000, s2: best.duration_sector_2 * 1000, pts };
      }
    }
    // Races and sprints both score, so the last finished one of either kind has the current totals.
    const scored = latest(await get(`sessions?year=${new Date().getUTCFullYear()}&session_type=Race`));
    const totals = async table => scored
      ? (await get(`${table}?session_key=${scored.session_key}`)).map(r => ({ ...r, points_start: r.points_current })) : [];
    const ref = { track, champD: await totals('championship_drivers'), champT: await totals('championship_teams') };
    if (String(info.Key) === key) record('Ref', ref, new Date().toISOString());
    console.log(`reference data stored: ${track ? `lap from session ${here.session_key}` : 'no lap found'}, ${ref.champD.length} drivers in the standings`);
  } catch (err) {
    console.log(`reference data failed (${err.message}); trying again in 10 minutes`);
    if (!lines.some(l => l.startsWith('["Ref"'))) {
      try {
        const track = await outline(info.Meeting.Circuit.Key);
        if (String(info.Key) === key) record('Ref', { track, champD: [], champT: [] }, new Date().toISOString());
        console.log(`estimated reference lap stored from MultiViewer's outline (${track.pts.length} points, ${(track.lap / 1000).toFixed(1)} s)`);
      } catch (e) {
        console.log(`no estimated reference lap either (${e.message})`);
      }
    }
    setTimeout(() => { if (String(info.Key) === key) reference(info); }, 10 * 60e3);
  }
}

async function connect() {
  try {
    const r = await fetch(RELAY ? `${RELAY}/negotiate` : `https://${HUB}/negotiate?negotiateVersion=1`, { method: 'POST', headers: via });
    if (!r.ok) throw new Error(`negotiate answered ${r.status}`);
    const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const { connectionToken } = await r.json();
    const id = encodeURIComponent(connectionToken);
    const ws = new WebSocket(RELAY ? `${RELAY.replace(/^http/, 'ws')}/?id=${id}` : `wss://${HUB}?id=${id}`, { headers: { Cookie: cookie, ...via } });
    const send = m => ws.send(JSON.stringify(m) + '\x1e');
    let ping;
    ws.onopen = () => {
      send({ protocol: 'json', version: 1 });
      send({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] });
      ping = setInterval(() => send({ type: 6 }), 15000); // the hub drops clients that stay silent
      console.log(`connected to the F1 feed${RELAY ? ` through ${RELAY}` : ''}`);
    };
    ws.onmessage = e => {
      for (const part of String(e.data).split('\x1e')) {
        if (!part) continue;
        try {
          const m = JSON.parse(part);
          if (m.type === 3 && m.result) snapshot(m.result);
          if (m.type === 1 && m.target === 'feed') {
            const [topic, data, time] = m.arguments;
            // A new session sends only changes; reconnecting gets its full state.
            if (topic === 'SessionInfo' && data.Key && String(data.Key) !== key) ws.close();
            else record(topic, data, time);
          }
          if (m.type === 7) ws.close();
        } catch (err) {
          console.log('bad feed message skipped:', err.message);
        }
      }
    };
    ws.onerror = () => {}; // onclose follows and reconnects
    ws.onclose = () => { clearInterval(ping); console.log('feed closed, reconnecting'); setTimeout(connect, 5000); };
  } catch (err) {
    console.log('feed unreachable:', err.message);
    setTimeout(connect, 15000);
  }
}

createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { /* a path such as // is not a valid address */ }
  if (!url) { res.writeHead(400); return res.end('Bad request'); }
  res.setHeader('access-control-allow-origin', 'https://candrewchen.github.io'); // the GitHub Pages copy reads /live and /radio
  if (url.pathname === '/live') {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    // shortcut: "live" is any message in the last minute, so a long silence in a stopped session reads as not live; use SessionStatus if that matters.
    // A newcomer asks for everything, which late in a race is many MB: join it once per new message, not once per request.
    if (since === 0 && all.n !== lines.length) all = { n: lines.length, body: lines.join(',') };
    const body = since === 0 ? all.body : lines.slice(since).join(',');
    // shortcut: no rate limit here, since behind the VM's proxy every request comes from 127.0.0.1; limit per IP in the proxy if /live is abused.
    return res.end(`{"key":${key},"live":${Date.now() - last < 60e3},"next":${lines.length},"lines":[${body}]}`);
  }
  if (url.pathname === '/radio') {
    // F1's server does not let a web page read its radio clips, only play them. The page gets a clip
    // through here to transcribe it. Only that one server's .mp3 files are ever fetched.
    let clip;
    try { clip = new URL(url.searchParams.get('u')); } catch { /* not an address: refused below */ }
    if (clip?.origin !== 'https://livetiming.formula1.com' || !clip.pathname.startsWith('/static/') || !clip.pathname.endsWith('.mp3')) {
      res.writeHead(400);
      return res.end('Not a radio clip');
    }
    // No redirects (they could lead anywhere) and nothing larger than a clip can be.
    fetch(clip, { redirect: 'error' }).then(async r => {
      if (Number(r.headers.get('content-length')) > CLIP_MAX) throw new Error('too large');
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > CLIP_MAX) throw new Error('too large');
      res.writeHead(r.ok ? 200 : 502, { 'content-type': 'audio/mpeg' });
      res.end(body);
    }).catch(() => { res.writeHead(502); res.end(); });
    return;
  }
  const file = FILES[url.pathname]; // fixed list: no path from the request ever reaches the disk
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(readFileSync(new URL(file[0], import.meta.url)));
// shortcut: this machine only; to let other people watch, host it and listen on 0.0.0.0 behind HTTPS.
}).listen(PORT, '127.0.0.1', () => console.log(`open http://localhost:${PORT}`));

connect();
