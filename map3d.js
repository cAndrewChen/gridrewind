// The 3D view of the race map: a blocky world built in code around the track app.js already knows.
// It reads app.js's state (S, opt) and helpers, and gives back one function, draw3d(), which the frame
// loop calls in place of draw(). If this file or three.js fails to load, the 3D button never appears.
// Scene units are metres: scene x = x / 10, scene y = height / 10, scene z = -y / 10 (app.js works in 1/10 m).
import * as THREE from 'three';

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
