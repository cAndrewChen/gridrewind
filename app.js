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

// One request at a time: the free tier allows 3 requests/s and 30/min.
let queue = Promise.resolve();
function api(path) {
  const run = async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(API + path);
      if (r.status === 429) { await sleep(3000 * i); continue; }
      await sleep(350);
      if (r.status === 404) return []; // OpenF1 answers 404 for "no rows"
      if (!r.ok) throw new Error(`OpenF1 answered ${r.status}`);
      return r.json();
    }
    throw new Error('OpenF1 rate limit reached, try again in a minute');
  };
  return (queue = queue.then(run, run));
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
    if (it.value === pressed) b.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

async function showYear(y) {
  year = y;
  const now = new Date().getFullYear();
  buttons($('years'), Array.from({ length: now - 2022 }, (_, i) => ({ label: 2023 + i, value: 2023 + i })), y, showYear);
  $('races').textContent = '';
  say('Loading races…');
  let sessions;
  try { sessions = await api(`sessions?year=${y}&session_type=Race`); } catch (e) { return say(e.message); } // races and sprints
  if (y !== year) return;
  sessions.sort((a, b) => ms(a.date_start) - ms(b.date_start));
  const ready = s => !s.is_cancelled && Date.now() > ms(s.date_end) + FREE_AFTER;
  const pick = key => {
    showRaces(key);
    loadRace(sessions.find(s => s.session_key === key));
  };
  const showRaces = key => buttons($('races'), sessions.map(s => ({
    label: s.circuit_short_name + (s.session_name === 'Race' ? '' : ` ${s.session_name}`), value: s.session_key, disabled: !ready(s),
    title: `${s.country_name}, ${s.date_start.slice(0, 10)}${ready(s) ? '' : ' (no free data yet)'}`,
  })), key, pick);
  const last = sessions.filter(ready).pop();
  if (last) pick(last.session_key);
  else { showRaces(); say(sessions.length ? 'No finished race this season yet.' : 'No races found.'); }
}

// ---- loading one race ----

async function loadRace(s) {
  const id = ++loadId;
  S = null;
  setPlaying(false);
  $('main').hidden = true;
  const title = `${s.circuit_short_name} ${s.year} ${s.session_name}`;
  say(`Loading ${title}…`);
  const k = `session_key=${s.session_key}`;
  try {
    const [drivers, laps, pos, intv, stints, pits, rc, radio, champD, champT, overtakes] = await Promise.all(
      ['drivers', 'laps', 'position', 'intervals', 'stints', 'pit', 'race_control', 'team_radio',
        'championship_drivers', 'championship_teams', 'overtakes'].map(e => api(`${e}?${k}`)));
    if (id !== loadId) return;
    if (!laps.length || !drivers.length) return say('No timing data for this race.');

    // The track outline is one clean lap of one car.
    const best = laps.filter(l => l.lap_duration && l.date_start && !l.is_pit_out_lap && l.lap_number > 1)
      .sort((a, b) => a.lap_duration - b.lap_duration)[0];
    const t = best ? ms(best.date_start) : 0;
    const outline = best ? await api(`location?${k}&driver_number=${best.driver_number}&date>=${iso(t)}&date<=${iso(t + best.lap_duration * 1000 + 500)}`) : [];
    if (id !== loadId) return;
    const track = outline.filter(p => p.x || p.y);
    if (track.length < 10) return say('No position data for this race.');

    const timed = laps.filter(l => l.date_start);
    const start = Math.min(...timed.filter(l => l.lap_number === 1).map(l => ms(l.date_start)));
    const lane = pits.map(p => p.lane_duration ?? p.pit_duration).filter(d => d > 0 && d < 90); // 90 s: drops red-flag "stops"
    S = {
      k, start,
      t0: start - 60e3,
      t1: Math.max(...timed.map(l => ms(l.date_start) + (l.lap_duration ?? 0) * 1000)) + 60e3,
      t: start - 60e3,
      pts: s.session_name === 'Sprint' ? SPRINT_PTS : PTS,
      drivers: Object.fromEntries(drivers.map(d => [d.driver_number, d])),
      laps: group(timed, l => ({ t: ms(l.date_start), n: l.lap_number })),
      totalLaps: Math.max(...laps.map(l => l.lap_number)),
      pos: group(pos, p => ({ t: ms(p.date), p: p.position })),
      intv: group(intv, i => ({ t: ms(i.date), gap: i.gap_to_leader, int: i.interval })),
      stints: group(stints, x => ({ t: x.lap_start, ...x })),
      pits: group(pits, p => ({ t: ms(p.date) })),
      rc: rc.map(m => ({ t: ms(m.date), ...m })).sort(byTime),
      radio: radio.map(m => ({ t: ms(m.date), ...m })).sort(byTime),
      overtakes: overtakes.map(o => ({ t: ms(o.date), ...o })).sort(byTime).map((o, i) => ({ ...o, i })),
      champD, champT,
      pitLoss: lane.length ? median(lane) : null,
      track, box: box(track),
      pending: {}, loc: {}, shown: {},
    };
    $('seek').max = Math.round((S.t1 - S.t0) / 1000);
    $('seek').value = 0;
    showPitLoss();
    $('champ').hidden = !champD.length;
    $('otBox').hidden = !S.overtakes.length;
    $('rc').textContent = $('radio').textContent = $('ot').textContent = '';
    $('main').hidden = false;
    say(`${title} · ${s.country_name}`);
    render();
  } catch (e) {
    if (id === loadId) say(e.message);
  }
}

const showPitLoss = () => { $('pitloss').textContent = S.pitLoss ? `· a pit stop costs about ${S.pitLoss.toFixed(1)} s here` : ''; };

// Car positions for 5-minute piece i, fetched once.
function chunk(i) {
  const s = S;
  if (s.live || i < 0 || s.t0 + i * CHUNK > s.t1 || s.pending[i]) return;
  s.pending[i] = api(`location?${s.k}&date>=${iso(s.t0 + i * CHUNK)}&date<${iso(s.t0 + (i + 1) * CHUNK)}`).then(rows => {
    const d = {};
    for (const r of rows) {
      const a = d[r.driver_number] ??= { t: [], x: [], y: [] };
      a.t.push(ms(r.date)); a.x.push(r.x); a.y.push(r.y);
    }
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
  const i = Math.max(idx(d.t, t, x => x), 0), j = Math.min(i + 1, d.t.length - 1);
  const f = j > i ? Math.min(Math.max((t - d.t[i]) / (d.t[j] - d.t[i]), 0), 1) : 0;
  const x = d.x[i] + (d.x[j] - d.x[i]) * f, y = d.y[i] + (d.y[j] - d.y[i]) * f;
  return x || y ? [x, y] : undefined; // 0,0 means "no signal"
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

function draw() {
  const [g, w, h] = fit($('map'));
  g.fillStyle = '#9aa3b2';
  g.font = '13px system-ui, sans-serif';
  if (!S.track) return g.fillText('No reference lap for this circuit yet, so there is no live map.', 12, 20);

  // An overtake close-up follows the two cars; otherwise the whole track is shown.
  if (S.focus && (S.t < S.focus.from || S.t > S.focus.until)) { $('speed').value = S.focus.speed; S.focus = null; }
  const duo = S.focus ? [S.focus.a, S.focus.b] : [];
  const [p, q] = duo.map(n => carXY(n, S.t));
  const zoom = p && q;
  const R = zoom ? Math.max(1200, 0.7 * Math.hypot(p[0] - q[0], p[1] - q[1])) : 0; // half the close-up's width: 120 m, more if the cars are far apart
  const { x0, x1, y0, y1 } = zoom ? { x0: (p[0] + q[0]) / 2 - R, x1: (p[0] + q[0]) / 2 + R, y0: (p[1] + q[1]) / 2 - R, y1: (p[1] + q[1]) / 2 + R } : S.box;
  const pad = 28;
  const k = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
  const X = x => (w - (x1 - x0) * k) / 2 + (x - x0) * k;
  const Y = y => (h + (y1 - y0) * k) / 2 - (y - y0) * k; // track y points up, canvas y points down

  g.beginPath();
  for (const pt of S.track) g.lineTo(X(pt.x), Y(pt.y));
  g.closePath();
  g.lineJoin = 'round'; g.lineWidth = zoom ? 140 * k : 8; g.strokeStyle = zoom ? '#2c313a' : '#4a505c'; g.stroke(); // 140 = a 14 m wide track

  if (S.live) g.fillText('Estimated positions (from mini-sector times)', 12, 16);
  else if (!S.loc[Math.floor((S.t - S.t0) / CHUNK)]) return g.fillText('Loading car positions…', 12, 16);

  for (const n of duo) { // the path each of the two cars took over the last 5 seconds
    g.beginPath();
    for (let u = S.t - 5000; u <= S.t; u += 200) { const xy = carXY(n, u); if (xy) g.lineTo(X(xy[0]), Y(xy[1])); }
    g.lineWidth = 3; g.strokeStyle = `#${S.drivers[n]?.team_colour || '999'}`; g.stroke();
  }
  g.font = '600 11px system-ui, sans-serif';
  for (const { n } of order(S.t).reverse()) { // leader drawn last, on top
    const xy = carXY(n, S.t);
    if (!xy) continue;
    const d = S.drivers[n], x = X(xy[0]), y = Y(xy[1]);
    g.beginPath(); g.arc(x, y, 6, 0, 2 * Math.PI);
    g.fillStyle = `#${d.team_colour || '999'}`; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#111317'; g.stroke();
    g.fillStyle = '#fff'; g.fillText(d.name_acronym, x + 9, y);
  }
}

const clock = t => {
  const s = Math.round(Math.abs(t - S.start) / 1000);
  return `${t < S.start ? '-' : ''}${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtGap = g => typeof g === 'number' ? (g ? `+${g.toFixed(3)}` : '') : esc(g);
const tyreTag = c => `<span class="tyre" style="color:${TYRE[c] ?? '#999'}" title="${esc(c)}">${esc((c ?? '?')[0])}</span>`;

// Rebuild a list only when its length changes, so buttons in it stay clickable.
function list(id, items, html) {
  if (S.shown[id] === items.length) return;
  S.shown[id] = items.length;
  $(id).innerHTML = items.slice(-8).reverse().map(html).join('');
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

// The gap between two drivers at the start of every lap, as text, a chart and their tyre wear.
function renderCompare(t, ord) {
  if (S.shown.cmp !== ord.length) { // fill the two pickers; keep a choice that still exists
    S.shown.cmp = ord.length;
    [['cmpA', ord[0]], ['cmpB', ord[1] ?? ord[0]]].forEach(([id, def]) => {
      const el = $(id), keep = el.value;
      el.innerHTML = ord.map(o => `<option value="${esc(o.n)}">${esc(name(o.n))}</option>`).join('');
      el.value = S.drivers[keep] ? keep : def.n;
    });
  }
  const a = $('cmpA').value, b = $('cmpB').value;
  const tb = new Map((S.laps[b] ?? []).map(l => [l.n, l.t]));
  const pts = a === b ? [] : (S.laps[a] ?? []).filter(l => l.t <= t && tb.get(l.n) <= t).map(l => ({ n: l.n, gap: (tb.get(l.n) - l.t) / 1000 })); // + means b is behind
  const last = pts.at(-1), was = pts.at(-4);
  let text = a === b ? 'Pick two different drivers.' : 'No laps to compare yet.';
  if (last) {
    const [ahead, behind] = last.gap >= 0 ? [a, b] : [b, a];
    text = `Start of lap ${last.n}: ${name(behind)} is ${Math.abs(last.gap).toFixed(1)} s behind ${name(ahead)}`;
    const perLap = was ? (last.gap - was.gap) / 3 * Math.sign(last.gap || 1) : 0; // negative: the gap is shrinking
    text += !was ? '.' : Math.abs(perLap) < 0.05 ? ', gap steady.' : `, ${perLap < 0 ? 'catching' : 'losing'} ${Math.abs(perLap).toFixed(2)} s a lap over the last 3 laps.`;
  }
  $('cmpText').textContent = text;

  const [g, w, h] = fit($('cmp'));
  if (pts.length > 1) {
    const gaps = pts.map(pt => pt.gap), lo = Math.min(0, ...gaps), hi = Math.max(0, ...gaps);
    const X = i => 40 + i * (w - 48) / (pts.length - 1), Y = v => 10 + (hi - v) * (h - 20) / (hi - lo || 1);
    g.strokeStyle = '#4a505c'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(40, Y(0)); g.lineTo(w - 8, Y(0)); g.stroke(); // the zero line: level on track
    g.beginPath(); pts.forEach((pt, i) => g.lineTo(X(i), Y(pt.gap)));
    g.strokeStyle = '#e10600'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#9aa3b2'; g.font = '11px system-ui, sans-serif';
    g.fillText(`${hi.toFixed(1)} s`, 2, 10); g.fillText(`${lo.toFixed(1)} s`, 2, h - 10);
  }

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
  list('radio', S.radio.slice(0, idx(S.radio, t) + 1), m => /^https:\/\//.test(m.recording_url)
    ? `<li><button data-url="${esc(m.recording_url)}">Play</button><time>${clock(m.t)}</time>${esc(name(m.driver_number))}</li>` : '');
  list('ot', (S.overtakes ?? []).slice(0, idx(S.overtakes ?? [], t) + 1), o =>
    `<li><button data-ot="${o.i}">Watch</button><time>${clock(o.t)}</time>${esc(name(o.overtaking_driver_number))} passed ${esc(name(o.overtaken_driver_number))} for P${esc(o.position)}</li>`);

  // Timing tower.
  const gaps = {};
  for (const { n } of ord) {
    const i = at(S.intv[n], t);
    gaps[n] = i && t - i.t < STALE ? i : null;
  }
  const num = n => typeof gaps[n]?.gap === 'number' ? gaps[n].gap : Infinity;
  $('tower').innerHTML = ord.map(({ n, p }) => {
    const d = S.drivers[n], lap = lapOf(n) || 1;
    const st = S.stints[n]?.filter(x => x.lap_start <= lap).pop();
    const tyre = st ? `${tyreTag(st.compound)} ${st.tyre_age_at_start + lap - st.lap_start}` : '';
    const stops = idx(S.pits[n] ?? [], t) + 1;
    const after = racing && S.pitLoss && num(n) < Infinity
      ? `P${rejoin(num(n), S.pitLoss, ord.filter(o => o.n !== n).map(o => num(o.n)))}` : '';
    return `<tr><td>${p === 99 ? '' : p}</td><td><span class="bar" style="background:#${esc(d.team_colour || '999')}"></span>${esc(d.name_acronym)}</td>` +
      `<td class="n">${fmtGap(gaps[n]?.gap)}</td><td class="n">${fmtGap(gaps[n]?.int)}</td><td>${tyre}</td><td class="n">${stops || ''}</td><td class="n">${after}</td></tr>`;
  }).join('');

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
    if (d.Name) { s.title = `${d.Meeting?.Name ?? ''} ${d.Name}`; s.pts = { Race: PTS, Sprint: SPRINT_PTS }[d.Name]; }
  }
  if (topic === 'Ref') { // added by server.mjs: a reference lap of this circuit and the standings before this session
    s.champD = d.champD ?? []; s.champT = d.champT ?? [];
    if (d.track) { s.ref = d.track; s.track = d.track.pts; s.box = box(s.track); }
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
    seg: {}, segs: [], prog: {}, F: [], fix: {}, skew: -Infinity,
    rc: [], radio: [], overtakes: [], champD: [], champT: [], totalLaps: '?', shown: {} };
  $('rc').textContent = $('radio').textContent = '';
  $('main').hidden = $('champ').hidden = $('otBox').hidden = true;
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
          $('main').hidden = false;
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

// ---- playback ----

function setPlaying(on) {
  playing = on;
  $('play').textContent = on ? 'Pause' : 'Play';
}

let last = 0, lastPanel = 0;
function frame(now) {
  requestAnimationFrame(frame);
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
  draw();
  if (now - lastPanel > 250) { lastPanel = now; render(); }
}

$('play').onclick = () => { if (S) setPlaying(!playing); };
$('seek').oninput = e => { if (S) S.t = S.t0 + e.target.value * 1000; };
$('live').onclick = loadLive;
$('radio').onclick = e => {
  const url = e.target.dataset?.url;
  if (url) { $('audio').src = url; $('audio').play(); }
};
// Watch an overtake: jump to 10 s before it, zoom in on the two cars and play at half speed.
$('ot').onclick = e => {
  const o = S?.overtakes[e.target.dataset?.ot];
  if (!o) return;
  S.focus = { a: o.overtaking_driver_number, b: o.overtaken_driver_number, from: o.t - 10e3, until: o.t + 5e3, speed: S.focus?.speed ?? $('speed').value };
  S.t = S.focus.from;
  $('speed').value = '0.5';
  setPlaying(true);
  $('map').scrollIntoView({ block: 'nearest' });
};

// Self-checks of the logic that is easy to get wrong.
console.assert(idx([{ t: 1 }, { t: 5 }], 0) === -1 && idx([{ t: 1 }, { t: 5 }], 5) === 1 && idx([], 3) === -1, 'idx');
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
// The Live button only exists when the page is served by server.mjs.
fetch('live?since=999999999').then(r => { $('live').hidden = !r.ok; }, () => {});
