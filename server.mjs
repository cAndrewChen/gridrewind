// Records F1's live timing feed (the part that needs no login) and serves it with the app.
// Run: node server.mjs   then open http://localhost:8765
// No login means no car positions: F1 only sends Position.z and CarData.z to F1TV subscribers.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

const PORT = 8765;
const HUB = 'livetiming.formula1.com/signalrcore';
// SessionInfo first: it names the session, and nothing is recorded before it.
const TOPICS = ['SessionInfo', 'SessionData', 'DriverList', 'LapCount', 'TimingData', 'TimingAppData',
  'RaceControlMessages', 'TeamRadio', 'PitLaneTimeCollection'];
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/archivo.woff2': ['archivo.woff2', 'font/woff2'] }; // Archivo variable (weight and width), SIL Open Font License
const dir = new URL('./recordings/', import.meta.url);
mkdirSync(dir, { recursive: true });

let key = null, lines = []; // the current session and its recorded messages, one JSON string each

// Every message is kept as [topic, data, time] so a viewer who joins late can replay from the start.
function record(topic, data, time) {
  if (topic === 'SessionInfo') open(data);
  if (key === null) return;
  const line = JSON.stringify([topic, data, time]);
  lines.push(line);
  appendFileSync(new URL(`${key}.jsonl`, dir), line + '\n');
}

// Switch to a session, picking up what an earlier run recorded for it.
function open(info) {
  if (!info.Key || info.Key === key) return;
  key = info.Key;
  const file = new URL(`${key}.jsonl`, dir);
  lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  console.log(`session ${key}: ${info.Meeting?.Name} ${info.Name}, ${lines.length} messages on disk`);
}

// The answer to Subscribe is the full current state of every topic.
function snapshot(state) {
  const info = state.SessionInfo;
  if (!info) return;
  // Between sessions the feed still shows the last one. Stamping that with today's time would
  // corrupt the timeline, so a finished session is only ever served from what was recorded live.
  if (/Finalised|Ends/.test(info.SessionStatus)) {
    if (existsSync(new URL(`${info.Key}.jsonl`, dir))) open(info);
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
    if (info.Key === key) record('Ref', ref, new Date().toISOString());
    console.log(`reference data stored: ${track ? `lap from session ${here.session_key}` : 'no lap found'}, ${ref.champD.length} drivers in the standings`);
  } catch (err) {
    console.log(`reference data failed (${err.message}); trying again in 10 minutes`);
    setTimeout(() => { if (info.Key === key) reference(info); }, 10 * 60e3);
  }
}

async function connect() {
  try {
    const r = await fetch(`https://${HUB}/negotiate?negotiateVersion=1`, { method: 'POST' });
    if (!r.ok) throw new Error(`negotiate answered ${r.status}`);
    const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const { connectionToken } = await r.json();
    const ws = new WebSocket(`wss://${HUB}?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie } });
    const send = m => ws.send(JSON.stringify(m) + '\x1e');
    let ping;
    ws.onopen = () => {
      send({ protocol: 'json', version: 1 });
      send({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] });
      ping = setInterval(() => send({ type: 6 }), 15000); // the hub drops clients that stay silent
      console.log('connected to the F1 feed');
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
            if (topic === 'SessionInfo' && data.Key && data.Key !== key) ws.close();
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
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/live') {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(`{"key":${key},"next":${lines.length},"lines":[${lines.slice(since).join(',')}]}`);
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
    fetch(clip).then(async r => {
      const body = Buffer.from(await r.arrayBuffer());
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
