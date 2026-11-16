// F1 race replay on the free OpenF1 API (historical data, 2023 onwards), plus a live mode fed by server.mjs.
const API = 'https://api.openf1.org/v1/';
const FREE_AFTER = 30 * 60e3; // OpenF1 charges for data until 30 min after a session ends
const CHUNK = 5 * 60e3;       // car positions are fetched in 5-minute pieces (about 3 MB each)
const STALE = 3 * 60e3;       // a gap older than this belongs to a stopped car
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
// shortcut: one fuel figure for every circuit (a lighter car gains about this much per lap); use per-circuit values if wear numbers look off.
const FUEL = 0.05;
const TYRE = { SOFT: '#f33', MEDIUM: '#fd0', HARD: '#fff', INTERMEDIATE: '#3c3', WET: '#39f' };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const ms = d => Date.parse(d);
const iso = t => new Date(t).toISOString();
const say = text => { $('status').textContent = text; };
const byTime = (a, b) => a.t - b.t;

// A finished session never changes, and neither does a past season's race list: those answers are
// kept in the browser (Cache API) and fetched once. This season's race list is always fetched.
// shortcut: nothing is ever evicted (a full race is about 70 MB); clear the site's data if it grows too big.
const keep = path => path.includes('session_key=') || +path.match(/year=(\d+)/)?.[1] < new Date().getFullYear();
// The free tier allows 3 requests a second and 30 a minute: requests start at least 340 ms apart, in the
// order they were asked for, and may overlap.
let nextAt = 0;
async function api(path) {
  // No cache in private windows or on plain http: then every call just goes to the network.
  const store = keep(path) ? await window.caches?.open('openf1').catch(() => null) : null;
  const hit = await store?.match(API + path);
  if (hit) return hit.json();
  for (let i = 1; i <= 5; i++) {
    nextAt = Math.max(Date.now(), nextAt + 340);
    await sleep(nextAt - Date.now());
    const r = await fetch(API + path);
    if (r.status === 429) { await sleep(3000 * i); continue; }
    if (r.status === 404) return []; // OpenF1 answers 404 for "no rows" (not cached: the rows may come later)
    if (!r.ok) throw new Error(`OpenF1 answered ${r.status}`);
    store?.put(API + path, r.clone()).catch(() => {}); // a full disk must not break the replay
    return r.json();
  }
  throw new Error('OpenF1 rate limit reached, try again in a minute');
}

// Index of the last item at or before time t, -1 if none. arr is sorted by time.
function idx(arr, t, key = x => x.t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
const at = (arr, t) => arr?.[idx(arr, t)];

function group(rows, f) {
  const out = {};
  for (const r of rows) (out[r.driver_number] ??= []).push(f(r));
  for (const k in out) out[k].sort(byTime);
  return out;
}

// Position a car would hold after losing `loss` seconds in the pits. gaps: the other cars' gaps to the leader.
const rejoin = (gap, loss, gaps) => 1 + gaps.filter(g => g < gap + loss).length;

const median = a => a.sort((x, y) => x - y)[a.length >> 1];
const box = pts => ({ x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)),
                      y0: Math.min(...pts.map(p => p.y)), y1: Math.max(...pts.map(p => p.y)) });
const name = n => S.drivers[n]?.name_acronym ?? `#${n}`;

// ---- season and race bars ----

let year, loadId = 0, S = null, playing = false;

function buttons(nav, items, pressed, onPick) {
  nav.textContent = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    b.title = it.title ?? '';
    b.disabled = !!it.disabled;
    b.setAttribute('aria-pressed', it.value === pressed);
    b.onclick = () => onPick(it.value);
    nav.append(b);
    if (it.value === pressed) nav.scrollLeft = b.offsetLeft - nav.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2; // centred in its row (scrollIntoView would also move the page)
  }
}

async function showYear(y) {
  year = y;
  const now = new Date().getFullYear();
  buttons($('years'), Array.from({ length: now - 2022 }, (_, i) => ({ label: 2023 + i, value: 2023 + i })), y, showYear);
  $('races').textContent = '';
  loading(0, 1, 'races');
  let sessions;
  try { sessions = await api(`sessions?year=${y}&session_type=Race`); } catch (e) { return fail(e.message); } // races and sprints
  if (y !== year) return;
  sessions.sort((a, b) => ms(a.date_start) - ms(b.date_start));
  const ready = s => !s.is_cancelled && Date.now() > ms(s.date_end) + FREE_AFTER;
  // One button per race weekend. A weekend with a sprint gets a Race / Sprint choice beside the title.
  const meets = Object.values(sessions.reduce((by, s) => ((by[s.meeting_key] ??= []).push(s), by), {})).sort((a, b) => ms(a[0].date_start) - ms(b[0].date_start));
  const pick = s => {
    const m = meets.find(m => m.includes(s));
    buttons($('races'), meets.map(m => ({
      label: m.at(-1).circuit_short_name, value: m, disabled: !m.some(ready), // the race is the weekend's last session
      title: `${m[0].country_name}, ${m.at(-1).date_start.slice(0, 10)}${m.some(ready) ? '' : ' (no free data yet)'}`,
    })), m, m => pick(m.findLast(ready)));
    buttons($('kind'), m?.length > 1 ? m.toReversed().map(x => ({ label: x.session_name, value: x, disabled: !ready(x), title: ready(x) ? '' : 'No free data yet' })) : [], s, pick);
    if (s) loadRace(s);
  };
  const last = sessions.findLast(ready);
  pick(last);
  if (!last) fail(sessions.length ? 'No finished race this season yet.' : 'No races found.');
}

// ---- loading one race ----

// What is still loading, shown on the map card ("Loading gaps… 5 of 13"); nothing left hides it.
function loading(done, total, what) {
  $('loading').hidden = done >= total;
  $('loadText').textContent = `Loading ${what}…${total > 1 ? ` ${done + 1} of ${total}` : ''}`;
  $('loadBar').style.width = `${100 * done / total}%`;
}
const fail = text => { $('loading').hidden = true; say(text); };
// Until a session has its first data only the map card shows, with the loading line on it.
function blank() {
  for (const id of ['timing', 'more', 'champ', 'rcBox', 'radioBox', 'otBox']) $(id).hidden = true;
  $('stage').classList.add('empty');
  tab('timing'); // the next race may have no overtakes or standings to show
  setView({ z: 1, x: 0, y: 0 });
  fit($('map')); // wipes the last session's map
  window.draw3d?.(); // and the 3D one: with no session it draws an empty sky
  $('rc').textContent = $('radio').textContent = $('ot').textContent = '';
  audio.pause();
}

// In the order they are fetched: the first four draw the map and the timing tower, the rest fill in behind them.
const PARTS = { drivers: 'drivers', laps: 'laps', position: 'positions', location: 'the track', intervals: 'gaps', stints: 'tyres', pit: 'pit stops',
  race_control: 'race control', team_radio: 'radio', championship_drivers: 'standings', championship_teams: 'standings', overtakes: 'overtakes', session_result: 'results' };

async function loadRace(s) {
  const id = ++loadId, k = `session_key=${s.session_key}`, names = Object.values(PARTS);
  S = null;
  setPlaying(false);
  blank();
  say(`${s.circuit_short_name} ${s.year} ${s.session_name} · ${s.country_name}`);
  let done = 0;
  loading(0, names.length, names[0]);
  const get = path => api(path).then(rows => { if (id === loadId) loading(++done, names.length, names[done]); return rows; });
  try {
    const [drivers, laps, pos] = await Promise.all(['drivers', 'laps', 'position'].map(e => get(`${e}?${k}`)));
    if (id !== loadId) return;
    if (!laps.length || !drivers.length) return fail('No timing data for this race.');

    // The track outline is one clean lap of one car.
    const best = laps.filter(l => l.lap_duration && l.date_start && !l.is_pit_out_lap && l.lap_number > 1)
      .sort((a, b) => a.lap_duration - b.lap_duration)[0];
    const t = best ? ms(best.date_start) : 0;
    const outline = best ? await get(`location?${k}&driver_number=${best.driver_number}&date>=${iso(t)}&date<=${iso(t + best.lap_duration * 1000 + 500)}`) : [];
    if (id !== loadId) return;
    const track = outline.filter(p => p.x || p.y);
    if (track.length < 10) return fail('No position data for this race.');
    const s1 = best.duration_sector_1, s2 = best.duration_sector_2;

    const timed = laps.filter(l => l.date_start);
    const start = Math.min(...timed.filter(l => l.lap_number === 1).map(l => ms(l.date_start)));
    const r = S = {
      k, start,
      t0: start - 60e3,
      t1: Math.max(...timed.map(l => ms(l.date_start) + (l.lap_duration ?? 0) * 1000)) + 60e3,
      t: start - 60e3,
      pts: s.session_name === 'Sprint' ? SPRINT_PTS : PTS,
      drivers: Object.fromEntries(drivers.map(d => [d.driver_number, d])),
      laps: group(timed, l => ({ t: ms(l.date_start), n: l.lap_number, d: l.lap_duration })),
      totalLaps: Math.max(...laps.map(l => l.lap_number)),
      pos: group(pos, p => ({ t: ms(p.date), p: p.position })),
      intv: {}, stints: {}, pits: {}, rc: [], radio: [], overtakes: [], champD: [], champT: [], pitLoss: null, out: {}, // filled in below
      track, box: box(track), circuit: s.circuit_short_name,
      marks: s1 && s2 ? [0, s1, s1 + s2].map(u => Math.max(0, track.findIndex(p => ms(p.date) >= t + u * 1000))) : [], // where each sector starts, as places in `track`
      pending: {}, loc: {}, shown: {},
    };
    $('seek').max = Math.round((r.t1 - r.t0) / 1000);
    $('seek').value = 0;
    showPitLoss();
    $('stage').classList.remove('empty');
    $('timing').hidden = $('more').hidden = false;
    render();
    chunk(0); // the cars come next, before the rest

    const fill = {
      intervals: rows => { r.intv = group(rows, i => ({ t: ms(i.date), gap: i.gap_to_leader, int: i.interval })); },
      stints: rows => { r.stints = group(rows, x => ({ t: x.lap_start, ...x })); },
      pit: rows => {
        r.pits = group(rows, p => ({ t: ms(p.date) }));
        const lane = rows.map(p => p.lane_duration ?? p.pit_duration).filter(d => d > 0 && d < 90); // 90 s: drops red-flag "stops"
        r.pitLoss = lane.length ? median(lane) : null;
        showPitLoss();
      },
      race_control: rows => { r.rc = rows.map(m => ({ t: ms(m.date), ...m })).sort(byTime); $('rcBox').hidden = false; },
      team_radio: rows => { r.radio = rows.map(m => ({ t: ms(m.date), ...m })).sort(byTime); $('radioBox').hidden = false; },
      championship_drivers: rows => { r.champD = rows; $('champ').hidden = !rows.length; },
      championship_teams: rows => { r.champT = rows; },
      overtakes: rows => { r.overtakes = rows.map(o => ({ t: ms(o.date), ...o })).sort(byTime).map((o, i) => ({ ...o, i })); $('otBox').hidden = !rows.length; },
      // Retirements. from: the start of the lap the car never finished; due: when it should have come round again.
      session_result: rows => {
        for (const x of rows) if (x.dnf || x.dns) {
          const l = r.laps[x.driver_number] ?? [], a = l.at(-1), lap = a && l.at(-2) ? a.t - l.at(-2).t : 120e3;
          const from = !a ? 0 : a.n > x.number_of_laps ? a.t : a.t + lap; // the unfinished lap is usually listed, with no time
          r.out[x.driver_number] = x.dns || !a ? { dns: true, due: -Infinity } : { from, due: from + lap * 1.1 };
        }
      },
    };
    await Promise.all(Object.keys(fill).map(e => get(`${e}?${k}`).then(rows => { if (r === S) fill[e](rows); })));
  } catch (e) {
    if (id === loadId) fail(e.message);
  }
}

const showPitLoss = () => { $('pitloss').textContent = S.pitLoss ? `A pit stop costs about ${S.pitLoss.toFixed(1)} s here.` : ''; };

// The feed gives a car's position every 160 to 440 ms, with timestamps tens of ms out: drawn straight from
// that, a car lurches (its speed changes by 16 m/s from one sample to the next, on average). smooth() turns one
// car's samples into a position every GRID ms, each the average of where it was over HALF steps either side.
const GRID = 100, HALF = 4;
function smooth(t, x, y) {
  const n = Math.floor((t.at(-1) - t[0]) / GRID) + 1, raw = [x, y].map(v => {
    const out = new Float64Array(n);
    for (let g = 0, i = 0; g < n; g++) {
      const at = t[0] + g * GRID;
      while (i + 2 < t.length && t[i + 1] <= at) i++;
      const gap = t[i + 1] - t[i];
      out[g] = gap > 3000 ? NaN : v[i] + (v[i + 1] - v[i]) * Math.min((at - t[i]) / gap, 1); // no signal for 3 s: no position, not a straight glide
    }
    return out;
  });
  const [sx, sy] = raw.map(v => v.map((_, g) => {
    const h = Math.min(HALF, g, n - 1 - g); // a narrower window at the ends, so the two sides always balance
    let sum = 0;
    for (let j = g - h; j <= g + h; j++) sum += v[j];
    return sum / (2 * h + 1);
  }));
  return { t0: t[0], x: sx, y: sy };
}

// Car positions for 5-minute piece i, fetched once.
function chunk(i) {
  const s = S;
  if (s.live || i < 0 || s.t0 + i * CHUNK > s.t1 || s.pending[i]) return;
  s.pending[i] = api(`location?${s.k}&date>=${iso(s.t0 + i * CHUNK)}&date<${iso(s.t0 + (i + 1) * CHUNK)}`).then(rows => {
    const d = {};
    for (const r of rows) {
      if (!(r.x || r.y)) continue; // 0,0 means "no signal"
      const a = d[r.driver_number] ??= { t: [], x: [], y: [] };
      const at = ms(r.date);
      if (at > (a.t.at(-1) ?? 0)) { a.t.push(at); a.x.push(r.x); a.y.push(r.y); }
    }
    for (const n in d) if (d[n].t.length > 1) d[n] = smooth(d[n].t, d[n].x, d[n].y); else delete d[n];
    s.loc[i] = d;
  }, e => { if (s === S) say(e.message); });
}

function carXY(num, t) {
  if (S.live) {
    const P = liveP(num, t);
    return P === undefined ? undefined : traceXY(S.ref, P);
  }
  const d = S.loc[Math.floor((t - S.t0) / CHUNK)]?.[num];
  if (!d) return;
  const g = (t - d.t0) / GRID, i = Math.max(0, Math.min(d.x.length - 2, Math.floor(g))), f = Math.max(0, Math.min(1, g - i));
  const x = d.x[i] + (d.x[i + 1] - d.x[i]) * f, y = d.y[i] + (d.y[i + 1] - d.y[i]) * f;
  return x === x ? [x, y] : undefined; // NaN: no signal
}

// A retired car is "gone" 30 s after it stopped for good: it leaves the map and the tower says DNF.
function gone(n, t) {
  const o = S.out[n];
  if (!o) return false;
  if (t > o.due + 30e3) return true; // it never came round again
  if (S.live || t < o.from + 30e3) return false;
  const a = carXY(n, t), b = carXY(n, t - 30e3); // on its last lap and not moved for 30 s
  return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 20;
}

// ---- track surface ----
// The position data has no sideways information: it puts every car on one shared line (within 10 cm of each
// other), and that line is a racing line, not the middle of the road (at Interlagos it is 4235 m long, exactly
// the length of a computed racing line and 70 m shorter than the surveyed centre line). So the track's edges
// cannot be measured from the cars. The track is drawn round that line, with the room to each side taken from:
// - a surveyed map of the circuit, which says how far a racing line is from each edge all the way round: survey();
// - where there is no map, or it no longer matches the layout, an estimate: road().
const WIDTH = 120; // 12 m, typical for F1 (Interlagos, surveyed: 9 to 18 m, median 11.7); positions are in 1/10 m
const STEP = 50;   // 5 m between stations along the line

// Moving average over r neighbours each side, round a closed loop.
const blur = (a, r) => a.map((_, i) => { let s = 0; for (let j = -r; j <= r; j++) s += a.at((i + j) % a.length); return s / (2 * r + 1); });

// A closed loop of [x, y] as n evenly spaced points.
function even(pts, n) {
  const len = pts.map((p, i) => Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]));
  const step = len.reduce((a, b) => a + b, 0) / n, out = [];
  let need = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    for (; need < len[i] && out.length < n; need += step) out.push([p[0] + (q[0] - p[0]) * need / len[i], p[1] + (q[1] - p[1]) * need / len[i]]);
    need -= len[i];
  });
  return out;
}
// Direction of travel at each point of a closed loop, in radians, and how much it turns before the next point.
const heading = c => c.map((_, i) => Math.atan2(c[(i + 2) % c.length][1] - c.at(i - 2)[1], c[(i + 2) % c.length][0] - c.at(i - 2)[0]));
const turning = c => { const th = heading(c); return th.map((a, i) => Math.asin(Math.sin(th[(i + 1) % th.length] - a))); };
// Index of the point in list nearest to q.
function nearest(list, q) {
  let k = 0, d = Infinity;
  list.forEach((m, i) => { const e = (m[0] - q[0]) ** 2 + (m[1] - q[1]) ** 2; if (e < d) { d = e; k = i; } });
  return k;
}

// The racing line (one real lap) as stations 5 m apart: a closed loop of [x, y].
function stations(track) {
  // The lap is recorded slightly past the line: cut it where it comes back closest to its start.
  const far = i => Math.hypot(track[i].x - track[0].x, track[i].y - track[0].y);
  let end = track.length - 1;
  for (let i = track.length * 0.9 | 0; i < track.length; i++) if (far(i) < far(end)) end = i;
  const loop = track.slice(0, end + 1).map(p => [p.x, p.y]);
  const len = loop.reduce((a, p, i) => a + Math.hypot(loop[(i + 1) % loop.length][0] - p[0], loop[(i + 1) % loop.length][1] - p[1]), 0);
  return even(loop, Math.round(len / STEP));
}

// The two edges of the track, as lists of [x, y], given the room to the left and to the right of each station.
function band(c, left, right) {
  const th = heading(c);
  return [[left, 1], [right, -1]].map(([room, sign]) => blur(room, 3).map((o, i) => [c[i][0] - sign * Math.sin(th[i]) * o, c[i][1] + sign * Math.cos(th[i]) * o]));
}

// Estimated room to the [left, right] of each station, from two assumptions:
// 1. the track is WIDTH wide all the way round;
// 2. a racing line runs outside, inside, outside through a corner, which says where the line sits across the track.
function rooms(c) {
  const turn = turning(c), wide = blur(turn, 40);
  // How sharply the line turns here (over 20 m) against how much it turns around here (over 200 m): at an apex
  // the first is bigger and the line hugs the inside; just before and after a corner it is smaller and the line is outside.
  const dog = blur(turn, 4).map((k, i) => k - wide[i]), rms = Math.hypot(...dog) / Math.sqrt(c.length) || 1;
  // u: where the line sits across the track, from -0.8 (near the right edge) to 0.8 (near the left); a car never drives on the very edge.
  const u = dog.map(d => Math.max(-.8, Math.min(.8, 2 * d / rms)));
  return [u.map(v => WIDTH * (1 - v) / 2), u.map(v => WIDTH * (1 + v) / 2)];
}
const road = track => { const c = stations(track); return { of: track, edges: band(c, ...rooms(c)) }; };

// Surveyed maps: TUM's racetrack database (LGPL-3.0), read from GitHub and kept in the browser cache. Each has
// the centre line with the width to each side, and a racing line computed for that track.
// OpenF1's circuit name -> the database's file name. It has no street circuits and no track built after 2020.
const MAP_URL = 'https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/';
const MAPS = { Austin: 'Austin', Catalunya: 'Catalunya', Hungaroring: 'Budapest', Interlagos: 'SaoPaulo', 'Kuala Lumpur': 'Sepang',
  Melbourne: 'Melbourne', 'Mexico City': 'MexicoCity', Montreal: 'Montreal', Monza: 'Monza', Sakhir: 'Sakhir', Shanghai: 'Shanghai',
  Silverstone: 'Silverstone', 'Spa-Francorchamps': 'Spa', Spielberg: 'Spielberg', Suzuka: 'Suzuka', 'Yas Marina Circuit': 'YasMarina', Zandvoort: 'Zandvoort' };
// How well a map must agree with our line, in 1/10 m. Measured over 17 circuits: an unchanged layout is 2 to 5 m
// out over the lap, one with rebuilt corners 6 to 9 m (Catalunya, Melbourne, Yas Marina), another circuit over 100 m.
const MAX_MISFIT = 120; // over the whole lap: beyond this the map is not used at all
const NEAR = 80;        // at one station: beyond this (a rebuilt corner) that station keeps its estimate

async function csv(url) {
  const store = await window.caches?.open('openf1').catch(() => null);
  let r = await store?.match(url);
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    store?.put(url, r.clone()).catch(() => {});
  }
  return (await r.text()).split('\n').filter(l => l && l[0] !== '#').map(l => l.split(',').map(Number));
}

// Lays a map's racing line over ours, to find which point of one is which point of the other.
// line: ours, in 1/10 m; race: the map's, in m; both closed loops of [x, y]. Returns
// { move, err, mirrored }: move takes a map point to our coordinates; err is how far apart the two lines stay
// (root mean square, 1/10 m); mirrored says the map is a mirror image of ours.
function align(line, race) {
  const M = 800, a = even(line, M);
  // Both loops are measured from their own middle, so that turning one about its middle is all that is left to find.
  const centred = c => { const m = [0, 1].map(d => c.reduce((t, p) => t + p[d], 0) / M); return c.map(p => [p[0] - m[0], p[1] - m[1]]); };
  const ca = centred(a);
  let best = { err: Infinity };
  // The map may run the other way round or be a mirror image: try all four and keep the closest.
  for (const mirror of [1, -1]) for (const back of [false, true]) {
    const flip = p => [p[0], p[1] * mirror], b = even(race.map(flip), M);
    if (back) b.reverse();
    // Start by pairing point i of ours with point i + shift of the map, for the shift that lets the two be
    // brought closest together (the one whose pairs agree most once the map is turned)...
    const cb = centred(b);
    let shift = 0, top = -Infinity;
    for (let j = 0; j < M; j++) {
      let dot = 0, cross = 0;
      for (let i = 0; i < M; i++) { const p = cb[(i + j) % M], q = ca[i]; dot += p[0] * q[0] + p[1] * q[1]; cross += p[0] * q[1] - p[1] * q[0]; }
      if (Math.hypot(dot, cross) > top) { top = Math.hypot(dot, cross); shift = j; }
    }
    let pairs = a.map((q, i) => [b[(i + shift) % M], q]), turn, err;
    // ...then turn and slide the map (never stretch it: 1 m is 10 units) to bring the pairs together, and
    // re-pair each of our points with the nearest map point, four times over.
    for (let round = 0; round < 4; round++) {
      const mean = j => [0, 1].map(d => pairs.reduce((t, pq) => t + pq[j][d], 0) / M), [mp, mq] = [mean(0), mean(1)];
      let dot = 0, cross = 0;
      for (const [p, q] of pairs) { const px = p[0] - mp[0], py = p[1] - mp[1], qx = q[0] - mq[0], qy = q[1] - mq[1]; dot += px * qx + py * qy; cross += px * qy - py * qx; }
      const th = Math.atan2(cross, dot), cos = 10 * Math.cos(th), sin = 10 * Math.sin(th);
      turn = p => [mq[0] + cos * (p[0] - mp[0]) - sin * (p[1] - mp[1]), mq[1] + sin * (p[0] - mp[0]) + cos * (p[1] - mp[1])];
      const moved = b.map(turn);
      pairs = a.map(q => [b[nearest(moved, q)], q]);
      err = Math.sqrt(pairs.reduce((t, [p, q]) => t + (turn(p)[0] - q[0]) ** 2 + (turn(p)[1] - q[1]) ** 2, 0) / M);
    }
    if (err < best.err) best = { move: p => turn(flip(p)), err, mirrored: mirror < 0 };
  }
  return best;
}

// Replaces the estimated edges of s's track with surveyed ones, if there is a map of the circuit that fits.
// Two surveys of one circuit disagree by a few metres, too much to lay the map's edges straight onto our
// coordinates (cars would be drawn off the tarmac). So only the room is taken from the map: how far its racing
// line is from its left and right edge at each point round the lap, applied to our line at the same point.
async function survey(s) {
  const file = MAPS[s.circuit], track = s.track;
  if (!file) return;
  try {
    const [centre, race] = await Promise.all(['tracks', 'racelines'].map(dir => csv(`${MAP_URL}${dir}/${file}.csv`)));
    const c = stations(track), { move, err, mirrored } = align(c, race);
    if (err > MAX_MISFIT) return console.warn(`${file}: the surveyed map is ${(err / 10).toFixed(1)} m off the racing line, so the edges are estimated`);
    if (s.track !== track) return;
    const th = heading(centre); // each row of centre: x, y, width to the right, width to the left
    const room = race.map(p => {
      const j = nearest(centre, p), m = centre[j];
      const off = (p[1] - m[1]) * Math.cos(th[j]) - (p[0] - m[0]) * Math.sin(th[j]); // how far the racing line is left of the centre line
      return [m[3] - off, m[2] + off].map(w => Math.max(10, w * 10)); // [left, right]; at least 1 m, half a car
    });
    const moved = race.map(move), k = c.map(q => nearest(moved, q)), thc = heading(c), thm = heading(moved), est = rooms(c);
    // The map's left is our right if it is a mirror image or runs the other way round (but not both).
    const swap = mirrored === k.reduce((t, j, i) => t + Math.cos(thc[i] - thm[j]), 0) > 0;
    const pick = side => c.map((q, i) => Math.hypot(moved[k[i]][0] - q[0], moved[k[i]][1] - q[1]) < NEAR ? room[k[i]][swap ? 1 - side : side] : est[side][i]);
    s.road = { of: track, surveyed: true, edges: band(c, pick(0), pick(1)) };
  } catch (e) {
    console.warn(`No surveyed map (${e.message}), so the edges are estimated`);
  }
}

// ---- live car positions, estimated ----
// The free feed has no car positions, but it says when each car finishes each mini-sector (about
// 25 per lap). A reference lap from an earlier session at the same circuit says where a car is at
// every moment of a lap. Together they place each car on the racing line, moving at a real lap's speed.

// Where the reference car was after the given share of its lap time.
function traceXY({ pts, lap }, share) {
  const c = (share % 1) * lap;
  const i = Math.max(idx(pts, c), 0), a = pts[i], b = pts[i + 1] ?? pts[0]; // after the last point comes the first
  const span = (pts[i + 1] ? b.t : lap) - a.t;
  const f = span > 0 ? Math.min(Math.max((c - a.t) / span, 0), 1) : 0;
  return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
}

// Turns one car's mini-sector messages into steps {t, lap, k}: at time t it finished mini-sector k of that lap.
// base: index of each sector's first mini-sector; K: mini-sectors per lap.
function progress(raw, base, K) {
  const out = [];
  let lap = 0, last = -1;
  for (const e of raw) {
    const k = base[e.i] + e.j;
    if (!(k < K)) continue;
    if (k <= last) {
      if (last - k < K / 2) continue; // the same mini-sector reported again
      lap++;                          // a big step back is the start of a new lap
    }
    last = k;
    if (out.length && e.t <= out.at(-1).t) Object.assign(out.at(-1), { lap, k }); // two in one message: keep the later one
    else out.push({ t: e.t, lap, k });
  }
  return out;
}

// F[k]: the share of a lap's time that has passed when mini-sector k ends. It starts as a guess
// and is replaced, per mini-sector, by the average over the clean laps recorded so far.
function calibrate(prog, K, guess) {
  const laps = [];
  for (const ev of Object.values(prog)) {
    let from = -1;
    ev.forEach((e, i) => {
      if (e.k !== K - 1) return; // the last mini-sector ends on the finish line
      if (from >= 0 && e.lap === ev[from].lap + 1) laps.push(ev.slice(from, i + 1));
      from = i;
    });
  }
  const dur = l => l.at(-1).t - l[0].t;
  const best = Math.min(...laps.map(dur));
  const sum = Array(K).fill(0), n = Array(K).fill(0);
  for (const l of laps) {
    if (dur(l) > best * 1.07) continue; // pit stops, safety car, traffic
    for (const e of l.slice(1)) { sum[e.k] += (e.t - l[0].t) / dur(l); n[e.k]++; }
  }
  const F = guess.map((g, k) => n[k] >= 3 ? sum[k] / n[k] : g);
  for (let k = 0; k < K; k++) F[k] = Math.min(Math.max(F[k], (F[k - 1] ?? 0) + 1e-4), 1 - (K - 1 - k) * 1e-4); // strictly rising, ending at 1
  return F;
}

// Laps completed by car n at time t, as a decimal (12.25 = a quarter of the way round lap 13).
function liveP(n, t) {
  const ev = S.prog[n], F = S.F;
  if (!ev || !F.length || !S.ref) return;
  const i = idx(ev, t);
  if (i < 0) return;
  const P = e => e.lap + F[e.k];
  const a = ev[i], b = ev[i + 1];
  if (b) return P(a) + (P(b) - P(a)) * (t - a.t) / (b.t - a.t); // between two known moments
  // Past the newest data: predict. The car carries on at its pace over the last three mini-sectors,
  // but no further than two mini-sectors ahead, in case it has slowed or stopped.
  const j = Math.max(i - 3, 0);
  const pace = i > j ? (P(a) - P(ev[j])) / (a.t - ev[j].t) : 1 / S.ref.lap;
  const guess = u => Math.min(P(a) + (u - a.t) * pace, P(a) + 2 / F.length);
  // When new data shows the car was drawn in the wrong place, it never jumps or drives backwards:
  // drawn too far ahead, it waits there until the prediction catches up; drawn too far back, the
  // shortfall fades out over a few seconds.
  const fix = S.fix[n];
  if (!fix || t < fix.t) return guess(t);
  const off = fix.P - guess(fix.t);
  return off > 0 ? Math.max(fix.P, guess(t)) : guess(t) + off * Math.exp((fix.t - t) / 2000);
}

// ---- drawing ----

// Drivers in race order at time t.
function order(t) {
  return Object.keys(S.drivers)
    .map(n => ({ n, p: (at(S.pos[n], t) ?? S.pos[n]?.[0])?.p ?? 99 }))
    .sort((a, b) => a.p - b.p);
}

// Sizes a canvas for the screen and clears it.
function fit(c) {
  const g = c.getContext('2d'), r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  return [g, w, h];
}

const FONT = 'Bahnschrift, "DIN Alternate", "Roboto Condensed", system-ui, sans-serif'; // as the page
const PAD = 28, TOP = 72, BOTTOM = 84; // the lap counter floats over the top of the map, the playback bar sits along the bottom
function draw() {
  const [g, w, h] = fit($('map'));
  g.fillStyle = '#8e8e8e';
  g.font = `13px ${FONT}`;
  const note = text => { g.textAlign = 'right'; g.fillText(text, w - 20, h - 70); g.textAlign = 'left'; }; // above the playback bar, on the right: the loading line has the left
  if (!S.track) return note('No reference lap for this circuit yet, so there is no live map.');

  // An overtake close-up follows the two cars; otherwise the whole track is shown.
  const duo = S.focus ? [S.focus.a, S.focus.b] : [];
  const [p, q] = duo.map(n => carXY(n, S.t));
  const zoom = p && q;
  const R = zoom ? Math.max(1200, 0.7 * Math.hypot(p[0] - q[0], p[1] - q[1])) : 0; // half the close-up's width: 120 m, more if the cars are far apart
  const { x0, x1, y0, y1 } = zoom ? { x0: (p[0] + q[0]) / 2 - R, x1: (p[0] + q[0]) / 2 + R, y0: (p[1] + q[1]) / 2 - R, y1: (p[1] + q[1]) / 2 + R } : S.box;
  const v = zoom ? { z: 1, x: 0, y: 0 } : view; // a close-up ignores the user's own zoom
  const k = v.z * Math.min((w - 2 * PAD) / (x1 - x0), (h - TOP - BOTTOM) / (y1 - y0));
  const X = x => w / 2 + (x - (x0 + x1) / 2) * k + v.x;
  const Y = y => (h + TOP - BOTTOM) / 2 - (y - (y0 + y1) / 2) * k + v.y; // track y points up, canvas y points down

  // The track surface between its two estimated edges, then the racing line on it.
  if (S.road?.of !== S.track) { S.road = road(S.track); survey(S); } // estimated now, surveyed a moment later if there is a map
  const [l, r] = S.road.edges;
  g.beginPath();
  for (const e of l) g.lineTo(X(e[0]), Y(e[1]));
  g.lineTo(X(l[0][0]), Y(l[0][1])); g.lineTo(X(r[0][0]), Y(r[0][1]));
  for (const e of r.toReversed()) g.lineTo(X(e[0]), Y(e[1]));
  g.closePath();
  g.lineJoin = 'round'; g.lineWidth = 2; g.fillStyle = g.strokeStyle = '#2e2e2e'; g.fill(); g.stroke();
  g.beginPath();
  for (const pt of S.track) g.lineTo(X(pt.x), Y(pt.y));
  g.closePath();
  g.lineWidth = zoom ? 2 : 1; g.strokeStyle = 'rgba(255, 255, 255, .55)'; g.stroke();

  g.font = `600 12px ${FONT}`;
  if (opt.sectors) (S.marks ?? []).forEach((j, i) => { // a line across the track where each sector starts
    const a = S.track.at(j - 2), b = S.track[(j + 2) % S.track.length], x = X(S.track[j].x), y = Y(S.track[j].y);
    const dx = X(b.x) - X(a.x), dy = Y(b.y) - Y(a.y), d = Math.hypot(dx, dy) || 1, px = -dy / d, py = dx / d;
    g.beginPath(); g.moveTo(x - 10 * px, y - 10 * py); g.lineTo(x + 10 * px, y + 10 * py);
    g.lineWidth = 2; g.strokeStyle = g.fillStyle = '#fff'; g.stroke();
    g.textAlign = 'center'; g.fillText(`S${i + 1}`, x + 22 * px, y + 22 * py); g.textAlign = 'left';
  });
  g.fillStyle = '#8e8e8e';
  g.font = `13px ${FONT}`;

  if (S.live) note('Estimated positions (from mini-sector times)');
  else if (!S.loc[Math.floor((S.t - S.t0) / CHUNK)]) return note('Loading car positions…');

  for (const n of duo) { // the path each of the two cars took over the last 5 seconds
    g.beginPath();
    for (let u = S.t - 5000; u <= S.t; u += 200) { const xy = carXY(n, u); if (xy) g.lineTo(X(xy[0]), Y(xy[1])); }
    g.lineWidth = 3; g.strokeStyle = `#${S.drivers[n]?.team_colour || '999'}`; g.stroke();
  }
  g.font = `600 12px ${FONT}`;
  for (const { n } of order(S.t).reverse()) { // leader drawn last, on top
    const xy = carXY(n, S.t);
    if (!xy || gone(n, S.t)) continue;
    const d = S.drivers[n], x = X(xy[0]), y = Y(xy[1]);
    g.beginPath(); g.arc(x, y, 6, 0, 2 * Math.PI);
    g.fillStyle = `#${d.team_colour || '999'}`; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
    if (opt.names) { g.fillStyle = '#fff'; g.fillText(d.name_acronym, x + 9, y); }
  }
}

const clock = t => {
  const s = Math.round(Math.abs(t - S.start) / 1000);
  return `${t < S.start ? '-' : ''}${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtGap = g => typeof g === 'number' ? (g ? `+${g.toFixed(3)}` : '') : esc(g);
const tyreTag = c => `<span class="tyre" style="color:${TYRE[c] ?? '#999'}" title="${esc(c)}">${esc((c ?? '?')[0])}</span>`;

// Everything so far, newest first. Rebuilt only when its length changes, so buttons in it stay clickable.
function list(id, items, html) {
  if (S.shown[id] === items.length) return;
  S.shown[id] = items.length;
  $(id).innerHTML = items.toReversed().map(html).join('');
}

// Tyre wear for each stint of driver n: how much slower each lap gets, with the fuel effect taken out.
function wear(n, t) {
  const laps = S.laps[n] ?? [], stints = (S.stints[n] ?? []).filter(Boolean);
  return stints.map((st, i) => {
    const end = stints[i + 1]?.lap_start ?? Infinity; // the lap before `end` is the in-lap
    const pts = [];
    for (let j = 0; j + 1 < laps.length && laps[j + 1].t <= t; j++) {
      const l = laps[j];
      // A lap's time is the gap to the next lap's start. Lap 1, the out-lap and the in-lap are left out.
      if (l.n > 1 && l.n > st.lap_start && l.n < end - 1 && laps[j + 1].n === l.n + 1)
        pts.push({ x: st.tyre_age_at_start + l.n - st.lap_start, y: (laps[j + 1].t - l.t) / 1000 });
    }
    const typical = median(pts.map(pt => pt.y));
    const clean = pts.filter(pt => pt.y < typical * 1.05); // safety car and traffic laps out
    if (clean.length < 4) return { st, laps: clean.length };
    const mx = clean.reduce((s, pt) => s + pt.x, 0) / clean.length, my = clean.reduce((s, pt) => s + pt.y, 0) / clean.length;
    const slope = clean.reduce((s, pt) => s + (pt.x - mx) * (pt.y - my), 0) / clean.reduce((s, pt) => s + (pt.x - mx) ** 2, 0);
    return { st, laps: clean.length, wear: slope + FUEL };
  }).filter(r => r.st.lap_start <= (at(laps, t)?.n ?? 1));
}

const lapTime = s => `${Math.floor((s = Math.round(s * 1000) / 1000) / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;

// Seconds driver n took for each lap finished by time t, by lap number.
// shortcut: live laps are timed by when the feed reported them (a few tenths out); read LastLapTime in ingest() for official times.
function lapTimes(n, t) {
  const rows = S.laps[n] ?? [], out = new Map();
  for (let i = 0; i + 1 < rows.length && rows[i + 1].t <= t; i++)
    if (rows[i + 1].n === rows[i].n + 1) out.set(rows[i].n, rows[i].d ?? (rows[i + 1].t - rows[i].t) / 1000);
  return out;
}

// Two drivers' last five laps side by side, as on the TV broadcast: on each lap the slower driver
// shows the lap time and the faster one shows only how much quicker they were.
function renderCompare(t, ord) {
  if (S.shown.cmp !== ord.length) { // fill the driver pickers; keep a choice that still exists
    S.shown.cmp = ord.length;
    [['cmpA', ord[0].n], ['cmpB', (ord[1] ?? ord[0]).n], ['otWho', '']].forEach(([id, def]) => {
      const el = $(id), keep = el.value;
      el.innerHTML = (id === 'otWho' ? '<option value="">All drivers</option>' : '') + ord.map(o => `<option value="${esc(o.n)}">${esc(name(o.n))}</option>`).join('');
      el.value = S.drivers[keep] ? keep : def;
    });
  }
  const a = $('cmpA').value, b = $('cmpB').value, A = lapTimes(a, t), B = lapTimes(b, t);
  const ns = a === b ? [] : [...A.keys()].filter(n => B.has(n)).slice(-5);
  $('cmpText').textContent = a === b ? 'Pick two different drivers.' : ns.length ? '' : 'No laps to compare yet.';
  const row = (n, X, Y) => `<tr><td><span class="bar" style="background:#${esc(S.drivers[n].team_colour || '999')}"></span>${esc(name(n))}</td>` +
    ns.map(i => X.get(i) < Y.get(i) ? `<td class="n fast">${(X.get(i) - Y.get(i)).toFixed(3)}</td>` : `<td class="n">${lapTime(X.get(i))}</td>`).join('') + '</tr>';
  $('laps').innerHTML = ns.length ? `<tr><th></th>${ns.map(i => `<th class="n">Lap ${i}</th>`).join('')}</tr>${row(a, A, B)}${row(b, B, A)}` : '';

  $('wear').innerHTML = [...new Set([a, b])].flatMap(n => wear(n, t).map(r =>
    `<tr><td>${esc(name(n))}</td><td>${tyreTag(r.st.compound)}</td><td>from lap ${esc(r.st.lap_start)}</td><td class="n">${r.laps} laps</td>` +
    `<td class="n">${r.wear === undefined ? 'too few laps' : `${r.wear >= 0 ? '+' : ''}${r.wear.toFixed(2)} s/lap`}</td></tr>`)).join('');
}

function render() {
  const t = S.t, ord = order(t), racing = t >= S.start;
  if (!ord.length) return;
  const lapOf = n => at(S.laps[n], t)?.n ?? 0;

  $('clock').textContent = clock(t);
  $('lap').textContent = racing ? `Lap ${lapOf(ord[0].n) || 1} / ${S.totalLaps}` : 'Before the start';

  // Track status and yellow sectors, replayed from the race control messages so far.
  let flag = 'GREEN', sc = '', yellow = new Set();
  const seen = S.rc.slice(0, idx(S.rc, t) + 1);
  for (const m of seen) {
    if (m.category === 'SafetyCar') sc = /VIRTUAL/.test(m.message) ? 'VSC' : 'SAFETY CAR';
    if (m.category !== 'Flag') continue;
    if (m.scope === 'Sector') { if (m.flag === 'CLEAR') yellow.delete(m.sector); else yellow.add(m.sector); }
    if (m.scope === 'Track') {
      flag = m.flag === 'CLEAR' ? 'GREEN' : m.flag;
      if (flag === 'GREEN') { sc = ''; yellow.clear(); }
    }
  }
  const cls = flag === 'RED' ? 'red' : flag === 'CHEQUERED' ? 'end' : sc ? 'sc' : flag === 'GREEN' ? '' : 'yellow';
  $('flag').innerHTML = `<span class="chip ${cls}">${esc(flag === 'GREEN' && sc ? sc : flag)}</span>`;
  $('yellows').innerHTML = [...yellow].sort((a, b) => a - b).map(s => `<span class="chip yellow">Yellow: sector ${esc(s)}</span>`).join(' ');

  list('rc', seen, m => `<li><time>${clock(m.t)}</time>${esc(m.message)}</li>`);
  list('radio', S.radio.slice(0, idx(S.radio, t) + 1).filter(m => /^https:\/\//.test(m.recording_url)), m =>
    `<li style="--team:#${esc(S.drivers[m.driver_number]?.team_colour || '999')}"><button class="pp" data-url="${esc(m.recording_url)}"></button>` +
    `<time>${clock(m.t)}</time><b>${esc(name(m.driver_number))}</b><span class="len"></span><div class="prog"><i></i></div><p class="said">${esc(hear(m.recording_url, m.t))}</p></li>`);
  showClip();
  const who = $('otWho').value;
  list('ot', (S.overtakes ?? []).slice(0, idx(S.overtakes ?? [], t) + 1)
    .filter(o => o.position <= otTop && (!who || o.overtaking_driver_number == who || o.overtaken_driver_number == who)), o =>
    `<li class="${o.position <= 3 ? 'key' : ''}"><button data-ot="${o.i}">Watch</button><time>${clock(o.t)}</time>${esc(name(o.overtaking_driver_number))} ` +
    (o.position === 1 ? `took the lead from ${esc(name(o.overtaken_driver_number))}` : `passed ${esc(name(o.overtaken_driver_number))} for P${esc(o.position)}`) + '</li>');

  // Timing tower.
  const gaps = {};
  for (const { n } of ord) {
    const i = at(S.intv[n], t);
    gaps[n] = i && t - i.t < STALE ? i : null;
  }
  const num = n => typeof gaps[n]?.gap === 'number' ? gaps[n].gap : Infinity;
  // Each driver keeps one row, which is moved rather than rebuilt, so a change of position is seen as a move.
  const rows = S.rows ??= {};
  for (const { n, p } of ord) {
    const d = S.drivers[n], lap = lapOf(n) || 1;
    const st = S.stints[n]?.filter(x => x.lap_start <= lap).pop();
    const tyre = st ? `${tyreTag(st.compound)} ${st.tyre_age_at_start + lap - st.lap_start}` : '';
    const stops = idx(S.pits[n] ?? [], t) + 1;
    const after = racing && S.pitLoss && num(n) < Infinity
      ? `P${rejoin(num(n), S.pitLoss, ord.filter(o => o.n !== n).map(o => num(o.n)))}` : '';
    const dnf = gone(n, t) && (S.out[n].dns ? 'DNS' : 'DNF');
    (rows[n] ??= document.createElement('tr')).className = dnf ? 'out' : '';
    rows[n].dataset.n = n; // map3d.js follows the car whose row is clicked
    rows[n].innerHTML = dnf ? `<td></td><td><span class="bar" style="background:#${esc(d.team_colour || '999')}"></span>${esc(d.name_acronym)}</td><td class="n">${dnf}</td><td colspan="4"></td>` : `<td>${p === 99 ? '' : p}</td><td><span class="bar" style="background:#${esc(d.team_colour || '999')}"></span>${esc(d.name_acronym)}</td>` +
      `<td class="n">${fmtGap(gaps[n]?.gap)}</td><td class="n">${fmtGap(gaps[n]?.int)}</td><td>${tyre}</td><td class="n">${stops || ''}</td><td class="n">${after}</td>`;
  }
  const key = ord.map(o => o.n).join();
  if (key !== S.shown.tower) {
    S.shown.tower = key;
    // Where each row is on screen right now, mid-move or not: the slide to its new place starts from there.
    // No slide after a jump on the slider (more than 30 s of race since the last look): the whole order is new then.
    const was = Math.abs(t - S.shown.at) > 30e3 || matchMedia('(prefers-reduced-motion: reduce)').matches ? [] : ord.filter(o => rows[o.n].isConnected).map(o => [rows[o.n], rows[o.n].getBoundingClientRect().top]);
    for (const [tr] of was) tr.getAnimations().forEach(a => a.cancel());
    $('tower').replaceChildren(...ord.map(o => rows[o.n]));
    for (const [tr, y] of was) {
      const dy = y - tr.getBoundingClientRect().top;
      if (dy) tr.animate({ transform: [`translateY(${dy}px)`, 'none'] }, { duration: 450, easing: 'cubic-bezier(.2, .9, .3, 1)' }); // settles without overshoot
    }
  }
  S.shown.at = t;

  renderCompare(t, ord);

  // Live standings: points before this session plus the points for the current position.
  if (S.champD.length) {
    const racePts = Object.fromEntries(ord.map(({ n, p }) => [n, racing ? S.pts?.[p - 1] ?? 0 : 0]));
    const rows = (table, label, extra) => table.map(r => ({ label: label(r), pts: (r.points_start ?? 0) + extra(r) }))
      .sort((a, b) => b.pts - a.pts)
      .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.label)}</td><td class="n">${r.pts}</td></tr>`).join('');
    $('champD').innerHTML = rows(S.champD, r => name(r.driver_number), r => racePts[r.driver_number] ?? 0);
    $('champT').innerHTML = rows(S.champT, r => r.team_name,
      r => ord.reduce((sum, { n }) => sum + (S.drivers[n].team_name === r.team_name ? racePts[n] : 0), 0));
  }
}

// ---- live ----
// server.mjs records F1's own feed as [topic, data, time] messages. The app turns them into the
// same rows a replay uses, so a live session is just a replay whose end keeps moving.

const utc = s => ms(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z'); // the feed often leaves the Z off
// Lists arrive whole as arrays, then as {index: change}; both walk the same way.
const each = (o, f) => Object.entries(o ?? {}).forEach(([k, v]) => { if (v && typeof v === 'object') f(k, v); });
const add = (map, n, row) => (map[n] ??= []).push(row);
const parseGap = g => /^\+?\d+(\.\d+)?$/.test(g) ? +g : /^LAP/.test(g) ? 0 : g; // the leader's gap reads "LAP 12"

function ingest(s, [topic, d, time]) {
  const when = utc(time);
  if (!(when > 0) || !d) return;
  const t = s.t1 = Math.max(when, s.t1 ?? 0); // never backwards: the rows must stay sorted
  s.t0 ??= t;
  if (topic === 'SessionInfo') {
    if (d.Key) s.key = d.Key;
    if (d.Path) s.path = d.Path;
    if (d.Meeting?.Circuit?.ShortName) s.circuit = d.Meeting.Circuit.ShortName;
    if (d.Name) { s.title = `${d.Meeting?.Name ?? ''} ${d.Name}`; s.pts = { Race: PTS, Sprint: SPRINT_PTS }[d.Name]; }
  }
  if (topic === 'Ref') { // added by server.mjs: a reference lap of this circuit and the standings before this session
    s.champD = d.champD ?? []; s.champT = d.champT ?? [];
    if (d.track) {
      s.ref = d.track; s.track = d.track.pts; s.box = box(s.track);
      s.marks = [0, d.track.s1, d.track.s1 + d.track.s2].map(u => Math.max(0, s.track.findIndex(p => p.t >= u)));
    }
  }
  if (topic === 'SessionData') each(d.StatusSeries, (_, v) => { if (v.SessionStatus === 'Started' && v.Utc) s.started ??= utc(v.Utc); });
  if (topic === 'LapCount' && d.TotalLaps) s.totalLaps = d.TotalLaps;
  if (topic === 'DriverList') each(d, (n, v) => {
    const x = s.drivers[n] ??= { driver_number: +n, name_acronym: n };
    if (v.Tla) x.name_acronym = v.Tla;
    if (v.TeamName) x.team_name = v.TeamName;
    if (v.TeamColour) x.team_colour = v.TeamColour;
  });
  if (topic === 'TimingData') each(d.Lines, (n, v) => {
    if (v.Position) add(s.pos, n, { t, p: +v.Position });
    const gap = v.GapToLeader, int = v.IntervalToPositionAhead?.Value;
    if (gap !== undefined || int !== undefined) {
      const prev = s.intv[n]?.at(-1);
      add(s.intv, n, { t, gap: gap !== undefined ? parseGap(gap) : prev?.gap, int: int !== undefined ? parseGap(int) : prev?.int });
    }
    if (v.NumberOfLaps >= (s.laps[n]?.at(-1)?.n ?? 0)) add(s.laps, n, { t, n: v.NumberOfLaps + 1 });
    for (let k = s.pits[n]?.length ?? 0; k < v.NumberOfPitStops; k++) add(s.pits, n, { t });
    if (v.Retired) s.out[n] ??= { due: t };
    // Mini-sectors: a status that is not 0 means the car has just finished that one.
    each(v.Sectors, (i, sec) => {
      if (Array.isArray(sec.Segments)) return void (s.segs[i] = Math.max(s.segs[i] ?? 0, sec.Segments.length)); // the full state only tells how many there are
      each(sec.Segments, (j, seg) => {
        if (!seg.Status) return;
        add(s.seg, n, { t, i: +i, j: +j });
        s.segs[i] = Math.max(s.segs[i] ?? 0, +j + 1);
      });
    });
  });
  // shortcut: a stint is dated by the lap its first message arrives on, so tyre age can be one lap off around a stop.
  if (topic === 'TimingAppData') each(d.Lines, (n, v) => each(v.Stints, (i, st) => {
    const row = (s.stints[n] ??= [])[i] ??= { lap_start: s.laps[n]?.at(-1)?.n ?? 1, tyre_age_at_start: +(st.TotalLaps ?? st.StartLaps ?? 0) };
    if (st.Compound) row.compound = st.Compound;
  }));
  if (topic === 'RaceControlMessages') each(d.Messages, (i, m) => {
    s.rcAll[i] = { t: utc(m.Utc), category: m.Category, flag: m.Flag, scope: m.Scope, sector: m.Sector, message: m.Message };
  });
  if (topic === 'TeamRadio') each(d.Captures, (i, c) => { s.radioAll[i] = { t: utc(c.Utc), driver_number: c.RacingNumber, path: c.Path }; });
  if (topic === 'PitLaneTimeCollection') each(d.PitTimes, (n, v) => { if (+v.Duration > 0) s.lane[`${n}:${v.Lap}`] = +v.Duration; });
}

// Rebuilds what is derived from the messages so far.
function settle(s) {
  s.start = s.started ?? s.t0;
  s.rc = Object.values(s.rcAll).sort(byTime);
  s.radio = Object.values(s.radioAll).sort(byTime)
    .map(m => ({ ...m, recording_url: `https://livetiming.formula1.com/static/${s.path}${m.path}` }));
  const lane = Object.values(s.lane).filter(d => d < 90);
  s.pitLoss = lane.length ? median(lane) : null;

  const c = s.segs;
  if (!s.ref || !(c[0] && c[1] && c[2])) return;
  const base = [0, c[0], c[0] + c[1]], K = c[0] + c[1] + c[2];
  // First guess: the reference lap's three sector times, each sector split evenly.
  const ends = [0, s.ref.s1 / s.ref.lap, (s.ref.s1 + s.ref.s2) / s.ref.lap, 1], guess = [];
  for (let i = 0; i < 3; i++) for (let j = 1; j <= c[i]; j++) guess.push(ends[i] + (ends[i + 1] - ends[i]) * j / c[i]);
  s.prog = Object.fromEntries(Object.entries(s.seg).map(([n, raw]) => [n, progress(raw, base, K)]));
  s.F = calibrate(s.prog, K, guess);
}

// The time "now" in a live session: it follows the clock between messages, at most 10 s past the last one.
const edge = () => S.live ? Math.min(Date.now() + S.skew, S.t1 + 10e3) : S.t1;

async function loadLive() {
  ++loadId; // drops a race that is still loading
  setPlaying(false);
  const s = S = { live: true, next: 0, drivers: {}, laps: {}, pos: {}, intv: {}, stints: {}, pits: {}, rcAll: {}, radioAll: {}, lane: {},
    seg: {}, segs: [], prog: {}, F: [], fix: {}, out: {}, skew: -Infinity,
    rc: [], radio: [], overtakes: [], champD: [], champT: [], totalLaps: '?', shown: {} };
  blank();
  $('loading').hidden = true;
  say('Connecting to the live recording…');
  while (S === s) {
    try {
      const r = await fetch(`live?since=${s.next}`);
      if (!r.ok) throw new Error(`The live server answered ${r.status}`);
      const { key, next, lines } = await r.json();
      if (S !== s) return;
      if (s.next && (key !== s.key || next < s.next)) return loadLive(); // a new session, or the server restarted
      // Remember where each car is drawn right now, so new data corrects it smoothly.
      if (lines.length && s.t !== undefined) for (const n in s.prog) { const P = liveP(n, s.t); if (P !== undefined) s.fix[n] = { t: s.t, P }; }
      lines.forEach(l => ingest(s, l));
      s.next = next;
      if (s.t1 === undefined) say('No live session is being recorded right now.');
      else {
        if (lines.length) { s.skew = Math.max(s.skew, s.t1 - Date.now()); settle(s); }
        showPitLoss();
        $('champ').hidden = !s.champD.length;
        $('seek').max = Math.round((s.t1 - s.t0) / 1000);
        if (s.t === undefined) { // first data: jump to the live edge and follow it
          s.t = edge();
          $('stage').classList.remove('empty');
          for (const id of ['timing', 'more', 'rcBox', 'radioBox']) $(id).hidden = false;
          setPlaying(true);
          say(`Live recording · ${s.title ?? ''} · drag the slider back to see what you missed`);
        }
      }
    } catch (e) {
      if (S === s) say(e.message);
    }
    await sleep(1000);
  }
}

// One panel at a time beside the map.
function tab(name) {
  for (const b of $('tabs').children) b.setAttribute('aria-pressed', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-p]')) p.classList.toggle('cur', p.dataset.p === name);
}
$('tabs').onclick = e => { if (e.target.dataset.tab) tab(e.target.dataset.tab); };

// A row of choices inside a panel: the pressed button's value is the choice.
function choice(nav, onPick) {
  nav.onclick = e => {
    if (e.target.parentNode !== nav) return;
    for (const b of nav.children) b.setAttribute('aria-pressed', b === e.target);
    onPick(e.target.value);
  };
}
let otTop = 99; // overtakes shown: for this position or better
const refilter = () => { if (S) S.shown.ot = -1; }; // the overtake list is rebuilt on the next render
choice($('otTop'), v => { otTop = +v; refilter(); });
$('otWho').onchange = refilter;
choice($('champNav'), v => { $('champD').parentNode.hidden = v !== 'D'; $('champT').parentNode.hidden = v !== 'T'; });

// A drop-down drawn by the page instead of the browser. The <select> stays, hidden, and still holds
// the value, so the rest of the code reads and sets it as before; show() copies its value to the button.
const menus = [...document.querySelectorAll('select')].map(sel => {
  const box = document.createElement('span'), btn = document.createElement('button'), pop = document.createElement('div');
  box.className = 'menu';
  sel.hidden = pop.hidden = true;
  sel.after(box);
  box.append(btn, pop);
  const close = () => { pop.hidden = true; btn.ariaExpanded = 'false'; };
  btn.onclick = () => {
    if (!pop.hidden) return close();
    pop.replaceChildren(...[...sel.options].map(o => {
      const b = document.createElement('button');
      b.textContent = o.text;
      b.setAttribute('aria-pressed', o.selected);
      b.onclick = () => { sel.value = o.value; sel.dispatchEvent(new Event('change')); close(); btn.focus(); };
      return b;
    }));
    pop.hidden = false;
    btn.ariaExpanded = 'true';
    pop.querySelector('[aria-pressed=true]')?.focus();
  };
  box.onkeydown = e => {
    if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); }
    const to = { ArrowDown: 'nextSibling', ArrowUp: 'previousSibling' }[e.key];
    if (to && e.target.parentNode === pop) { e.target[to]?.focus(); e.preventDefault(); }
  };
  const show = () => {
    const text = sel.selectedOptions[0]?.text ?? '';
    if (btn.textContent !== text) { btn.textContent = text; btn.ariaLabel = `${sel.ariaLabel}: ${text}`; }
  };
  show();
  return { box, close, show };
});
for (const ev of ['pointerdown', 'focusin']) document.addEventListener(ev, e => { for (const m of menus) if (!m.box.contains(e.target)) m.close(); });

// ---- map view: zoom, pan, and what is drawn on it ----
const view = { z: 1, x: 0, y: 0 }; // z: 1 shows the whole track; x, y: how far it is dragged, in pixels
const opt = { sectors: false, names: true, three: false, ...JSON.parse(localStorage.mapOpt ?? '{}') };
// The view at zoom z2 that keeps the point m (pixels from the middle of the map) where it is.
const zoomAt = (v, m, z2) => ({ z: z2, x: m[0] - (m[0] - v.x) * z2 / v.z, y: m[1] - (m[1] - v.y) * z2 / v.z });
function setView(v) {
  const c = $('map'), z = v.z, lim = (z - 1) / 2; // the track cannot be dragged out of sight
  Object.assign(view, { z, x: Math.max(-lim * c.clientWidth, Math.min(lim * c.clientWidth, v.x)), y: Math.max(-lim * c.clientHeight, Math.min(lim * c.clientHeight, v.y)) });
  c.style.touchAction = z > 1 ? 'none' : ''; // zoomed in, a finger drags the map; zoomed out, it scrolls the page
  c.style.cursor = z > 1 ? 'grab' : '';
  $('zout').disabled = $('zfit').disabled = z === 1;
  $('zin').disabled = z === 16;
}
const zoomBy = (f, m = [0, 0]) => setView(zoomAt(view, m, Math.max(1, Math.min(16, view.z * f))));
$('zin').onclick = () => zoomBy(1.6);
$('zout').onclick = () => zoomBy(1 / 1.6);
$('zfit').onclick = () => setView({ z: 1, x: 0, y: 0 });
$('map').addEventListener('wheel', e => {
  if (!S?.track) return;
  const c = e.target;
  zoomBy(Math.exp(-e.deltaY / 400), [e.offsetX - c.clientWidth / 2, e.offsetY - (c.clientHeight + TOP - BOTTOM) / 2]);
  e.preventDefault(); // the wheel zooms the map instead of scrolling the page
}, { passive: false });
// shortcut: a finger drags the map but two fingers do not pinch it (the buttons zoom); add pinch if phones need it.
let drag = null;
$('map').onpointerdown = e => { if (view.z > 1) { e.target.setPointerCapture(e.pointerId); drag = [e.clientX - view.x, e.clientY - view.y]; } };
$('map').onpointermove = e => { if (drag) setView({ ...view, x: e.clientX - drag[0], y: e.clientY - drag[1] }); };
$('map').onpointerup = $('map').onpointercancel = () => { drag = null; };
for (const b of document.querySelectorAll('[data-opt]')) {
  b.setAttribute('aria-pressed', opt[b.dataset.opt]);
  b.onclick = () => { b.setAttribute('aria-pressed', opt[b.dataset.opt] = !opt[b.dataset.opt]); localStorage.mapOpt = JSON.stringify(opt); };
}

// ---- playback ----

function setPlaying(on) {
  playing = on;
  $('play').ariaLabel = on ? 'Pause' : 'Play';
  $('play').classList.toggle('on', on); // the icon is drawn in CSS
}

let last = 0, lastPanel = 0;
function frame(now) {
  requestAnimationFrame(frame);
  for (const m of menus) m.show(); // a value set by the code shows at once
  const dt = Math.min(now - last, 100); // a background tab must not jump the race ahead
  last = now;
  if (!S || S.t === undefined) return;
  if (playing) {
    S.t = Math.min(S.t + dt * $('speed').value, edge());
    $('seek').value = Math.round((S.t - S.t0) / 1000);
    if (S.t >= S.t1 && !S.live) setPlaying(false); // a live session keeps growing
  }
  const i = Math.floor((S.t - S.t0) / CHUNK);
  chunk(i);
  if (playing) chunk(i + 1);
  if (S.focus && (S.t < S.focus.from || S.t > S.focus.until)) { $('speed').value = S.focus.speed; S.focus = null; } // an overtake close-up is over, on either map
  const three = !!(opt.three && window.draw3d); // map3d.js sets draw3d only if WebGL and three.js loaded
  if (!three && $('map').hidden) setView(view); // back from 3D: the zoom buttons are the flat map's again
  $('map').hidden = three; $('map3d').hidden = !three;
  if (three) draw3d(); else draw();
  if (now - lastPanel > 250) { lastPanel = now; render(); }
}

$('play').onclick = () => { if (S) setPlaying(!playing); };
$('seek').oninput = e => { if (S) S.t = S.t0 + e.target.value * 1000; };
$('live').onclick = loadLive;
// The races scroll sideways with the mouse wheel anywhere on the header (there is no scroll bar).
document.querySelector('header').addEventListener('wheel', e => {
  if (!e.deltaY || e.ctrlKey) return; // sideways swipes already scroll it; ctrl+wheel is zoom
  $('races').scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

// ---- team radio ----
// A radio row is its own player: its button plays and pauses, and a line along the row shows how far the clip is.
const audio = $('audio'), secs = v => `0:${String(Math.floor(v)).padStart(2, '0')}`;
let clipUrl = null;
$('radio').onclick = e => {
  const url = e.target.dataset?.url;
  if (!url) return;
  if (url !== clipUrl) { clipUrl = url; audio.src = url; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause(); // a clip that cannot load shows as "unavailable"
};
// Puts the clip's state on its row. The row is looked up each time: the list is rebuilt as messages arrive.
function showClip() {
  for (const li of $('radio').children) {
    const b = li.firstChild, mine = b.dataset.url === clipUrl, on = mine && !audio.paused && !audio.ended;
    b.classList.toggle('on', on);
    b.ariaLabel = `${on ? 'Pause' : 'Play'} radio from ${li.querySelector('b').textContent}`;
    li.classList.toggle('on', mine && (on || audio.currentTime > 0));
    if (!mine) continue;
    li.querySelector('i').style.width = `${100 * audio.currentTime / (audio.duration || 1)}%`;
    li.querySelector('.len').textContent = audio.error ? 'unavailable' : audio.duration ? `${secs(audio.currentTime)} / ${secs(audio.duration)}` : '';
  }
}
for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'error']) audio.addEventListener(ev, showClip);

// ---- radio transcripts ----
// Nobody publishes what is said, so each clip is put through a speech model (Whisper, run in this browser by
// transformers.js, in a worker so the map keeps moving). F1's server does not let a web page read its audio,
// so the clip comes through server.mjs: without that server there are no transcripts. Results are kept in localStorage.
// shortcut: the small English model (77 MB, fetched once) gets words wrong on noisy radio; a bigger model or a hosted one is more accurate.
const HEAR = `import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
  const model = pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'q8' });
  model.then(() => postMessage({ ready: true }), e => postMessage({ error: String(e) }));
  onmessage = async e => {
    try { postMessage({ url: e.data.url, text: (await (await model)(e.data.audio)).text }); }
    catch (err) { postMessage({ url: e.data.url, error: String(err) }); }
  };`;
const said = {}, waiting = []; // said: clip address -> text ('' if it could not be made out); waiting: clips still to do
let served = false, ears = null, modelReady = false, hearing = null;

// The words of a clip, or a note while they are being worked out. t: when it was said (the newest clip goes first).
function hear(url, t) {
  if (said[url] === undefined) try { said[url] = localStorage.getItem(`said:${url}`) ?? undefined; } catch {} // storage can be blocked
  if (said[url] !== undefined) return said[url];
  if (!served) return '';
  if (hearing !== url && !waiting.some(w => w.url === url)) waiting.push({ url, t });
  if (!hearing) next();
  return hearing !== url ? '' : modelReady ? 'Transcribing…' : 'Getting the speech model (77 MB, first time only)…';
}
const redraw = () => { if (S) S.shown.radio = -1; }; // the radio list is rebuilt on the next render

async function next() {
  const job = waiting.sort((a, b) => a.t - b.t).pop();
  if (!job) return;
  hearing = job.url;
  redraw();
  try {
    if (!ears) {
      ears = new Worker(URL.createObjectURL(new Blob([HEAR], { type: 'text/javascript' })), { type: 'module' });
      ears.addEventListener('message', e => { if (e.data.ready) { modelReady = true; redraw(); } });
    }
    const r = await fetch(`radio?u=${encodeURIComponent(job.url)}`);
    if (!r.ok) throw new Error(`the clip answered ${r.status}`);
    // Decoding into a 16 kHz context re-samples the clip to what the model expects.
    const sound = (await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await r.arrayBuffer())).getChannelData(0);
    const text = await new Promise((done, fail) => {
      const on = e => {
        if (e.data.url !== job.url && !(e.data.error && !e.data.url)) return; // not this clip, and not the model failing to load
        ears.removeEventListener('message', on);
        e.data.error ? fail(new Error(e.data.error)) : done(e.data.text);
      };
      ears.addEventListener('message', on);
      ears.postMessage({ url: job.url, audio: sound }, [sound.buffer]);
    });
    said[job.url] = tidy(text);
    try { localStorage.setItem(`said:${job.url}`, said[job.url]); } catch {}
  } catch (e) {
    console.warn(`No transcript for ${job.url}: ${e.message}`);
    said[job.url] = ''; // not stored: it is tried again on the next visit
  }
  hearing = null;
  redraw();
  next();
}
// The model writes sounds as [BLANK_AUDIO], (engine revving) and the like, and a lone "you" for a clip with no
// speech in it: only real speech is kept.
const tidy = text => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(you)?[.!?]*$/i, '');

// Watch an overtake: jump to 10 s before it, zoom in on the two cars and play at half speed.
$('ot').onclick = e => {
  const o = S?.overtakes[e.target.dataset?.ot];
  if (!o) return;
  S.focus = { a: o.overtaking_driver_number, b: o.overtaken_driver_number, from: o.t - 10e3, until: o.t + 5e3, speed: S.focus?.speed ?? $('speed').value };
  S.t = S.focus.from;
  $('speed').value = '0.5';
  setPlaying(true);
  $('stage').scrollIntoView({ block: 'nearest' }); // whichever map is showing
};

// Self-checks of the logic that is easy to get wrong.
console.assert(idx([{ t: 1 }, { t: 5 }], 0) === -1 && idx([{ t: 1 }, { t: 5 }], 5) === 1 && idx([], 3) === -1, 'idx');
console.assert(keep('laps?session_key=9') && keep('sessions?year=2023&session_type=Race') && !keep(`sessions?year=${new Date().getFullYear()}`), 'keep');
{ // zooming in on a point leaves that point where it was on screen: screen = world * z + offset
  const v = { z: 2, x: 30, y: -10 }, m = [100, 50], n = zoomAt(v, m, 5), world = (m[0] - v.x) / v.z;
  console.assert(Math.abs(world * n.z + n.x - m[0]) < 1e-9 && Math.abs(zoomAt(n, m, 2).x - v.x) < 1e-9, 'zoomAt');
}
console.assert(lapTime(92.41) === '1:32.410' && lapTime(59.9996) === '1:00.000', 'lapTime');
{ // a circle of 100 m radius driven anticlockwise: the left edge is inside it, the right edge WIDTH further out
  const ring = Array.from({ length: 200 }, (_, i) => ({ x: 1000 * Math.cos(i * Math.PI / 100), y: 1000 * Math.sin(i * Math.PI / 100) }));
  const [l, r] = road(ring).edges, rad = p => Math.hypot(p[0], p[1]);
  console.assert(Math.abs(l.length - 126) < 3 && l.every((p, i) => rad(p) < 1000 && Math.abs(rad(r[i]) - rad(p) - WIDTH) < 1), 'road');
}
{ // a lopsided loop in metres, turned by 1 radian, moved and started elsewhere, must be found again
  const egg = Array.from({ length: 300 }, (_, i) => { const a = i * Math.PI / 150, r = 300 + 120 * Math.cos(a) + 60 * Math.sin(2 * a); return [r * Math.cos(a), r * Math.sin(a)]; });
  const ours = egg.map(([x, y]) => [5000 + 10 * (x * Math.cos(1) - y * Math.sin(1)), -2000 + 10 * (x * Math.sin(1) + y * Math.cos(1))]);
  const { move, err } = align([...ours.slice(100), ...ours.slice(0, 100)], egg), at0 = move(egg[0]);
  console.assert(err < 20 && Math.hypot(at0[0] - ours[0][0], at0[1] - ours[0][1]) < 20, 'fit');
}
console.assert(tidy(' [BLANK_AUDIO] Box, box. (engine) ') === 'Box, box.' && tidy(' you') === '' && tidy('You are P3.') === 'You are P3.', 'tidy');
{ // a car at a steady 1 unit/ms, sampled unevenly, stays exactly on time once smoothed; a 5 s silence leaves a hole
  const even = smooth([0, 150, 500, 800, 1000], [0, 150, 500, 800, 1000], [0, 0, 0, 0, 0]);
  const hole = smooth([0, 300, 5300, 5600], [0, 300, 5300, 5600], [0, 0, 0, 0]);
  console.assert(even.x.length === 11 && even.x.every((v, g) => Math.abs(v - g * 100) < 1e-6) && hole.x[20] !== hole.x[20] && hole.x[56] === 5600, 'smooth');
}
console.assert(rejoin(0, 20, [5, 19.9, 20.1, Infinity]) === 3 && rejoin(10, 20, [0, 40]) === 2, 'rejoin');
console.assert(parseGap('+1.234') === 1.234 && parseGap('LAP 12') === 0 && parseGap('1L') === '1L', 'parseGap');
{ // 4 mini-sectors a lap: a repeat is dropped, a step back starts a new lap, and timing is learnt from clean laps
  const raw = [], gaps = [10, 30, 20, 40]; // every lap: 100 time units, mini-sectors ending at 10, 40, 60, 100
  for (let lap = 0, t = 0; lap < 5; lap++) gaps.forEach((gap, j) => raw.push({ t: t += gap, i: 0, j }));
  raw.splice(2, 0, { ...raw[1] });
  const p = progress(raw, [0], 4);
  console.assert(p.length === 20 && p[4].lap === 1 && p[4].k === 0, 'progress');
  console.assert(calibrate({ a: p }, 4, [0.25, 0.5, 0.75, 1]).every((f, k) => Math.abs(f - [0.1, 0.4, 0.6, 1][k]) < 1e-3), 'calibrate');
}

requestAnimationFrame(frame);
showYear(new Date().getFullYear());
// The Live button and radio transcripts only exist when the page is served by server.mjs.
fetch('live?since=999999999').then(r => { $('live').hidden = !r.ok; served = r.ok; redraw(); }, () => {});
