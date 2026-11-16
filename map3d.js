// The 3D view of the race map: a blocky world built in code around the track app.js already knows.
// It reads app.js's state (S, opt) and helpers, and gives back one function, draw3d(), which the frame
// loop calls in place of draw(). If this file or three.js fails to load, the 3D button never appears.
// Scene units are metres: scene x = x / 10, scene y = height / 10, scene z = -y / 10 (app.js works in 1/10 m).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- the shape of the land (no three.js here: plain numbers, in app.js's 1/10 m) ----

const CELL = 200;  // terrain blocks are 20 m across
const STEP_H = 20; // and step up 2 m at a time

// Height of each station of the line c, from the lap it was made from, with the lowest point of the lap at 0.
// The feed's height is noisy, so it is averaged over 60 m. A lap with any height missing gives a flat track.
function heights(track, c) {
  if (!track.every(p => Number.isFinite(p.z))) return c.map(() => 0);
  const pts = track.map(p => [p.x, p.y]), h = blur(c.map(q => track[nearest(pts, q)].z), 6), low = Math.min(...h);
  return h.map(v => v - low);
}

// A fixed "random" number from 0 to 1 for each grid cell, different for each seed: a circuit always looks the same.
function rand(seed) {
  let s = 2166136261;
  for (const ch of seed) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  return (ix, iy) => {
    let n = Math.imul(s ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263), 1274126177);
    n ^= n >>> 15; n = Math.imul(n, 2246822519); n ^= n >>> 13;
    return (n >>> 0) / 4294967296;
  };
}
// Those numbers blended between neighbouring cells: rolling ground instead of static.
function noise(r, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ease = f => f * f * (3 - 2 * f), u = ease(fx), v = ease(fy);
  return (r(ix, iy) * (1 - u) + r(ix + 1, iy) * u) * (1 - v) + (r(ix, iy + 1) * (1 - u) + r(ix + 1, iy + 1) * u) * v;
}

// The looks a circuit can have. ground: block colours; hill: how high the land rolls away from the track
// (1/10 m); water: land below this level is water (1/10 m above the track's lowest point), or null;
// scatter: what stands on open land (trees: on what share of it); city: block buildings near the track (heights in m).
const TOWN = ['#c9c2b5', '#a7a39b', '#d8cfc0', '#8d9299', '#b9a998'];
const THEMES = {
  grass: { sky: '#8fc1e8', ground: ['#6fa84a', '#79b253', '#66a045'], hill: 300, water: null, scatter: 'tree', trees: 0.06, city: null },
  forest: { sky: '#9cc7e6', ground: ['#4f8f3a', '#478534', '#5a9a42'], hill: 1400, water: null, scatter: 'tree', trees: 0.35, city: null },
  desert: { sky: '#f0d9a8', ground: ['#d9b877', '#cfae6d', '#e2c283'], hill: 250, water: null, scatter: 'rock', city: null },
  coast: { sky: '#8fc8ee', ground: ['#cdbf8a', '#86b05a', '#7aa652'], hill: 300, water: -30, scatter: 'tree', trees: 0.05, city: null },
  city: { sky: '#a9c6dc', ground: ['#8a8a86', '#7f7f7b', '#94948f'], hill: 150, water: null, scatter: null, city: { min: 8, max: 45, colours: TOWN, lit: false } },
  harbour: { sky: '#8fc8ee', ground: ['#8a8a86', '#7f7f7b', '#94948f'], hill: 350, water: -30, scatter: null, city: { min: 10, max: 60, colours: TOWN, lit: false } },
  night: { sky: '#0b1020', ground: ['#3a3a3e', '#333338', '#404046'], hill: 150, water: -40, scatter: null, city: { min: 15, max: 110, colours: ['#1c2233', '#232a3d', '#2b2440', '#18202c'], lit: true } },
};
// OpenF1's circuit name -> look. A circuit not listed here is grassland.
const LOOK = { Sakhir: 'desert', Lusail: 'desert', Jeddah: 'night', Singapore: 'night', 'Las Vegas': 'night', 'Monte Carlo': 'harbour', Baku: 'harbour',
  Miami: 'harbour', 'Mexico City': 'city', Interlagos: 'city', Madring: 'city', Melbourne: 'coast', Montreal: 'coast', Zandvoort: 'coast',
  'Yas Marina Circuit': 'coast', Imola: 'forest', Spielberg: 'forest', 'Spa-Francorchamps': 'forest', Monza: 'forest', Suzuka: 'forest', 'Kuala Lumpur': 'forest' };
const theme = circuit => THEMES[LOOK[circuit] ?? 'grass'];

// The land at a point: z, its height, and d, how far it is from the racing line (both 1/10 m). The land meets
// the track just under the tarmac and rolls further from the track's height the further away it is, in whole steps.
// Within `flat` of the line it is level, 1 m under the lowest bit of road nearby, so that no block pokes through the tarmac.
function lay(x, y, c, h, th, r, flat = WIDTH + CELL) {
  const k = nearest(c, [x, y]), d = Math.hypot(c[k][0] - x, c[k][1] - y);
  const base = Math.min(...[-3, -2, -1, 0, 1, 2, 3].map(j => h.at((k + j) % h.length))) - 10;
  if (d < flat) return { z: base, d };
  return { z: Math.floor((base + Math.min(1, (d - flat) / 3000) * th.hill * (noise(r, x / 2000, y / 2000) - 0.4)) / STEP_H) * STEP_H, d };
}
const ground = (...a) => lay(...a).z;

// ---- the scene ----

const canvas = $('map3d');
// Throws without WebGL: then there is no 3D button and the flat map stays. The logarithmic depth buffer lets one
// camera see both the car's own nose, half a metre away, and hills kilometres off.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 40000);
const world = new THREE.Group(); // everything built for one circuit
const sky = new THREE.HemisphereLight('#fff', '#555', 2), sun = new THREE.DirectionalLight('#fff', 2);
sun.position.set(1, 2, 1);
scene.add(world, sky, sun);
const orbit = new OrbitControls(camera, canvas);
orbit.maxPolarAngle = 1.45; // never under the ground
orbit.enableDamping = true;
orbit.minDistance = 20; orbit.maxDistance = 15000; // further out, the world would fall behind the camera's far limit

const CUBE = new THREE.BoxGeometry(1, 1, 1); // every block in the world is this cube, stretched
const V = (x, y, z) => new THREE.Vector3(x / 10, z / 10, -y / 10); // from app.js's x, y and a height, to the scene
const lambert = o => new THREE.MeshLambertMaterial(o);

// Many blocks as one mesh. Each: x, y (centre) and z (underside), in 1/10 m; w, l, h (size); colour.
function blocks(list, material = lambert({})) {
  const mesh = new THREE.InstancedMesh(CUBE, material, list.length), m = new THREE.Matrix4(), col = new THREE.Color();
  list.forEach((b, i) => {
    m.makeScale(b.w / 10, b.h / 10, b.l / 10).setPosition(V(b.x, b.y, b.z + b.h / 2));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.set(b.colour));
  });
  return mesh;
}

// Lit windows for buildings at night: a few bright squares on black, stretched over each face.
function windows() {
  const c = Object.assign(document.createElement('canvas'), { width: 8, height: 16 }), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 8, 16);
  g.fillStyle = '#fff';
  for (let i = 0; i < 128; i++) if (i % 8 % 2 && (i >> 3) % 2 && Math.random() < 0.3) g.fillRect(i % 8, i >> 3, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

let built = null, C = [], H = [], marks = null, home = null; // built: the S.road the world was made from; C, H: stations and their heights

// Height of the road at a point (1/10 m): between the two stations it lies between.
function heightAt(x, y) {
  const n = C.length;
  if (!n) return 0;
  const k = nearest(C, [x, y]), far = j => (C[j][0] - x) ** 2 + (C[j][1] - y) ** 2;
  const j = far((k + 1) % n) < far((k + n - 1) % n) ? (k + 1) % n : (k + n - 1) % n, a = C[k], b = C[j];
  const f = ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1);
  return H[k] + (H[j] - H[k]) * Math.max(0, Math.min(1, f));
}

// A closed strip between two lines of points, each [x, y, height].
function strip(a, b, colour) {
  const n = a.length, pos = [], idx = [];
  for (let i = 0; i < n; i++) {
    pos.push(...V(...a[i]), ...V(...b[i]));
    const j = (i + 1) % n;
    idx.push(2 * i, 2 * i + 1, 2 * j, 2 * i + 1, 2 * j + 1, 2 * j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, lambert({ color: colour, side: THREE.DoubleSide }));
}

function build() {
  const s = S, th = theme(s.circuit), r = rand(s.circuit ?? ''), [l, rt] = s.road.edges;
  C = stations(s.track); H = heights(s.track, C);
  scene.background = new THREE.Color(th.sky);
  const lit = !!th.city?.lit;
  sky.intensity = lit ? 0.9 : 2; sun.intensity = lit ? 0.4 : 2;

  // The road, with sides that reach down to the land, and a line across it at the start and at each sector.
  const up = (e, dz = 0) => e.map((p, i) => [p[0], p[1], H[i] + dz]);
  world.add(strip(up(l), up(rt), lit ? '#62626c' : '#2e2e2e'), // at night a dark road would vanish into the dark ground
    strip(up(l), up(l, -80), '#3a3a3a'), strip(up(rt), up(rt, -80), '#3a3a3a'));
  const line = i => {
    const j = (i + 1) % C.length, part = (e, f) => V(e[i][0] + (e[j][0] - e[i][0]) * f, e[i][1] + (e[j][1] - e[i][1]) * f, H[i] + (H[j] - H[i]) * f + 1);
    const g = new THREE.BufferGeometry().setFromPoints([part(l, 0), part(rt, 0), part(l, 0.4), part(rt, 0.4)]);
    g.setIndex([0, 1, 2, 1, 3, 2]);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#fff', side: THREE.DoubleSide }));
  };
  world.add(line(0));
  marks = new THREE.Group();
  for (const j of (s.marks ?? []).slice(1)) marks.add(line(nearest(C, [s.track[j].x, s.track[j].y])));
  world.add(marks);

  // The land: a grid of blocks around the track, at most 250 each way (bigger blocks for a very long circuit).
  const { x0, x1, y0, y1 } = s.box, EDGE = 6000;
  const cell = Math.max(CELL, (Math.max(x1 - x0, y1 - y0) + 2 * EDGE) / 250), flat = WIDTH + cell;
  const nx = Math.ceil((x1 - x0 + 2 * EDGE) / cell), ny = Math.ceil((y1 - y0 + 2 * EDGE) / cell);
  const land = [], things = [], towers = [];
  let floor = Infinity;
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    const x = x0 - EDGE + (ix + 0.5) * cell, y = y0 - EDGE + (iy + 0.5) * cell, at = lay(x, y, C, H, th, r, flat);
    const wet = th.water !== null && at.d >= flat && at.z < th.water, z = wet ? th.water : at.z;
    floor = Math.min(floor, z);
    land.push({ x, y, z, w: cell, l: cell, colour: wet ? (lit ? '#10203a' : '#3f7fd0') : th.ground[r(ix, iy + 5000) * th.ground.length | 0] });
    if (wet || at.d < flat + cell) continue;
    const dice = r(ix + 5000, iy), size = r(ix + 9000, iy);
    if (th.city && at.d < 1500 + cell) {
      if (dice < 0.6) towers.push({ x, y, z, w: cell * 0.8, l: cell * 0.8, h: 10 * (th.city.min + (th.city.max - th.city.min) * size * size), colour: th.city.colours[dice * 50 % th.city.colours.length | 0] });
    } else if (th.scatter && dice < (th.scatter === 'tree' ? th.trees : 0.05)) {
      const k = 0.7 + 0.6 * size;
      if (th.scatter === 'tree') things.push({ x, y, z, w: 30, l: 30, h: 50 * k, colour: '#6b4a2b' }, { x, y, z: z + 50 * k, w: 130 * k, l: 130 * k, h: 110 * k, colour: dice * 100 % 1 < 0.5 ? '#2a6a2a' : '#347a30' }); // blocky and oversized, to be seen from the overview
      else things.push({ x, y, z, w: 90 * k, l: 110 * k, h: 50 * k, colour: '#a08a66' });
    }
  }
  for (const b of land) { b.h = b.z - floor + 100; b.z = floor - 100; } // every block stands on the same floor: no gaps between steps
  world.add(blocks(land), blocks(things), blocks(towers, lambert(lit ? { emissive: '#ffd27a', emissiveIntensity: 0.8, emissiveMap: windows() } : {})));

  // The overview looks at the middle of the track from the south, high enough to see all of it.
  const mid = V((x0 + x1) / 2, (y0 + y1) / 2, Math.max(...H) / 2), span = Math.max(x1 - x0, y1 - y0) / 10;
  home = { target: mid, from: mid.clone().add(new THREE.Vector3(0, span * 0.9, span * 0.95)) };
  goHome();
}
function goHome() { orbit.target.copy(home.target); camera.position.copy(home.from); }

// ---- cars ----

const cars = {}; // by driver number
const DARK = lambert({ color: '#1a1a1a' }), WHITE = lambert({ color: '#f2f2f2' });

// A flat picture of some text, for a number on a nose or a name above a car.
function label(text, bg, w, h) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = h / 10;
  g.font = `700 ${h * 0.7}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.strokeText(text, w / 2, h / 2); g.fillText(text, w / 2, h / 2);
  return new THREE.CanvasTexture(c);
}

// An F1 car out of blocks, 5.3 m long, nose along +x, wheels on y = 0. part(material, long, high, wide, x, y, z), in metres.
function carModel(d) {
  const colour = `#${d.team_colour || '999'}`, paint = lambert({ color: colour }), car = new THREE.Group();
  const part = (mat, sx, sy, sz, x, y, z = 0) => { const m = new THREE.Mesh(CUBE, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); car.add(m); };
  part(DARK, 3.6, 0.12, 1.5, -0.2, 0.2);    // floor
  part(paint, 2.4, 0.42, 0.8, -0.5, 0.47);  // body
  part(paint, 0.9, 0.35, 0.4, -1.1, 0.85);  // engine cover
  part(paint, 1.7, 0.22, 0.42, 1.55, 0.37); // nose
  part(paint, 0.5, 0.08, 1.9, 2.5, 0.16);   // front wing
  part(paint, 0.45, 0.1, 1.5, -2.35, 0.98); // rear wing
  for (const z of [-0.75, 0.75]) part(DARK, 0.6, 0.62, 0.06, -2.35, 0.72, z); // its end plates
  for (const x of [1.6, -1.75]) for (const z of [-0.82, 0.82]) part(DARK, 0.72, 0.72, 0.38, x, 0.36, z); // wheels
  part(DARK, 0.9, 0.06, 0.08, 0.35, 0.86);  // halo
  part(WHITE, 0.3, 0.3, 0.3, -0.1, 0.8);    // helmet
  const num = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ map: label(d.driver_number, colour, 64, 64) }));
  num.rotation.set(-Math.PI / 2, 0, -Math.PI / 2); // flat on the nose, read from behind
  num.position.set(1.5, 0.49, 0);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(d.name_acronym, colour, 128, 48), sizeAttenuation: false, depthTest: false }));
  tag.position.y = 2.6;
  car.add(num, tag);
  car.userData = { tag, yaw: 0 };
  return car;
}

const yawOf = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]); // which way a car that went from -> to is pointing

// Where car n is at time t and which way it points: { p, yaw }, or null if it is not on the track.
function pose(n, t) {
  const xy = carXY(n, t), car = cars[n];
  if (!xy || !car || gone(n, t)) return null;
  const was = carXY(n, t - 100);
  if (was && Math.hypot(xy[0] - was[0], xy[1] - was[1]) > 1) car.userData.yaw = yawOf(was, xy); // a stopped car keeps pointing where it was
  return { p: V(xy[0], xy[1], heightAt(xy[0], xy[1])), yaw: car.userData.yaw };
}

function place(t) {
  for (const n in S.drivers) {
    const car = cars[n] ??= world.add(carModel(S.drivers[n])).children.at(-1), at = pose(n, t);
    if (!(car.visible = !!at)) continue;
    car.position.copy(at.p);
    car.rotation.y = at.yaw;
    // From far away a 5 m car is a speck: in the overview it is drawn bigger the further the camera is.
    const k = cam.mode === 'overview' ? Math.max(1, camera.position.distanceTo(at.p) / 250) : 1;
    car.scale.setScalar(k);
    car.userData.tag.scale.set(0.045 / k, 0.017 / k, 1); // the name stays one size on screen, however big the car is drawn
    car.userData.tag.visible = opt.names && !(cam.mode === 'cockpit' && n === cam.n);
  }
}

// ---- cameras ----

const cam = { mode: 'overview', n: null }; // n: the car being followed
let lost = 0, look = 0, then = 0, held = null; // held: the user's own overview, kept while an overtake close-up borrows the camera
// lost: when the followed car was last seen; look: where the cockpit camera points

function setCam(mode, n = cam.n) {
  if (mode !== 'overview' && !n) return;
  if (mode === 'overview' && cam.mode !== 'overview' && home) goHome();
  Object.assign(cam, { mode, n });
  lost = performance.now();
  look = cars[n]?.userData.yaw ?? 0;
  for (const b of $('cam').children) { b.setAttribute('aria-pressed', b.value === mode); b.disabled = b.value !== 'overview' && !n; }
  $('follow').value = n ?? '';
}

// The camera's heading `look` after ms of following a car that points along `yaw`: most of the way there in
// 80 ms, by the short way round; straight there if it is facing backwards (a jump along the time slider).
const turn = (look, yaw, ms) => Math.cos(yaw - look) < 0 ? yaw : look + Math.asin(Math.sin(yaw - look)) * (1 - Math.exp(-ms / 80));

function aim(now) {
  // Time passed in the race, not on the clock: at 20x the car turns 20 times as fast, and so must the camera.
  const dt = Math.min(now - then, 100) * Math.max(1, +$('speed').value);
  then = now;
  orbit.enabled = cam.mode === 'overview';
  if (cam.mode === 'overview') {
    // An overtake close-up: look at the two cars from above until it is over.
    const duo = S.focus && [S.focus.a, S.focus.b].map(n => cars[n]?.visible && cars[n].position);
    if (duo?.[0] && duo[1]) {
      const mid = duo[0].clone().lerp(duo[1], 0.5), far = Math.max(120, 1.4 * duo[0].distanceTo(duo[1]));
      held ??= [orbit.target.clone(), camera.position.clone()];
      orbit.target.copy(mid);
      camera.position.copy(mid).add(new THREE.Vector3(0, far * 0.8, far * 0.6));
    } else if (held && !S.focus) { orbit.target.copy(held[0]); camera.position.copy(held[1]); held = null; }
    return orbit.update();
  }
  const at = pose(cam.n, S.t);
  if (!at) { if (now - lost > 2000) setCam('overview'); return; } // retired or no signal for 2 s: back to the overview
  lost = now;
  const dir = a => new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
  if (cam.mode === 'chase') {
    // Always exactly 9 m behind the car, at any playback speed: only the direction "behind" is eased, so the
    // camera swings round after the car in a corner. (Easing its position left it behind at 5x and faster.)
    look = turn(look, at.yaw, dt / 3);
    camera.position.copy(at.p).addScaledVector(dir(look), -9).setY(at.p.y + 4);
    camera.lookAt(at.p.clone().addScaledVector(dir(look), 6).setY(at.p.y + 1));
  } else {
    look = turn(look, at.yaw, dt);
    camera.position.copy(at.p).addScaledVector(dir(at.yaw), -0.1).setY(at.p.y + 1.05); // just above the helmet: lower, the car's own body fills the view
    camera.lookAt(camera.position.clone().addScaledVector(dir(look), 10).setY(camera.position.y - 0.35));
  }
}

function draw3d() {
  const w = canvas.clientWidth, h = canvas.clientHeight, on = !!S?.track;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false); // false: the page's CSS sizes the canvas
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  world.visible = on;
  if (on) {
    if (S.road?.of !== S.track) { S.road = road(S.track); survey(S); } // as draw() does: estimated now, surveyed a moment later
    if (S.road !== built) {
      // A new race, or better edges for this one: everything is thrown away and built again.
      world.traverse(o => { o.dispose?.(); if (o.geometry && o.geometry !== CUBE) o.geometry.dispose(); // dispose(): an instanced mesh's own buffers
        for (const m of [o.material].flat()) if (m && m !== DARK && m !== WHITE) { m.map?.dispose(); m.emissiveMap?.dispose(); m.dispose(); } });
      world.clear();
      for (const n in cars) delete cars[n];
      const keep = built?.of === S.track && [orbit.target.clone(), camera.position.clone()];
      built = S.road; held = null;
      build();
      if (keep) { orbit.target.copy(keep[0]); camera.position.copy(keep[1]); } // same race: the view stays where the user put it
      else {
        $('follow').replaceChildren(new Option('Follow a car', ''), ...Object.values(S.drivers).map(d => new Option(d.name_acronym, d.driver_number)));
        setCam('overview', null);
      }
    }
    marks.visible = opt.sectors;
    $('zin').disabled = $('zout').disabled = $('zfit').disabled = cam.mode !== 'overview';
    place(S.t);
    aim(performance.now());
    place(S.t); // again: how big a car is drawn depends on where the camera ended up
  }
  renderer.render(scene, camera);
}

// The zoom buttons, in 3D, move the overview camera towards or away from what it looks at.
for (const [id, f] of [['zin', 1 / 1.6], ['zout', 1.6], ['zfit', 0]]) $(id).addEventListener('click', e => {
  if ($('map3d').hidden) return;
  e.stopImmediatePropagation(); // not the flat map's zoom as well
  if (f) camera.position.sub(orbit.target).multiplyScalar(f).add(orbit.target); else goHome();
}, true);
buttons($('cam'), ['Overview', 'Chase', 'Cockpit'].map(label => ({ label, value: label.toLowerCase() })), 'overview', setCam);
for (const b of $('cam').children) b.value = b.textContent.toLowerCase();
setCam('overview', null);
$('follow').onchange = e => setCam(e.target.value ? (cam.mode === 'overview' ? 'chase' : cam.mode) : 'overview', e.target.value || null);
// A click on a driver in the timing tower follows that car.
$('tower').addEventListener('click', e => { const n = e.target.closest('tr')?.dataset.n; if (n && !$('map3d').hidden) setCam(cam.mode === 'overview' ? 'chase' : cam.mode, n); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('map3d').hidden && cam.mode !== 'overview') setCam('overview'); });

window.draw3d = draw3d;
document.querySelector('[data-opt=three]').hidden = false;

// Self-checks, as in app.js.
{ // a ring with a 10 m hill on one side: heights follow it, lowest is 0; no z at all gives a flat track
  const ring = Array.from({ length: 200 }, (_, i) => ({ x: 3000 * Math.cos(i * Math.PI / 100), y: 3000 * Math.sin(i * Math.PI / 100), z: 500 + 50 * Math.cos(i * Math.PI / 100) }));
  const c = stations(ring), h = heights(ring, c);
  console.assert(h.length === c.length && Math.abs(Math.min(...h)) < 1e-9 && Math.abs(Math.max(...h) - 100) < 5, 'heights');
  console.assert(heights(ring.map(({ x, y }) => ({ x, y })), c).every(v => v === 0), 'heights without z');
  const r = rand('Spa-Francorchamps');
  console.assert(r(3, 7) === rand('Spa-Francorchamps')(3, 7) && r(3, 7) !== rand('Monza')(3, 7) && r(3, 7) >= 0 && r(3, 7) < 1, 'rand');
  const g = (x, y) => ground(x, y, c, h, THEMES.forest, r);
  console.assert(g(c[0][0], c[0][1]) <= h[0] - 10 && g(c[0][0], c[0][1]) > h[0] - 20 && g(40000, 40000) % STEP_H === 0 && Number.isFinite(g(-99999, 5)), 'ground');
  console.assert(Math.abs(yawOf([3000, -10], [3000, 10]) - Math.PI / 2) < 0.05 && V(0, 1, 0).z === -0.1, 'yaw: north is scene -z');
  // the camera's heading swings towards the car's the short way round: not at all in no time, all the way given long enough, at once if it faces backwards
  console.assert(turn(0, 1, 0) === 0 && Math.abs(turn(0, 1, 1e6) - 1) < 1e-6 && turn(3, -3, 80) > 3 && turn(0, 1.5, 80) > 0.5 && turn(0, 1.5, 80) < 1.5 && turn(0, 3, 1) === 3, 'turn');
  console.assert(theme('Nowhere') === THEMES.grass && theme('Monte Carlo').city, 'theme');
}
