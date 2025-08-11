// Orbit‑Runner: Open‑World Space Flight
// Excitement + Damage/Shield pass + Massive Asteroid Fields with Dense Patches + Green Shield Orbs
import { FontLoader } from './node_modules/three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from './node_modules/three/examples/jsm/geometries/TextGeometry.js';
(() => {
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Canvas not found'); return; }
  canvas.tabIndex = 0; canvas.style.outline = 'none'; canvas.focus();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.setClearColor(0x030a1a, 1);

  const scene = new THREE.Scene();

  const baseFov = 70;
  const camera = new THREE.PerspectiveCamera(baseFov, window.innerWidth / window.innerHeight, 0.1, 100000);
  const starLight = new THREE.PointLight(0x88bbff, 1.0, 800);
  camera.add(starLight);
  scene.add(camera);

  const ambient = new THREE.AmbientLight(0x708090, 0.6);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(1, 1.5, 0.8).multiplyScalar(1000);
  scene.add(sun);

  // HUD and overlays
  const hud = document.getElementById('hud') || (() => { const d = document.createElement('div'); d.id='hud'; d.style.position='absolute'; d.style.top='10px'; d.style.left='10px'; d.style.color='#0ff'; d.style.fontSize='1.1rem'; document.body.appendChild(d); return d; })();
  const help = document.getElementById('help') || (() => { const d = document.createElement('div'); d.id='help'; d.style.position='absolute'; d.style.bottom='12px'; d.style.left='50%'; d.style.transform='translateX(-50%)'; d.style.fontSize='0.95rem'; d.style.color='#ccc'; d.style.opacity='0.85'; d.style.background='rgba(0,0,0,0.35)'; d.style.padding='6px 10px'; d.style.borderRadius='6px'; d.textContent='W/↑ speed • S/↓ slow • A/D or ←/→ yaw • I/K pitch • Space shoot • H home • R restart'; document.body.appendChild(d); return d; })();
  const gameOverEl = document.getElementById('gameover') || (()=>{ const d=document.createElement('div'); d.id='gameover'; d.style.position='absolute'; d.style.top='45%'; d.style.left='50%'; d.style.transform='translate(-50%,-50%)'; d.style.fontSize='2rem'; d.style.color='#fff'; d.style.display='none'; d.style.textAlign='center'; d.style.textShadow='0 0 8px #000'; d.innerHTML='CRASHED<br/>Press R to Restart'; document.body.appendChild(d); return d; })();

  // Font for 3D labels
  let gameFont = null;
  const fontLoader = new FontLoader();
  fontLoader.load('./node_modules/three/examples/fonts/helvetiker_regular.typeface.json', f => { gameFont = f; }, undefined, e => console.error('Font load error', e));
  const shieldTextLabels = []; // { mesh, life }
  function spawnShieldText(position){
    if (!gameFont) return; // if not ready, skip silently
    const geo = new TextGeometry('SHIELD', {
      font: gameFont, size: 2.0, depth: 0.6, curveSegments: 8,
      bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 2,
    });
    geo.computeBoundingBox();
    geo.center();
    const mat = new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 3, 0));
    scene.add(mesh);
    shieldTextLabels.push({ mesh, life: 3.0 });
  }

  // Duende SVG label for pink orb hits (renders as billboarded plane)
  const duendeTextLabels = []; // { group, life }
  function spawnDuendeText(position){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 160" width="520" height="160" role="img" aria-labelledby="title desc">\n  <title id="title">Demos logo with wave-dual emblem</title>\n  <desc id="desc">A circular emblem split by a flowing S-like curve with asymmetric dots, followed by the word Demos.</desc>\n  <defs>\n    <clipPath id="emblem-clip">\n      <circle cx="80" cy="80" r="70"/>\n    </clipPath>\n  </defs>\n  <g transform="translate(80 80) rotate(-12) translate(-80 -80)">\n    <circle cx="80" cy="80" r="70" fill="#111111"/>\n    <g clip-path="url(#emblem-clip)">\n      <path fill="#ffffff" fill-rule="evenodd" d="\n        M -20 -20 H 180 V 180 H -20 Z\n        M -20 -20\n        L 28 -20\n        C 84 -18 120 40 133 78\n        C 146 114 94 142 12 160\n        L -20 160 Z"/>\n    </g>\n    <circle cx="108" cy="48" r="11" fill="#ffffff"/>\n    <circle cx="52"  cy="114" r="15" fill="#111111"/>\n    <circle cx="80" cy="80" r="70" fill="none" stroke="#111111" stroke-width="2"/>\n  </g>\n  <text x="170" y="86" fill="#222222" font-size="64" font-weight="700" dominant-baseline="middle">Demos</text>\n</svg>`;
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const aspect = 520/160; // 3.25
      const widthUnits = 9;   // visible but not huge
      const heightUnits = widthUnits / aspect;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthUnits, heightUnits), mat);
      const group = new THREE.Group();
      group.add(mesh);
      group.position.copy(position).add(new THREE.Vector3(0, 3, 0));
      scene.add(group);
      duendeTextLabels.push({ group, life: 3.0 });
    });
  }

  // Fenix SVG label (renders as billboard plane)
  function spawnFenixLabel(position){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 480" width="600" height="480" role="img" aria-labelledby="title desc">\n  <title id="title">Fenix emblem with centered wordmark</title>\n  <desc id="desc">A stylized phoenix with outstretched wings, central flame-tail, and the word Fenix centered below.</desc>\n  <defs>\n    <style>\n      :root { --ink: #FFFFFF; }\n      .ink { fill: var(--ink); }\n      text { fill: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; font-weight: 700; letter-spacing: 0.5px; }\n    </style>\n  </defs>\n  <g aria-label="Fenix emblem">\n    <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z"/>\n    </g>\n    <path class="ink" d=" M 300 188 C 330 198, 352 222, 352 252 C 352 286, 327 311, 306 331 C 296 341, 293 356, 300 378 C 282 362, 276 346, 279 331 C 254 321, 246 297, 257 277 C 236 262, 241 234, 267 218 C 281 208, 290 196, 300 188 Z"/>\n    <path class="ink" d=" M 300 186 C 305 164, 318 147, 340 139 C 355 134, 371 141, 380 153 C 366 149, 352 151, 340 160 C 348 168, 360 175, 374 177 C 356 182, 340 181, 328 173 C 324 184, 314 191, 300 194 Z"/>\n    <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z"/>\n    </g>\n    <path class="ink" d=" M 300 330 C 314 358, 312 386, 300 410 C 314 394, 326 371, 334 344 C 322 356, 312 348, 300 330 Z"/>\n  </g>\n  <text x="300" y="452" font-size="56" text-anchor="middle">Fenix</text>\n</svg>`;
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const aspect = 600/480;
      const widthUnits = 10; const heightUnits = widthUnits / aspect;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthUnits, heightUnits), mat);
      const group = new THREE.Group(); group.add(mesh);
      group.position.copy(position).add(new THREE.Vector3(0, 4, 0));
      scene.add(group);
      duendeTextLabels.push({ group, life: 3.0 });
    });
  }

  // Ship (factory functions)
  function buildDefaultShip(){
    const mat = new THREE.MeshStandardMaterial({ color: 0x47e6ff, emissive: 0x0a2a44, emissiveIntensity: 1.5, metalness: 0.2, roughness: 0.5 });
    const geo = new THREE.ConeGeometry(1.0, 3.2, 14);
    geo.rotateX(Math.PI / 2); // nose +Z
    return new THREE.Mesh(geo, mat);
  }
  let ship = buildDefaultShip();
  scene.add(ship);

  // Stats
  let health = 100;    // %
  let shield = 0;      // %
  let gameOver = false;
  let damageCooldown = 0; // sec i‑frames after a hit
  let fenixActive = false;

  // Movement state
  let speedUnitsPerSec = 20;
  let targetSpeedUnitsPerSec = 20;
  const minSpeed = 5;
  const baseMaxSpeed = 60;
  const yawRate = 2.0;     // rad/sec
  const pitchRate = 1.35;  // rad/sec
  let yaw = 0, pitch = 0, roll = 0;
  let mouseX = 0, mouseY = 0, mouseDown = false;

  const shipPosition = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const shipHitRadius = 1.8;      // generous to make crashes easier
  const pickupHitRadius = 2.2;

  // Camera follow
  const cameraOffsetLocal = new THREE.Vector3(0, 3.7, -10.8);
  let cameraShake = 0; // meters

  // Planets
  const planets = [];
  function addPlanet(pos, radius, color) {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.1, roughness: 0.85 });
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 40), mat);
    m.position.copy(pos);
    m.userData.radius = radius;
    const glow = new THREE.PointLight(color, 2.0, radius * 22);
    glow.position.copy(pos);
    scene.add(m, glow);
    planets.push(m);
    return m;
  }
  const targetPlanet = addPlanet(new THREE.Vector3(0, 0, -20000), 1200, 0x3355aa);
  addPlanet(new THREE.Vector3(15000, 6000, 12000), 900, 0xaa7755);
  addPlanet(new THREE.Vector3(-18000, -4000, -9000), 700, 0x669966);

  // Ring halo/guide for visibility
  const ringHalo = new THREE.Mesh(
    new THREE.RingGeometry(3600, 5200, 160),
    new THREE.MeshBasicMaterial({ color: 0x6fa0ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  ringHalo.position.copy(targetPlanet.position);
  ringHalo.rotation.x = Math.PI / 2;
  scene.add(ringHalo);

  // Starfield
  (function makeStars(){
    const count = 7000;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count*3);
    for (let i=0;i<count;i++){
      const r = 22000 + Math.random()*32000;
      const theta = Math.random()*Math.PI*2;
      const phi = Math.acos(2*Math.random()-1);
      positions[i*3+0] = r * Math.sin(phi)*Math.cos(theta);
      positions[i*3+1] = r * Math.cos(phi);
      positions[i*3+2] = r * Math.sin(phi)*Math.sin(theta);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x99ccff, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.9 });
    scene.add(new THREE.Points(geo, mat));
  })();

  // Asteroids and rings
  const asteroids = []; // { mesh, radius, inRing?, inPatch?, vel?, rotAxis?, rotSpeed?, orbitRadius?, orbitAngle?, orbitSpeed?, nearMissCooldown? }
  const asteroidGeometry = new THREE.DodecahedronGeometry(1, 0);
  function randomAxis() { const v = new THREE.Vector3(Math.random()*2-1,Math.random()*2-1,Math.random()*2-1); v.normalize(); return v; }
  function randomVel(scale){ return new THREE.Vector3(Math.random()*2-1,Math.random()*2-1,Math.random()*2-1).multiplyScalar(scale); }

  function spawnAsteroidAround(center, minR, maxR, tag) {
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 0.8 + Math.random()*3.2;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.15 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(1.5), rotAxis: randomAxis(), rotSpeed: (Math.random()*2-1)*0.8, nearMissCooldown: 0, inPatch: !!tag });
  }
  function spawnAsteroidClose(center, minR, maxR, tag) {
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 1.2 + Math.random()*2.5;
    const mat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.9, metalness: 0.05, emissive: 0x333333, emissiveIntensity: 0.25 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(2.2), rotAxis: randomAxis(), rotSpeed: (Math.random()*2-1)*1.0, nearMissCooldown: 0, inPatch: !!tag });
  }
  function seedAsteroids(countFar, countNear, around) {
    for (let i=0;i<countFar;i++) spawnAsteroidAround(around, 1500, 9000);
    for (let i=0;i<countNear;i++) spawnAsteroidClose(around, 300, 1200);
  }
  // Busy from frame one (heavier)
  seedAsteroids(7000, 1400, shipPosition);

  function createRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = Math.random()*Math.PI*2;
      const r = innerR + Math.random()*(outerR-innerR);
      const yJitter = (Math.random()-0.5)*120;
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      const pos = new THREE.Vector3(x, planet.position.y + yJitter, z);
      const scale = 0.9 + Math.random()*3.2;
      const mat = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.18 });
      const m = new THREE.Mesh(asteroidGeometry, mat);
      m.scale.setScalar(scale);
      m.position.copy(pos);
      scene.add(m);
      asteroids.push({ mesh:m, radius: scale*0.95, inRing:true, orbitRadius:r, orbitAngle:a, orbitSpeed:(Math.random()*0.5+0.2)*0.06, rotAxis: randomAxis(), rotSpeed: (Math.random()*2-1)*0.8, nearMissCooldown: 0 });
    }
  }
  createRings(targetPlanet, 3600, 5200, 6500);

  // Dense patches (oversaturated areas)
  const patches = []; // { center, radius, spawnBudget }
  function addPatch(center){
    const radius = 500 + Math.random()*900; // 0.5–1.4 km
    const spawnBudget = 400 + Math.floor(Math.random()*800); // how many extras to inject over time
    patches.push({ center: center.clone(), radius, spawnBudget });
  }
  function ensurePatches(){
    const distToPlanet = shipPosition.distanceTo(targetPlanet.position);
    const t = THREE.MathUtils.clamp(1 - (distToPlanet / 22000), 0, 1);
    const desired = Math.floor(8 + t*12); // more near planet
    while (patches.length < desired){
      const nearPlanet = Math.random() < (0.5 + 0.4*t);
      const base = nearPlanet ? targetPlanet.position : shipPosition;
      const offsetR = 2000 + Math.random()*8000;
      const ang1 = Math.random()*Math.PI*2; const ang2 = Math.acos(2*Math.random()-1);
      const center = new THREE.Vector3(
        base.x + offsetR*Math.sin(ang2)*Math.cos(ang1),
        base.y + offsetR*Math.cos(ang2),
        base.z + offsetR*Math.sin(ang2)*Math.sin(ang1)
      );
      addPatch(center);
    }
  }
  function maintainPatches(dt){
    // Spawn gradually to avoid spikes
    for (let i=patches.length-1; i>=0; i--){
      const p = patches[i];
      const perSec = 120; // spawn rate per patch
      const quota = Math.min(p.spawnBudget, Math.ceil(perSec * dt));
      for (let k=0;k<quota;k++){
        if (Math.random() < 0.5) spawnAsteroidClose(p.center, 50, p.radius, true); else spawnAsteroidAround(p.center, 50, p.radius, true);
      }
      p.spawnBudget -= quota;
      // Retire distant, exhausted patches
      if (p.spawnBudget <= 0 && p.center.distanceTo(shipPosition) > 25000){ patches.splice(i,1); }
    }
  }

  // Shield Orbs (now 5% of asteroids; pulsating green; unique explosions)
  const shieldOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const shieldOrbGeometry = new THREE.SphereGeometry(0.9, 16, 16);
  function makeAdditiveMaterial(color, opacity=0.9){ return new THREE.MeshBasicMaterial({ color, transparent:true, opacity, blending:THREE.AdditiveBlending, depthWrite:false }); }
  function spawnShieldOrbAround(center, minR=800, maxR=9000){
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const mat = makeAdditiveMaterial(0x33ff66, 0.95); // green
    const m = new THREE.Mesh(shieldOrbGeometry, mat);
    m.position.copy(pos);
    const baseScale = 1.25;
    m.scale.setScalar(baseScale);
    scene.add(m);
    shieldOrbs.push({ mesh:m, radius: 1.2, bob: Math.random()*Math.PI*2, bobSpeed: 1 + Math.random()*1.5, baseScale, pulseSpeed: 3 + Math.random()*3 });
  }
  function seedShieldOrbsFromAsteroidCount(){
    const desired = Math.max(12, Math.floor(asteroids.length * 0.05)); // 5%
    while (shieldOrbs.length < desired) spawnShieldOrbAround(shipPosition);
  }
  seedShieldOrbsFromAsteroidCount();

  // New: Neon Pink Orbs (fun easter egg orbs)
  const pinkOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const pinkOrbGeometry = shieldOrbGeometry; // same base shape
  function spawnPinkOrbAround(center, minR=800, maxR=9000){
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(pinkOrbGeometry, makeAdditiveMaterial(0xff33cc, 0.95));
    m.position.copy(pos);
    const baseScale = 1.25;
    m.scale.setScalar(baseScale);
    scene.add(m);
    pinkOrbs.push({ mesh:m, radius: 1.2, bob: Math.random()*Math.PI*2, bobSpeed: 1.2 + Math.random()*1.8, baseScale, pulseSpeed: 3.5 + Math.random()*3.5 });
  }
  function seedPinkOrbsFromAsteroidCount(){
    const desired = Math.max(6, Math.floor(asteroids.length * 0.01)); // 1%
    while (pinkOrbs.length < desired) spawnPinkOrbAround(shipPosition);
  }
  seedPinkOrbsFromAsteroidCount();

  // New: Fenix Orbs (pulsating orange, 10x frequency of pink)
  const fenixOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const fenixOrbGeometry = shieldOrbGeometry;
  function spawnFenixOrbAround(center, minR=800, maxR=9000){
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(fenixOrbGeometry, makeAdditiveMaterial(0xff8800, 0.95));
    m.position.copy(pos);
    const baseScale = 1.3;
    m.scale.setScalar(baseScale);
    scene.add(m);
    fenixOrbs.push({ mesh:m, radius: 1.25, bob: Math.random()*Math.PI*2, bobSpeed: 1.0 + Math.random()*1.6, baseScale, pulseSpeed: 2.8 + Math.random()*3.0 });
  }
  function seedFenixOrbsFromAsteroidCount(){
    const desired = Math.max(20, Math.floor(asteroids.length * 0.10)); // 10%
    while (fenixOrbs.length < desired) spawnFenixOrbAround(shipPosition);
  }
  seedFenixOrbsFromAsteroidCount();

  // New: Zaphire Orbs (pulsating red, 2x Fenix abundance)
  const zaphireOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const zaphireOrbGeometry = shieldOrbGeometry;
  function spawnZaphireOrbAround(center, minR=800, maxR=9000){
    const r = minR + Math.random()*(maxR-minR);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(2*Math.random()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(zaphireOrbGeometry, makeAdditiveMaterial(0xff3333, 0.95));
    m.position.copy(pos);
    const baseScale = 1.25; m.scale.setScalar(baseScale);
    scene.add(m);
    zaphireOrbs.push({ mesh:m, radius:1.2, bob: Math.random()*Math.PI*2, bobSpeed: 1.1 + Math.random()*1.7, baseScale, pulseSpeed: 3.0 + Math.random()*3.0 });
  }
  function seedZaphireOrbsFromAsteroidCount(){
    const desired = Math.max(40, Math.floor(asteroids.length * 0.20)); // 20% (twice Fenix 10%)
    while (zaphireOrbs.length < desired) spawnZaphireOrbAround(shipPosition);
  }
  seedZaphireOrbsFromAsteroidCount();

  // Particles
  const bullets = []; // { mesh, velocity, life, radius }
  const bulletGeometry = new THREE.SphereGeometry(0.25, 8, 8);
  const beamGeometry = new THREE.CylinderGeometry(0.08, 0.08, 12, 8, 1, true); // for Fenix beams (length 12)

  const exhaustParticles = []; // { mesh, vel, life }
  const impactParticles = [];  // { mesh, vel, life }
  const exhaustGeometry = new THREE.SphereGeometry(0.18, 6, 6);
  const impactGeometry = new THREE.SphereGeometry(0.22, 6, 6);

  // Special ring bursts for shield explosions
  const ringBursts = []; // { mesh, life, growth, fade }
  const ringGeo = new THREE.RingGeometry(0.6, 0.9, 48);
  function spawnShieldRing(position, color=0x66ff99){
    const mat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.copy(position);
    scene.add(ring);
    ringBursts.push({ mesh:ring, life: 0.6, growth: 6.0, fade: 1.5 });
  }

  function spawnExhaust(ratePerSec, dt){
    const count = Math.max(0, Math.floor(ratePerSec * dt));
    if (count === 0) return;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const back = new THREE.Vector3(0,0,1).applyQuaternion(q).normalize().multiplyScalar(-1);
    const origin = new THREE.Vector3().copy(shipPosition).addScaledVector(back, 1.4).add(new THREE.Vector3(0,0.25,0).applyQuaternion(q));
    for (let i=0;i<count;i++){
      const p = new THREE.Mesh(exhaustGeometry, makeAdditiveMaterial(0x66ccff, 0.7));
      p.position.copy(origin).add(randomVel(0.4));
      p.scale.setScalar(0.6 + Math.random()*0.5);
      scene.add(p);
      const vel = back.clone().multiplyScalar(6 + speedUnitsPerSec*0.35).add(randomVel(0.8));
      exhaustParticles.push({ mesh:p, vel, life: 0.5 + Math.random()*0.25 });
    }
  }

  function spawnImpactBurst(position, baseColor=0xffaa66, count=26){
    for (let i=0;i<count;i++){
      const p = new THREE.Mesh(impactGeometry, makeAdditiveMaterial(baseColor, 0.95));
      p.position.copy(position);
      p.scale.setScalar(0.7 + Math.random()*0.9);
      scene.add(p);
      const vel = randomVel(20);
      impactParticles.push({ mesh:p, vel, life: 0.6 + Math.random()*0.2 });
    }
    cameraShake += 0.6;
  }

  // Distinct explosion for shield orbs
  function spawnShieldExplosion(position, variant){
    // variant: 'pickup' | 'shot'
    const mainColor = variant === 'shot' ? 0x99ffcc : 0x66ff99;
    const count = variant === 'shot' ? 16 : 32;
    for (let i=0;i<count;i++){
      const p = new THREE.Mesh(impactGeometry, makeAdditiveMaterial(mainColor, 1.0));
      p.position.copy(position);
      p.scale.setScalar(variant === 'shot' ? (0.5 + Math.random()*0.5) : (0.8 + Math.random()*1.0));
      scene.add(p);
      const vel = randomVel(variant === 'shot' ? 16 : 12);
      impactParticles.push({ mesh:p, vel, life: variant === 'shot' ? (0.45 + Math.random()*0.15) : (0.7 + Math.random()*0.2) });
    }
    spawnShieldRing(position, mainColor);
    cameraShake += (variant === 'shot' ? 0.25 : 0.15);
  }

  function shoot() {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const tipWorld = new THREE.Vector3().copy(shipPosition).add(dir.clone().multiplyScalar(1.8));

    if (fenixActive) {
      // Red beam
      const mat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const beam = new THREE.Mesh(beamGeometry, mat);
      // Cylinder is along +Y by default; rotate to face forward
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
      beam.quaternion.copy(alignQuat);
      // Center the beam a bit ahead of the tip
      const halfLen = 6; // half of 12
      beam.position.copy(tipWorld).add(dir.clone().multiplyScalar(halfLen));
      scene.add(beam);
      const speed = 300;
      bullets.push({ mesh: beam, velocity: dir.multiplyScalar(speed), life: 0.25, radius: 0.6 });
    } else {
      // Default blue bolt
      const mat = new THREE.MeshStandardMaterial({ color: 0x66ffff, emissive: 0x66ffff, emissiveIntensity: 3 });
      const bullet = new THREE.Mesh(bulletGeometry, mat);
      bullet.position.copy(tipWorld);
      scene.add(bullet);
      const speed = 230;
      bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(speed), life: 3.0, radius: 0.25 });
    }
    cameraShake += 0.05;
  }

  // Inputs
  const input = { yawLeft:false, yawRight:false, pitchUp:false, pitchDown:false, speedUp:false, speedDown:false, fire:false };
  function onKeyDown(e){
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = true;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = true;
    if (c==='ArrowUp'||c==='KeyW') input.speedUp = true;
    if (c==='ArrowDown'||c==='KeyS') input.speedDown = true;
    if (c==='KeyI') input.pitchUp = true;
    if (c==='KeyK') input.pitchDown = true;
    if (c==='Space') input.fire = true;
    if (c==='KeyH') {
      yaw = Math.atan2(-shipPosition.x, -shipPosition.z);
      pitch = Math.atan2(-shipPosition.y, new THREE.Vector2(shipPosition.x, shipPosition.z).length());
      targetSpeedUnitsPerSec = Math.max(targetSpeedUnitsPerSec, 22);
    }
    if (c==='KeyR' && gameOver) resetGame();
  }
  function onKeyUp(e){
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = false;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = false;
    if (c==='ArrowUp'||c==='KeyW') input.speedUp = false;
    if (c==='ArrowDown'||c==='KeyS') input.speedDown = false;
    if (c==='KeyI') input.pitchUp = false;
    if (c==='KeyK') input.pitchDown = false;
    if (c==='Space') input.fire = false;
  }
  document.addEventListener('keydown', onKeyDown, { capture:true });
  document.addEventListener('keyup', onKeyUp, { capture:true });
  window.addEventListener('keydown', onKeyDown, { capture:true });
  window.addEventListener('keyup', onKeyUp, { capture:true });
  // Update pointer handlers so overlay buttons remain clickable
  window.addEventListener('pointerdown', e => { if (e.target === canvas) { canvas.focus(); mouseDown = true; } }, { capture:true });
  window.addEventListener('pointerup', () => { mouseDown = false; });
  window.addEventListener('pointermove', e => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // HUD
  let score = 0;
  function updateHud() {
    const speedTxt = speedUnitsPerSec.toFixed(1);
    const distFromOrigin = shipPosition.length().toFixed(0);
    const distToTarget = shipPosition.distanceTo(targetPlanet.position).toFixed(0);
    const hp = Math.max(0, Math.round(health));
    const sh = Math.max(0, Math.round(shield));
    hud.textContent = `Speed ${speedTxt} | HP ${hp}% | Shield ${sh}% | Points ${score} | Dist ${distFromOrigin} | Target ${distToTarget}`;
  }

  // Simple helper to spawn centered 3D text with color
  function spawnCenteredTextLabel(text, position, color=0xffffff, size=2.0, life=2.5){
    if (!gameFont) return;
    const geo = new TextGeometry(text, { font: gameFont, size, depth: 0.5, curveSegments: 8 });
    geo.computeBoundingBox(); geo.center();
    const mat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:1, blending:THREE.AdditiveBlending, depthWrite:false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 3, 0));
    scene.add(mesh);
    duendeTextLabels.push({ group: mesh, life }); // reuse label updater; treat as group
  }

  // Store Overlay UI
  let storeOverlay = null;
  function ensureStoreOverlay(){
    if (storeOverlay) return storeOverlay;
    const overlay = document.createElement('div');
    overlay.id = 'storeOverlay';
    Object.assign(overlay.style, {
      position:'fixed', inset:'0', background:'rgba(0,0,0,0.35)', display:'none', zIndex:'9999',
      color:'#fff', fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Helvetica Neue, Arial, Noto Sans, sans-serif'
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
      width:'min(520px, 90vw)', background:'rgba(20,20,26,0.85)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:'10px',
      boxShadow:'0 12px 30px rgba(0,0,0,0.45)', padding:'16px 16px 60px 16px'
    });

    const header = document.createElement('div');
    header.textContent = 'Store';
    Object.assign(header.style, { fontSize:'22px', fontWeight:'700', marginBottom:'10px' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position:'absolute', right:'10px', top:'10px', width:'32px', height:'32px', border:'none', borderRadius:'6px',
      color:'#fff', background:'rgba(255,255,255,0.15)', cursor:'pointer'
    });
    closeBtn.onclick = () => hideStoreOverlay();

    const list = document.createElement('ul');
    Object.assign(list.style, { listStyle:'none', padding:'0', margin:'6px 0 0 0', lineHeight:'1.8' });
    ;['Lorem','Ipsum','Banana','Peel'].forEach(item => { const li=document.createElement('li'); li.textContent=item; list.appendChild(li); });

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      position:'absolute', left:'0', right:'0', bottom:'10px', display:'flex', gap:'10px', justifyContent:'center'
    });
    const accept = document.createElement('button'); accept.textContent = 'Accept';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    [accept,cancel].forEach(btn => Object.assign(btn.style, { padding:'8px 18px', border:'none', borderRadius:'8px', cursor:'pointer',
      background:'rgba(255,255,255,0.2)', color:'#fff' }));
    accept.onclick = () => hideStoreOverlay();
    cancel.onclick = () => hideStoreOverlay();
    actions.append(accept, cancel);

    panel.append(header, closeBtn, list, actions);
    overlay.append(panel);
    document.body.appendChild(overlay);
    storeOverlay = overlay; return overlay;
  }
  function showStoreOverlay(){ ensureStoreOverlay(); storeOverlay.style.display = 'block'; }
  function hideStoreOverlay(){ if (storeOverlay) storeOverlay.style.display = 'none'; }

  function showGameOver(){ gameOverEl.style.display = 'block'; }
  function hideGameOver(){ gameOverEl.style.display = 'none'; }

  // Replace ship with a Fenix model
  function buildFenixShip(){
    const group = new THREE.Group();
    // Core black material; rely on edge lines for visibility
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x000000, metalness: 0.2, roughness: 0.6 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1 });

    const bodyGeo = new THREE.ConeGeometry(1.2, 4.0, 24); bodyGeo.rotateX(Math.PI/2);
    const bodyMesh = new THREE.Mesh(bodyGeo, blackMat);
    const bodyEdges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo, 10), edgeMat);
    group.add(bodyMesh, bodyEdges);

    const wingGeo = new THREE.BoxGeometry(0.2, 0.05, 3.2);
    const leftWing = new THREE.Mesh(wingGeo, blackMat);
    const rightWing = new THREE.Mesh(wingGeo, blackMat);
    const leftEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wingGeo), edgeMat);
    const rightEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wingGeo), edgeMat);
    leftWing.position.set(-1.3, -0.2, -0.2); leftWing.rotation.y = Math.PI/10; leftEdges.position.copy(leftWing.position); leftEdges.rotation.copy(leftWing.rotation);
    rightWing.position.set(1.3, -0.2, -0.2); rightWing.rotation.y = -Math.PI/10; rightEdges.position.copy(rightWing.position); rightEdges.rotation.copy(rightWing.rotation);
    group.add(leftWing, rightWing, leftEdges, rightEdges);

    const tailGeo = new THREE.CylinderGeometry(0.15, 0.35, 0.8, 12);
    const tail = new THREE.Mesh(tailGeo, blackMat); tail.position.set(0, -0.4, -1.6); tail.rotation.x = Math.PI/2;
    const tailEdges = new THREE.LineSegments(new THREE.EdgesGeometry(tailGeo), edgeMat); tailEdges.position.copy(tail.position); tailEdges.rotation.copy(tail.rotation);
    group.add(tail, tailEdges);

    return group;
  }
  function transformToFenixShip(){
    if (fenixActive) return;
    const newShip = buildFenixShip();
    newShip.position.copy(ship.position);
    newShip.quaternion.copy(ship.quaternion);
    scene.add(newShip);
    scene.remove(ship);
    ship = newShip;
    fenixActive = true;
    health = 100; // restore to full when transforming
    cameraShake += 0.5;
  }

  // Population/field maintenance
  function keepFieldPopulated() {
    const maxDist = 16000;
    // Cull far non-ring asteroids
    for (let i = asteroids.length - 1; i >= 0; i--) {
      const a = asteroids[i];
      if (!a.inRing && a.mesh.position.distanceTo(shipPosition) > maxDist) {
        scene.remove(a.mesh);
        asteroids.splice(i,1);
      }
    }

    // Ambient density scales with planet proximity (much higher)
    const distToPlanet = shipPosition.distanceTo(targetPlanet.position);
    const t = THREE.MathUtils.clamp(1 - (distToPlanet / 22000), 0, 1);
    const desiredAmbient = Math.floor(7000 + t * 7000); // 7k far → 14k near (ambient, not counting rings)
    let ambientCount = 0; for (const a of asteroids) if (!a.inRing) ambientCount++;
    while (ambientCount < desiredAmbient) { spawnAsteroidAround(shipPosition, 800, 11000); ambientCount++; }

    // If too many, prune some far ones gradually
    let excess = ambientCount - Math.floor(desiredAmbient * 1.2);
    if (excess > 0){
      for (let i = asteroids.length - 1; i >= 0 && excess > 0; i--){
        const a = asteroids[i];
        if (!a.inRing){
          const d = a.mesh.position.distanceTo(shipPosition);
          if (d > 12000 || (d > 9000 && Math.random() < 0.2)){
            scene.remove(a.mesh); asteroids.splice(i,1); excess--;
          }
        }
      }
    }

    // Shield orb ratio: 5% of total asteroids (reduced by 50%)
    const desiredOrbs = Math.max(12, Math.floor(asteroids.length * 0.05));
    for (let i = shieldOrbs.length - 1; i >= 0; i--){
      const o = shieldOrbs[i];
      if (o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); shieldOrbs.splice(i,1); }
    }
    while (shieldOrbs.length < desiredOrbs) spawnShieldOrbAround(shipPosition);

    // Pink orb ratio: ~1% of asteroids
    const desiredPink = Math.max(6, Math.floor(asteroids.length * 0.01));
    for (let i = pinkOrbs.length - 1; i >= 0; i--){
      const o = pinkOrbs[i];
      if (o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); pinkOrbs.splice(i,1); }
    }
    while (pinkOrbs.length < desiredPink) spawnPinkOrbAround(shipPosition);

    // Fenix orb ratio: ~10% of asteroids (10x pink)
    const desiredFenix = Math.max(20, Math.floor(asteroids.length * 0.10));
    for (let i = fenixOrbs.length - 1; i >= 0; i--){
      const o = fenixOrbs[i];
      if (o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); fenixOrbs.splice(i,1); }
    }
    while (fenixOrbs.length < desiredFenix) spawnFenixOrbAround(shipPosition);

    // Zaphire orb ratio: ~20% of asteroids
    const desiredZaphire = Math.max(40, Math.floor(asteroids.length * 0.20));
    for (let i = zaphireOrbs.length - 1; i >= 0; i--){
      const o = zaphireOrbs[i];
      if (o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); zaphireOrbs.splice(i,1); }
    }
    while (zaphireOrbs.length < desiredZaphire) spawnZaphireOrbAround(shipPosition);

    // Ensure enough dense patches exist
    ensurePatches();
  }

  function applyCrashDamage(type, hitPosition){
    if (damageCooldown > 0 || gameOver) return;
    const dmgFactor = (type === 'asteroid' && fenixActive) ? 0.5 : 1.0; // Fenix halves asteroid damage to health and shields
    if (type === 'asteroid'){
      const healthDamage = (45 + Math.random()*30) * dmgFactor;   // ~avg 60% * factor
      const shieldDamage = (22 + Math.random()*22) * dmgFactor;   // ~avg 33% * factor
      if (shield > 0){ shield = Math.max(0, shield - shieldDamage); }
      health = Math.max(0, health - healthDamage);
      spawnImpactBurst(hitPosition || shipPosition);
      cameraShake += 0.4;
    } else if (type === 'planet'){
      health = 0; spawnImpactBurst(hitPosition || shipPosition, 0xff7766, 40); cameraShake += 1.2;
    }
    damageCooldown = 0.6;
    if (health <= 0){ gameOver = true; showGameOver(); }
  }

  function resetGame(){
    for (const a of asteroids) scene.remove(a.mesh); asteroids.length = 0;
    for (const b of bullets) scene.remove(b.mesh); bullets.length = 0;
    for (const p of exhaustParticles) scene.remove(p.mesh); exhaustParticles.length = 0;
    for (const p of impactParticles) scene.remove(p.mesh); impactParticles.length = 0;
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) scene.remove(o.mesh); fenixOrbs.length = 0;
    for (const o of zaphireOrbs) scene.remove(o.mesh); zaphireOrbs.length = 0;
    patches.length = 0;

    // Replace ship with default model on respawn
    scene.remove(ship);
    ship = buildDefaultShip();
    scene.add(ship);

    health = 100; shield = 0; score = 0; gameOver = false; hideGameOver();
    fenixActive = false;
    yaw = 0; pitch = 0; roll = 0; speedUnitsPerSec = 20; targetSpeedUnitsPerSec = 20;
    shipPosition.set(0,0,0); velocity.set(0,0,0);

    seedAsteroids(7000, 1400, shipPosition);
    createRings(targetPlanet, 3600, 5200, 6500);
    seedShieldOrbsFromAsteroidCount();
    seedPinkOrbsFromAsteroidCount();
    seedFenixOrbsFromAsteroidCount();
    seedZaphireOrbsFromAsteroidCount();
  }

  // Loop
  let fireCooldown = 0;
  const clock = new THREE.Clock();

  function animate(){
    const dt = Math.min(0.033, clock.getDelta());

    if (!gameOver){
      if (damageCooldown > 0) damageCooldown -= dt;
      const effectiveMaxSpeed = fenixActive ? 80 : baseMaxSpeed;
      if (input.speedUp) targetSpeedUnitsPerSec = Math.min(effectiveMaxSpeed, targetSpeedUnitsPerSec + 22*dt);
      if (input.speedDown) targetSpeedUnitsPerSec = Math.max(minSpeed, targetSpeedUnitsPerSec - 22*dt);
      speedUnitsPerSec += (targetSpeedUnitsPerSec - speedUnitsPerSec) * Math.min(1, 6*dt);
      const fovTarget = baseFov + THREE.MathUtils.clamp((speedUnitsPerSec-14)*0.7, 0, 18);
      camera.fov += (fovTarget - camera.fov) * Math.min(1, 6*dt);
      camera.updateProjectionMatrix();

      const yawInput = (input.yawRight?1:0) - (input.yawLeft?1:0) + (mouseDown ? mouseX*0.6 : 0);
      const pitchInput = (input.pitchUp?1:0) - (input.pitchDown?1:0) + (mouseDown ? -mouseY*0.6 : 0);
      yaw += yawInput * yawRate * dt;
      pitch = THREE.MathUtils.clamp(pitch + pitchInput * pitchRate * dt, -Math.PI/2+0.05, Math.PI/2-0.05);
      const targetRoll = THREE.MathUtils.clamp(-yawInput*0.9 - (mouseDown?mouseX*0.5:0), -0.7, 0.7);
      roll += (targetRoll - roll) * Math.min(1, 8*dt);

      const forward = new THREE.Vector3(0,0,1).applyEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')).normalize();
      const speedMultiplier = fenixActive ? 1.05 : 1.0; // Fenix is 5% faster
      velocity.copy(forward).multiplyScalar(speedUnitsPerSec * speedMultiplier);
      shipPosition.addScaledVector(velocity, dt);

      ship.position.copy(shipPosition);
      ship.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));

      fireCooldown -= dt;
      if (input.fire && fireCooldown <= 0){ shoot(); fireCooldown = 0.11; }
    }

    // Camera follow + shake
    const camLocal = cameraOffsetLocal.clone().applyQuaternion(ship.quaternion);
    const camPos = ship.position.clone().add(camLocal);
    cameraShake = Math.max(0, cameraShake - 2.2*dt);
    if (cameraShake > 0){ camPos.x += (Math.random()*2-1) * cameraShake; camPos.y += (Math.random()*2-1) * cameraShake * 0.6; camPos.z += (Math.random()*2-1) * cameraShake; }
    camera.position.copy(camPos);
    const lookForward = new THREE.Vector3(0,0,1).applyEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')).normalize();
    camera.lookAt(ship.position.clone().add(lookForward.multiplyScalar(20)));

    // Update bullets
    for (let i = bullets.length-1; i>=0; i--){
      const b = bullets[i];
      b.life -= dt; if (b.life <= 0){ scene.remove(b.mesh); bullets.splice(i,1); continue; }
      b.mesh.position.addScaledVector(b.velocity, dt);
    }

    // Update asteroids (drift/orbit, rotation, near‑miss, ship+bullet collisions)
    outer: for (let i = asteroids.length-1; i>=0; i--){
      const a = asteroids[i];
      if (a.inRing){
        a.orbitAngle += a.orbitSpeed * dt;
        const x = targetPlanet.position.x + Math.cos(a.orbitAngle) * a.orbitRadius;
        const z = targetPlanet.position.z + Math.sin(a.orbitAngle) * a.orbitRadius;
        a.mesh.position.set(x, a.mesh.position.y, z);
        } else {
        a.mesh.position.addScaledVector(a.vel, dt);
      }
      if (a.rotAxis && a.rotSpeed) a.mesh.rotateOnAxis(a.rotAxis, a.rotSpeed*dt);

      if (a.nearMissCooldown > 0) a.nearMissCooldown -= dt;
      const distShip = a.mesh.position.distanceTo(shipPosition);
      const nearMissDist = a.radius + 3.2;
      if (distShip < nearMissDist && a.nearMissCooldown <= 0){ spawnImpactBurst(a.mesh.position, 0x66ccff, 10); cameraShake += 0.25; a.nearMissCooldown = 1.2; }

      if (!gameOver && distShip < (a.radius + shipHitRadius)){
        applyCrashDamage('asteroid', a.mesh.position);
        scene.remove(a.mesh); asteroids.splice(i,1);
        break outer;
      }

      for (let j = bullets.length-1; j>=0; j--){
        const b = bullets[j];
        if (a.mesh.position.distanceTo(b.mesh.position) < (a.radius + b.radius)){
          spawnImpactBurst(a.mesh.position);
          scene.remove(a.mesh); asteroids.splice(i,1);
          scene.remove(b.mesh); bullets.splice(j,1);
          score += a.inRing ? 160 : 110; break outer;
        }
      }
    }

    // Shield orbs update (pulse, pickup, bullet pop)
    for (let i = shieldOrbs.length-1; i>=0; i--){
      const o = shieldOrbs[i];
      o.bob += o.bobSpeed * dt;
      // Vertical bob
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      // Pulsating scale and opacity
      const pulse = 1 + 0.2 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.7 + 0.3 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        // Pickup
        if (o.mesh.position.distanceTo(shipPosition) < (o.radius + pickupHitRadius)){
          shield = Math.min(100, shield + 25);
          spawnShieldExplosion(o.mesh.position, 'pickup');
          scene.remove(o.mesh); shieldOrbs.splice(i,1);
          continue;
        }
        // Shot by bullet
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            // Grant shield on shot as well
            shield = Math.min(100, shield + 25);
            spawnShieldText(o.mesh.position);
            spawnShieldExplosion(o.mesh.position, 'shot');
            scene.remove(o.mesh); shieldOrbs.splice(i,1);
            scene.remove(b.mesh); bullets.splice(j,1);
            break;
          }
        }
      }
    }

    // Pink orbs update (pulse, pickup/shot trigger duende text)
    for (let i = pinkOrbs.length-1; i>=0; i--){
      const o = pinkOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.75 + 0.25 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.9*dt;

      if (!gameOver){
        const trigger = () => { spawnDuendeText(o.mesh.position); spawnImpactBurst(o.mesh.position, 0xff33cc, 20); spawnShieldRing(o.mesh.position, 0xff33cc); };
        // Pickup
        if (o.mesh.position.distanceTo(shipPosition) < (o.radius + pickupHitRadius)){
          trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); continue;
        }
        // Shot by bullet
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); scene.remove(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Fenix orbs update (pulse; transform on bullet hit)
    for (let i = fenixOrbs.length-1; i>=0; i--){
      const o = fenixOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.8 + 0.2 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.7*dt;

      if (!gameOver){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            spawnFenixLabel(o.mesh.position);
            spawnImpactBurst(o.mesh.position, 0xffaa55, 24);
            spawnShieldRing(o.mesh.position, 0xffaa55);
            transformToFenixShip();
            scene.remove(o.mesh); fenixOrbs.splice(i,1);
            scene.remove(b.mesh); bullets.splice(j,1);
            break;
          }
        }
      }
    }

    // Zaphire orbs update (pulse; open Store on shot)
    for (let i = zaphireOrbs.length-1; i>=0; i--){
      const o = zaphireOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.8 + 0.2 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            spawnCenteredTextLabel('STORE', o.mesh.position, 0xffeeee, 2.2, 2.0);
            spawnImpactBurst(o.mesh.position, 0xff5555, 22);
            spawnShieldRing(o.mesh.position, 0xff5555);
            showStoreOverlay();
            scene.remove(o.mesh); zaphireOrbs.splice(i,1);
            scene.remove(b.mesh); bullets.splice(j,1);
            break;
          }
        }
      }
    }

    // Planet crash check
    if (!gameOver){
      for (const p of planets){
        const d = shipPosition.distanceTo(p.position);
        if (d < (p.userData.radius + 20)) { applyCrashDamage('planet', shipPosition); break; }
      }
    }

    // Update ring bursts
    for (let i = ringBursts.length-1; i>=0; i--){
      const r = ringBursts[i];
      r.life -= dt; if (r.life <= 0){ scene.remove(r.mesh); ringBursts.splice(i,1); continue; }
      r.mesh.scale.x += r.growth * dt; r.mesh.scale.y += r.growth * dt;
      r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - r.fade * dt);
      // billboard-ish
      r.mesh.lookAt(camera.position);
    }

    // 3D text labels update (face camera, fade, remove)
    for (let i = shieldTextLabels.length-1; i>=0; i--){
      const lbl = shieldTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){ scene.remove(lbl.mesh); shieldTextLabels.splice(i,1); continue; }
      lbl.mesh.lookAt(camera.position);
      if (lbl.life < 0.8){
        const mat = lbl.mesh.material; mat.opacity = Math.max(0, lbl.life / 0.8);
      }
    }
    for (let i = duendeTextLabels.length-1; i>=0; i--){
      const lbl = duendeTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){
        if (lbl.group.dispose) { /* mesh */ } else { /* group */ }
        scene.remove(lbl.group); duendeTextLabels.splice(i,1); continue; }
      lbl.group.lookAt(camera.position);
      // Fade last 0.8s
      if (lbl.life < 0.8){
        if (lbl.group.traverse){ lbl.group.traverse(obj => { if (obj.material && obj.material.opacity !== undefined){ obj.material.opacity = Math.max(0, lbl.life / 0.8); } }); }
        else { const mat = lbl.group.material; if (mat && mat.opacity!==undefined) mat.opacity = Math.max(0, lbl.life / 0.8); }
      }
    }

    // Particles update
    for (let i = exhaustParticles.length-1; i>=0; i--){
      const p = exhaustParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); exhaustParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      const s = Math.max(0.1, p.mesh.scale.x * (1 - 2.2*dt));
      p.mesh.scale.setScalar(s);
      const mat = p.mesh.material; mat.opacity = Math.max(0, mat.opacity - 1.6*dt);
    }
    for (let i = impactParticles.length-1; i>=0; i--){
      const p = impactParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); impactParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 2.0*dt);
      const s = Math.max(0.05, p.mesh.scale.x * (1 - 1.8*dt));
      p.mesh.scale.setScalar(s);
      const mat = p.mesh.material; mat.opacity = Math.max(0, mat.opacity - 2.8*dt);
    }

    // Exhaust
    if (!gameOver) spawnExhaust(50 + speedUnitsPerSec*4, dt);

    // World maintenance
    maintainPatches(dt);
    keepFieldPopulated();
    updateHud();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  function onResize(){ const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w,h); camera.aspect = w/h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', onResize);
  onResize();
  animate();
})();
