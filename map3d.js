// The 3D view of the race map: a blocky world built in code around the track app.js already knows.
// It reads app.js's state (S, opt) and helpers, and gives back one function, draw3d(), which the frame
// loop calls in place of draw(). If this file or three.js fails to load, the 3D button never appears.
// Scene units are metres: scene x = x / 10, scene y = height / 10, scene z = -y / 10 (app.js works in 1/10 m).
import * as THREE from 'three';

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
// scatter: what stands on open land; city: block buildings near the track (heights in m).
const TOWN = ['#c9c2b5', '#a7a39b', '#d8cfc0', '#8d9299', '#b9a998'];
const THEMES = {
  grass: { sky: '#8fc1e8', ground: ['#6fa84a', '#79b253', '#66a045'], hill: 300, water: null, scatter: 'tree', city: null },
  forest: { sky: '#9cc7e6', ground: ['#4f8f3a', '#478534', '#5a9a42'], hill: 900, water: null, scatter: 'tree', city: null },
  desert: { sky: '#f0d9a8', ground: ['#d9b877', '#cfae6d', '#e2c283'], hill: 250, water: null, scatter: 'rock', city: null },
  coast: { sky: '#8fc8ee', ground: ['#cdbf8a', '#86b05a', '#7aa652'], hill: 300, water: -30, scatter: 'tree', city: null },
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
function lay(x, y, c, h, th, r) {
  const k = nearest(c, [x, y]), d = Math.hypot(c[k][0] - x, c[k][1] - y), base = h[k] - 10;
  if (d < WIDTH) return { z: base, d };
  return { z: Math.floor((base + Math.min(1, d / 3000) * th.hill * (noise(r, x / 2000, y / 2000) - 0.4)) / STEP_H) * STEP_H, d };
}
const ground = (...a) => lay(...a).z;

const canvas = $('map3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); // throws without WebGL: no button, 2D stays
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
const world = new THREE.Group(); // everything built for one circuit
const sun = new THREE.DirectionalLight('#fff', 2);
sun.position.set(1, 2, 1);
scene.add(world, new THREE.HemisphereLight('#fff', '#444', 2), sun);
scene.background = new THREE.Color('#8fc1e8');
camera.position.set(0, 800, 800);
camera.lookAt(0, 0, 0);

function draw3d() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false); // false: the page's CSS sizes the canvas
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}

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
  console.assert(g(c[0][0], c[0][1]) === h[0] - 10 && g(40000, 40000) % STEP_H === 0 && Number.isFinite(g(-99999, 5)), 'ground');
  console.assert(theme('Nowhere') === THEMES.grass && theme('Monte Carlo').city, 'theme');
}
