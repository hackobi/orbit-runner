// Orbit‑Runner: Open‑World Space Flight
// Excitement + Damage/Shield pass + Massive Asteroid Fields with Dense Patches + Green Shield Orbs
import { FontLoader } from 'https://unpkg.com/three@0.164.0/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'https://unpkg.com/three@0.164.0/examples/jsm/geometries/TextGeometry.js';
(() => {
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Canvas not found'); return; }
  canvas.tabIndex = 0; canvas.style.outline = 'none'; canvas.focus();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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

  // Projectile tuning (used for reach calculations)
  const DEFAULT_BULLET_SPEED = 230;
  const DEFAULT_BULLET_LIFE = 3.0; // seconds
  const FENIX_BEAM_SPEED = 300;
  const FENIX_BEAM_LIFE = (DEFAULT_BULLET_SPEED * DEFAULT_BULLET_LIFE * 1.12) / FENIX_BEAM_SPEED; // 12% longer reach vs default
  const MIN_WORMHOLE_TELEPORT_DIST = 12000; // meters (12 km)

  // Global caps to prevent overload
  const CAPS = {
    shield: 160,
    pink: 120,
    fenix: 120,
    zaphire: 120,
    wormhole: 120,
    boost: 120,
    miner: 300,   // green: x2 asteroid points
    hunter: 300,  // blue: x2 kill points
  };
  const ONLY_RING_ORBS = true; // place all orbs in the belt only
  const USE_SPATIAL_HASH = true; // optimize bullet vs asteroid checks

  // Early declaration so ring seeding can reference it
  const boostOrbs = [];
  const minerOrbs = [];   // green multiplier (asteroid x2)
  const hunterOrbs = [];  // blue multiplier (kill x2)
  // Early declaration so animate() can reference bots safely
  const bots = [];

  // HUD and overlays
  const hud = document.getElementById('hud') || (() => { const d = document.createElement('div'); d.id='hud'; d.style.position='absolute'; d.style.top='10px'; d.style.left='10px'; d.style.color='#0ff'; d.style.fontSize='1.1rem'; document.body.appendChild(d); return d; })();
  const help = document.getElementById('help') || (() => { const d = document.createElement('div'); d.id='help'; d.style.position='absolute'; d.style.bottom='12px'; d.style.left='50%'; d.style.transform='translateX(-50%)'; d.style.fontSize='0.95rem'; d.style.color='#ccc'; d.style.opacity='0.85'; d.style.background='rgba(0,0,0,0.35)'; d.style.padding='6px 10px'; d.style.borderRadius='6px'; d.textContent='W/↑ speed • S/↓ slow • A/D or ←/→ yaw • I/K pitch • Space shoot • H home • T dev 500 • R restart'; document.body.appendChild(d); return d; })();
  const gameOverEl = document.getElementById('gameover') || (()=>{ const d=document.createElement('div'); d.id='gameover'; d.style.position='absolute'; d.style.top='45%'; d.style.left='50%'; d.style.transform='translate(-50%,-50%)'; d.style.fontSize='2rem'; d.style.color='#fff'; d.style.display='none'; d.style.textAlign='center'; d.style.textShadow='0 0 8px #000'; d.innerHTML='CRASHED<br/>Press R to Restart'; document.body.appendChild(d); return d; })();

  // Placeholder patch system to avoid reference errors
  const patches = [];
  function ensurePatches(){ /* no-op for now */ }
  function maintainPatches(){ /* no-op for now */ }

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
  const DEV_TURBO_SPEED = 500;
  const yawRate = 2.0;     // rad/sec
  const pitchRate = 1.35;  // rad/sec
  let yaw = 0, pitch = 0, roll = 0;
  let mouseX = 0, mouseY = 0, mouseDown = false;
  let devTurboActive = false;

  const shipPosition = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const shipHitRadius = 1.8;      // generous to make crashes easier
  const pickupHitRadius = 2.2;

  // Camera follow
  const cameraOffsetLocal = new THREE.Vector3(0, 3.7, -10.8);
  let cameraShake = 0; // meters

  // Boost state
  let boostActive = false;
  let boostTimer = 0; // seconds remaining

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

  // Removed belt "veil" halo for a cleaner look

  // Starfield
  (function makeStars(){
    const count = 7000;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count*3);
    for (let i=0;i<count;i++){
      const r = 22000 + rand()*32000;
      const theta = rand()*Math.PI*2;
      const phi = Math.acos(2*rand()-1);
      positions[i*3+0] = r * Math.sin(phi)*Math.cos(theta);
      positions[i*3+1] = r * Math.cos(phi);
      positions[i*3+2] = r * Math.sin(phi)*Math.sin(theta);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x99ccff, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.9 });
    scene.add(new THREE.Points(geo, mat));
  })();

  // Belt helpers and scoring
  const RING_INNER = 3600;
  const RING_OUTER = 5200;
  function isWithinBeltXZ(pos){
    const dx = pos.x - targetPlanet.position.x;
    const dz = pos.z - targetPlanet.position.z;
    const r2 = dx*dx + dz*dz;
    return (r2 >= RING_INNER*RING_INNER) && (r2 <= RING_OUTER*RING_OUTER);
  }
  function getAsteroidScore(base, pos){
    let mult = 1;
    if (asteroidMultTimer > 0) mult *= 2;
    if (isWithinBeltXZ(pos)) mult *= 2;
    return Math.round(base * mult);
  }
  function getKillScore(base, pos){
    let mult = 1;
    if (killMultTimer > 0) mult *= 2;
    if (isWithinBeltXZ(pos)) mult *= 2;
    return Math.round(base * mult);
  }

  // Math utility: squared-distance radius check to avoid sqrt per frame
  function isWithinRadiusSquared(posA, posB, combinedRadius){
    const dx = posA.x - posB.x;
    const dy = posA.y - posB.y;
    const dz = posA.z - posB.z;
    return (dx*dx + dy*dy + dz*dz) < (combinedRadius * combinedRadius);
  }

  // Spatial hash for broad-phase collision
  class SpatialHash {
    constructor(cellSize){ this.cellSize = cellSize; this.map = new Map(); }
    key(x,y,z){ const cs=this.cellSize; return ((x/cs)|0)+":"+((y/cs)|0)+":"+((z/cs)|0); }
    clear(){ this.map.clear(); }
    insert(obj, pos){ const k=this.key(pos.x,pos.y,pos.z); let a=this.map.get(k); if(!a){ a=[]; this.map.set(k,a);} a.push(obj); }
    query(pos, radius){
      const cs=this.cellSize, r=radius; const out=[]; const m=this.map;
      const minX=((pos.x-r)/cs|0), maxX=((pos.x+r)/cs|0);
      const minY=((pos.y-r)/cs|0), maxY=((pos.y+r)/cs|0);
      const minZ=((pos.z-r)/cs|0), maxZ=((pos.z+r)/cs|0);
      for(let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++) for(let z=minZ;z<=maxZ;z++){
        const a=m.get(x+":"+y+":"+z); if(a) out.push(...a);
      }
      return out;
    }
  }

  // Utility: glow sprite texture for wormholes
  let glowTexture = null;
  function getGlowTexture(){
    if (glowTexture) return glowTexture;
    const size = 128;
    const cvs = document.createElement('canvas'); cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 10, size/2, size/2, size/2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0,0,size,size);
    glowTexture = new THREE.CanvasTexture(cvs);
    glowTexture.colorSpace = THREE.SRGBColorSpace;
    glowTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return glowTexture;
  }

  // Seeded RNG for MP deterministic world
  let rng = null;
  function mulberry32(seed){ return function(){ let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function setRand(seed){ rng = mulberry32(seed>>>0); }
  function rand(){ return rng ? rng() : Math.random(); }

  // Asteroids
  const asteroids = [];      // { mesh, radius, inRing?, inPatch?, vel?, rotAxis?, rotSpeed?, orbitRadius?, orbitAngle?, orbitSpeed?, nearMissCooldown? }
  const asteroidGeometry = new THREE.DodecahedronGeometry(1, 0);
  function randomAxis() { const v = new THREE.Vector3(rand()*2-1,rand()*2-1,rand()*2-1); v.normalize(); return v; }
  function randomVel(scale){ return new THREE.Vector3(rand()*2-1,rand()*2-1,rand()*2-1).multiplyScalar(scale); }

  function spawnAsteroidAround(center, minR, maxR) {
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 0.8 + rand()*3.2;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.15 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(1.5), rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*0.8, nearMissCooldown: 0 });
  }
  function spawnAsteroidClose(center, minR, maxR) {
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 1.2 + rand()*2.5;
    const mat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.9, metalness: 0.05, emissive: 0x333333, emissiveIntensity: 0.25 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(2.2), rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*1.0, nearMissCooldown: 0 });
  }
  function seedAsteroids(countFar, countNear, around) {
    for (let i=0;i<countFar;i++) spawnAsteroidAround(around, 1500, 9000);
    for (let i=0;i<countNear;i++) spawnAsteroidClose(around, 300, 1200);
  }
  seedAsteroids(7000, 1400, shipPosition);

  function createRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*120;
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      const pos = new THREE.Vector3(x, planet.position.y + yJitter, z);
      const scale = 0.9 + rand()*3.2;
      const mat = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.18 });
      const m = new THREE.Mesh(asteroidGeometry, mat);
      m.scale.setScalar(scale);
      m.position.copy(pos);
      scene.add(m);
      asteroids.push({ mesh:m, radius: scale*0.95, inRing:true, orbitRadius:r, orbitAngle:a, orbitSpeed:(rand()*0.5+0.2)*0.06, rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*0.8, nearMissCooldown: 0, instanceId:-1, instanceGroup:-1, scale });
    }
  }
  // Double the number of ring asteroids for richer belts
  createRings(targetPlanet, 3600, 5200, 13000);

  // Grouped InstancedMesh rendering for ring asteroids (2-3 batches)
  let ringInstancedGroups = [];
  const instTmp = new THREE.Object3D();
  function disposeRingInstancedGroups(){
    if (!ringInstancedGroups || ringInstancedGroups.length===0) return;
    for (const im of ringInstancedGroups){ try { scene.remove(im); im.geometry.dispose?.(); if (im.material.dispose) im.material.dispose(); } catch(_){} }
    ringInstancedGroups = [];
  }
  function buildRingInstancedGroups(groupCount=3){
    disposeRingInstancedGroups();
    const ringIndices = [];
    for (let i=0;i<asteroids.length;i++){ if (asteroids[i].inRing) ringIndices.push(i); }
    if (ringIndices.length === 0) return;
    // Partition into groupCount buckets
    const buckets = Array.from({length: groupCount}, ()=>[]);
    for (let j=0;j<ringIndices.length;j++){ buckets[j % groupCount].push(ringIndices[j]); }
    const geom = asteroidGeometry.clone();
    for (let g=0; g<groupCount; g++){
      const count = buckets[g].length; if (count === 0){ ringInstancedGroups[g] = null; continue; }
      const mat = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.18 });
      const im = new THREE.InstancedMesh(geom, mat, count);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(im);
      ringInstancedGroups[g] = im;
      // Assign mapping and initialize matrices
      for (let k=0;k<count;k++){
        const idx = buckets[g][k];
        const a = asteroids[idx];
        a.instanceGroup = g; a.instanceId = k;
        a.mesh.visible = false; // hide original render mesh; keep for position/collision
        instTmp.position.copy(a.mesh.position);
        instTmp.rotation.set(0,0,0);
        instTmp.scale.set(a.scale, a.scale, a.scale);
        instTmp.updateMatrix();
        im.setMatrixAt(k, instTmp.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }
  buildRingInstancedGroups(3);

  // Removed InstancedMesh rendering to restore per-mesh movement/rendering for ring asteroids

  // Font for 3D labels
  let gameFont = null;
  const fontLoader = new FontLoader();
  fontLoader.load('https://unpkg.com/three@0.164.0/examples/fonts/helvetiker_regular.typeface.json', f => { gameFont = f; }, undefined, e => console.error('Font load error', e));
  const shieldTextLabels = []; // { mesh, life }
  function spawnShieldText(position){
    if (!gameFont) return;
    const geo = new TextGeometry('SHIELD', {
      font: gameFont, size: 2.0, depth: 0.6, curveSegments: 8,
      bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 2,
    });
    geo.computeBoundingBox(); geo.center();
    const mat = new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 3, 0));
    scene.add(mesh);
    shieldTextLabels.push({ mesh, life: 3.0 });
  }

  // Duende SVG label for pink orb hits (renders as billboarded plane)
  const duendeTextLabels = []; // { group, life }
  function spawnDuendeText(position){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 160" width="520" height="160" role="img" aria-labelledby="title desc">\n  <title id="title">Demos logo with wave-dual emblem</title>\n  <desc id="desc">A circular emblem split by a flowing S-like curve with asymmetric dots, followed by the word Demos.</desc>\n  <defs>\n    <clipPath id="emblem-clip">\n      <circle cx="80" cy="80" r="70"/>\n    </clipPath>\n  </defs>\n  <g transform="translate(80 80) rotate(-12) translate(-80 -80)">\n    <circle cx="80" cy="80" r="70" fill="#111111"/>\n    <g clip-path="url(#emblem-clip)">\n      <path fill="#ffffff" fill-rule="evenodd" d="\n        M -20 -20 H 180 V 180 H -20 Z\n        M -20 -20\n        L 28 -20\n        C 84 -18 120 40 133 78\n        C 146 114 94 142 12 160\n        L -20 160 Z\"/>\n    </g>\n    <circle cx="108" cy="48" r="11" fill="#ffffff"/>\n    <circle cx="52"  cy="114" r="15" fill="#111111"/>\n    <circle cx="80" cy="80" r="70" fill="none" stroke="#111111" stroke-width="2"/>\n  </g>\n  <text x="170" y="86" fill="#222222" font-size="64" font-weight="700" dominant-baseline="middle">Demos</text>\n</svg>`;
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 480" width="600" height="480" role="img" aria-labelledby="title desc">\n  <title id="title">Fenix emblem with centered wordmark</title>\n  <desc id="desc">A stylized phoenix with outstretched wings, central flame-tail, and the word Fenix centered below.</desc>\n  <defs>\n    <style>\n      :root { --ink: #FFFFFF; }\n      .ink { fill: var(--ink); }\n      text { fill: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; font-weight: 700; letter-spacing: 0.5px; }\n    </style>\n  </defs>\n  <g aria-label="Fenix emblem">\n    <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z\"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z\"/>\n    </g>\n    <path class="ink" d=" M 300 188 C 330 198, 352 222, 352 252 C 352 286, 327 311, 306 331 C 296 341, 293 356, 300 378 C 282 362, 276 346, 279 331 C 254 321, 246 297, 257 277 C 236 262, 241 234, 267 218 C 281 208, 290 196, 300 188 Z\"/>\n    <path class="ink" d=" M 300 186 C 305 164, 318 147, 340 139 C 355 134, 371 141, 380 153 C 366 149, 352 151, 340 160 C 348 168, 360 175, 374 177 C 356 182, 340 181, 328 173 C 324 184, 314 191, 300 194 Z\"/>\n    <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z\"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z\"/>\n    </g>\n    <path class="ink" d=" M 300 330 C 314 358, 312 386, 300 410 C 314 394, 326 371, 334 344 C 322 356, 312 348, 300 330 Z\"/>\n  </g>\n  <text x="300" y="452" font-size="56" text-anchor="middle">Fenix</text>\n</svg>`;
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

  // Replace ship with a Fenix model
  function buildFenixShip(){
    const group = new THREE.Group();
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

  // Shield Orbs (now 5% of asteroids; pulsating green; unique explosions)
  const shieldOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const shieldOrbGeometry = new THREE.SphereGeometry(0.9, 16, 16);
  function makeAdditiveMaterial(color, opacity=0.9){ return new THREE.MeshBasicMaterial({ color, transparent:true, opacity, blending:THREE.AdditiveBlending, depthWrite:false }); }
  function spawnShieldOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
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
    shieldOrbs.push({ mesh:m, radius: 1.2, bob: rand()*Math.PI*2, bobSpeed: 1 + rand()*1.5, baseScale, pulseSpeed: 3 + rand()*3 });
  }
  function spawnShieldOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const mat = makeAdditiveMaterial(0x33ff66, 0.95);
    const m = new THREE.Mesh(shieldOrbGeometry, mat);
    m.position.copy(pos);
    const baseScale = 1.25; m.scale.setScalar(baseScale);
    scene.add(m);
    shieldOrbs.push({ mesh:m, radius: 1.2, bob: rand()*Math.PI*2, bobSpeed: 1 + rand()*1.5, baseScale, pulseSpeed: 3 + rand()*3 });
  }
  function seedShieldOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.shield, Math.max(12, Math.floor(asteroids.length * 0.05)));
    while (shieldOrbs.length < desired) spawnShieldOrbAround(shipPosition);
  }
  seedShieldOrbsFromAsteroidCount();

  // New: Neon Pink Orbs
  const pinkOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const pinkOrbGeometry = shieldOrbGeometry; // same base shape
  function spawnPinkOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(pinkOrbGeometry, makeAdditiveMaterial(0xff33cc, 0.95));
    m.position.copy(pos);
    const baseScale = 1.7;
    m.scale.setScalar(baseScale);
    scene.add(m);
    pinkOrbs.push({ mesh:m, radius: 1.6, bob: rand()*Math.PI*2, bobSpeed: 1.6 + rand()*2.0, baseScale, pulseSpeed: 4.0 + rand()*3.5 });
  }
  function spawnPinkOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const m = new THREE.Mesh(pinkOrbGeometry, makeAdditiveMaterial(0xff33cc, 0.98));
    m.position.copy(pos);
    const baseScale = 1.7; m.scale.setScalar(baseScale);
    scene.add(m);
    pinkOrbs.push({ mesh:m, radius: 1.6, bob: rand()*Math.PI*2, bobSpeed: 1.6 + rand()*2.0, baseScale, pulseSpeed: 4.0 + rand()*3.5 });
  }
  function seedPinkOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.pink, Math.max(6, Math.floor(asteroids.length * 0.01)));
    while (pinkOrbs.length < desired) spawnPinkOrbAround(shipPosition);
  }
  seedPinkOrbsFromAsteroidCount();

  // New: Fenix Orbs
  const fenixOrbs = [];
  const fenixOrbGeometry = shieldOrbGeometry;
  function spawnFenixOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    // Neon orange core (more orange hue)
    const m = new THREE.Mesh(fenixOrbGeometry, makeAdditiveMaterial(0xff7a00, 0.98));
    m.position.copy(pos);
    const baseScale = 1.8; m.scale.setScalar(baseScale);
    // Yellow glow
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xfff066, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    fenixOrbs.push({ mesh:m, glow, radius: 1.7, bob: rand()*Math.PI*2, bobSpeed: 1.0 + rand()*1.6, baseScale, pulseSpeed: 3.6 + rand()*3.6 });
  }
  function spawnFenixOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    // Neon orange core (more orange hue)
    const m = new THREE.Mesh(fenixOrbGeometry, makeAdditiveMaterial(0xff7a00, 0.98));
    m.position.copy(pos);
    const baseScale = 1.8; m.scale.setScalar(baseScale);
    // Yellow glow
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xfff066, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    fenixOrbs.push({ mesh:m, glow, radius: 1.7, bob: rand()*Math.PI*2, bobSpeed: 1.0 + rand()*1.6, baseScale, pulseSpeed: 3.6 + rand()*3.6 });
  }
  function seedFenixOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.fenix, Math.max(20, Math.floor(asteroids.length * 0.10)));
    while (fenixOrbs.length < desired) spawnFenixOrbAround(shipPosition);
  }
  seedFenixOrbsFromAsteroidCount();

  // New: Zaphire Orbs
  const zaphireOrbs = [];
  const zaphireOrbGeometry = shieldOrbGeometry;
  function spawnZaphireOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(zaphireOrbGeometry, makeAdditiveMaterial(0xff3333, 1.0));
    m.position.copy(pos);
    const baseScale = 2.5; // doubled size
    m.scale.setScalar(baseScale);
    // Add bright red glow sprite for extra visibility/brightness
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xff4444, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    zaphireOrbs.push({ mesh:m, glow, radius:2.4, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, baseScale, pulseSpeed: 3.0 + rand()*3.0 });
  }
  function spawnZaphireOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const m = new THREE.Mesh(zaphireOrbGeometry, makeAdditiveMaterial(0xff3333, 1.0));
    m.position.copy(pos);
    const baseScale = 2.5; m.scale.setScalar(baseScale);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xff4444, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    zaphireOrbs.push({ mesh:m, glow, radius:2.4, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, baseScale, pulseSpeed: 3.0 + rand()*3.0 });
  }

  function seedAllOrbsInRingByProportion(planet, innerR=3600, outerR=5200){
    // Keep existing asteroids; clear only orbs
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) scene.remove(o.mesh); fenixOrbs.length = 0;
    for (const o of zaphireOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } zaphireOrbs.length = 0;
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;

    let ring = 0;
    for (const a of asteroids){ if (a.inRing) ring++; }
    if (ring <= 0) return;

    // Use generous minimums to guarantee visible saturation
    const desiredShield = Math.max(80, Math.min(CAPS.shield, Math.floor(ring * 0.05)));
    const desiredPink   = Math.max(120, Math.min(CAPS.pink,   Math.floor(ring * 0.04)));
    const desiredFenix  = Math.max(100, Math.min(CAPS.fenix,  Math.floor(ring * 0.12)));
    const desiredZaph   = Math.max(40, Math.min(CAPS.zaphire,Math.floor(ring * 0.20)));
    const desiredWorm   = Math.max(60, Math.min(CAPS.wormhole,Math.floor(ring * 0.20)));
    const desiredBoost  = Math.max(70, Math.min(CAPS.boost,  Math.floor(ring * 0.15)));

    for (let i=0;i<desiredShield;i++) spawnShieldOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredPink;i++)   spawnPinkOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredFenix;i++)  spawnFenixOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredZaph;i++)   spawnZaphireOrbOnRing(planet, innerR, outerR);
    seedWormholesOnRings(planet, innerR, outerR, Math.max(desiredWorm, Math.floor(ring*0.05)));
    seedBoostOnRings(planet, innerR, outerR, Math.max(desiredBoost, Math.floor(ring*0.06)));
    // Add multiplier orbs in the belt
    const desiredMiner  = Math.min(CAPS.miner,  Math.max(50, Math.floor(ring * 0.15)));   // 5x
    const desiredHunter = Math.min(CAPS.hunter, Math.max(50, Math.floor(ring * 0.15)));   // 5x
    for (let i=0;i<desiredMiner;i++) spawnMinerOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredHunter;i++) spawnHunterOrbOnRing(planet, innerR, outerR);
  }
  function seedZaphireOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.zaphire, Math.max(40, Math.floor(asteroids.length * 0.20)));
    while (zaphireOrbs.length < desired) spawnZaphireOrbAround(shipPosition);
  }
  seedZaphireOrbsFromAsteroidCount();

  // New: Wormhole Orbs (visible bright glow)
  const wormholeOrbs = []; // { mesh, halo, glow, cubeCam, coreMat, radius, bob, bobSpeed, pulseSpeed, lastCubeUpdate }
  function createWormholeAtPosition(pos){
    const rt = new THREE.WebGLCubeRenderTarget(256);
    const cubeCam = new THREE.CubeCamera(0.1, 1000, rt);
    cubeCam.position.copy(pos);
    scene.add(cubeCam);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 1.0, roughness: 0.02, envMap: rt.texture, envMapIntensity: 0.0 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 24), coreMat);
    core.position.copy(pos);
    const halo = new THREE.Mesh(new THREE.RingGeometry(2.2, 4.0, 64), new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    halo.position.copy(pos); halo.lookAt(camera.position);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xffffff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(12,12,1);
    scene.add(core, halo, glow);
    wormholeOrbs.push({ mesh:core, halo, glow, cubeCam, coreMat, radius: 1.8, bob: rand()*Math.PI*2, bobSpeed: 1.2 + rand()*1.8, pulseSpeed: 3.0 + rand()*3.0, lastCubeUpdate: 0 });
  }
  function spawnWormholeOrbAround(center, minR=1200, maxR=12000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    createWormholeAtPosition(pos);
  }
  function seedWormholesFromAsteroidCount(){
    const desired = Math.min(CAPS.wormhole, Math.max(40, Math.floor(asteroids.length * 0.20)));
    while (wormholeOrbs.length < desired) spawnWormholeOrbAround(shipPosition);
  }
  seedWormholesFromAsteroidCount();

  // Heavily bias wormholes/boost into planet rings on init
  function seedWormholesOnRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*40; // tighter vertical spread
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      createWormholeAtPosition(new THREE.Vector3(x, planet.position.y + yJitter, z));
    }
  }
  function seedBoostOnRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*40;
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      // use existing boost orb creation but at fixed position
      const pos = new THREE.Vector3(x, planet.position.y + yJitter, z);
      const core = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 18), makeAdditiveMaterial(0x33ff77, 0.95)); core.position.copy(pos);
      const ringG = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 48), new THREE.MeshBasicMaterial({ color:0x33ff77, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ringG.position.copy(pos); ringG.lookAt(camera.position);
      const ringP = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.8, 64), new THREE.MeshBasicMaterial({ color:0xaa55ff, transparent:true, opacity:0.45, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ringP.position.copy(pos); ringP.lookAt(camera.position);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0x88ccff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })); glow.position.copy(pos); glow.scale.set(10,10,1);
      scene.add(core, ringG, ringP, glow);
      boostOrbs.push({ core, ringG, ringP, glow, radius:1.2, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3.0 + rand()*3.0 });
    }
  }
  // Initial ring saturation
  seedWormholesOnRings(targetPlanet, 3600, 5200, 100);
  seedBoostOnRings(targetPlanet, 3600, 5200, 140);
  // Seed extra multiplier orbs immediately for visibility
  for (let i=0;i<80;i++) spawnMinerOrbOnRing(targetPlanet, 3600, 5200);
  for (let i=0;i<80;i++) spawnHunterOrbOnRing(targetPlanet, 3600, 5200);

  // New: Boost Orbs (green + purple)
  function spawnBoostOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 18), makeAdditiveMaterial(0x33ff77, 0.95));
    core.position.copy(pos);
    const ringG = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 48), new THREE.MeshBasicMaterial({ color:0x33ff77, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    ringG.position.copy(pos); ringG.lookAt(camera.position);
    const ringP = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.8, 64), new THREE.MeshBasicMaterial({ color:0xaa55ff, transparent:true, opacity:0.45, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    ringP.position.copy(pos); ringP.lookAt(camera.position);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0x88ccff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(10,10,1);
    scene.add(core, ringG, ringP, glow);
    boostOrbs.push({ core, ringG, ringP, glow, radius:1.2, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3.0 + rand()*3.0 });
  }

  // New: Miner (green) and Hunter (blue) multiplier orbs
  function spawnMinerOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2; const r = innerR + rand()*(outerR-innerR); const yJ=(rand()-0.5)*40;
    const pos = new THREE.Vector3(planet.position.x+Math.cos(a)*r, planet.position.y+yJ, planet.position.z+Math.sin(a)*r);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.2, 18, 18), makeAdditiveMaterial(0x33ff66, 0.98)); core.position.copy(pos);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.8, 48), new THREE.MeshBasicMaterial({ color:0x66ff99, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ring.position.copy(pos);
    ring.lookAt(camera.position);
    scene.add(core, ring);
    minerOrbs.push({ core, ring, radius:1.3, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3 + rand()*3 });
  }
  function spawnHunterOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2; const r = innerR + rand()*(outerR-innerR); const yJ=(rand()-0.5)*40;
    const pos = new THREE.Vector3(planet.position.x+Math.cos(a)*r, planet.position.y+yJ, planet.position.z+Math.sin(a)*r);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.2, 18, 18), makeAdditiveMaterial(0x3399ff, 0.98)); core.position.copy(pos);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.8, 48), new THREE.MeshBasicMaterial({ color:0x66aaff, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ring.position.copy(pos);
    ring.lookAt(camera.position);
    scene.add(core, ring);
    hunterOrbs.push({ core, ring, radius:1.3, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3 + rand()*3 });
  }
  function seedBoostOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.boost, Math.max(30, Math.floor(asteroids.length * 0.15))); // ~15%
    while (boostOrbs.length < desired) spawnBoostOrbAround(shipPosition);
  }
  seedBoostOrbsFromAsteroidCount();

  // Particles
  const bullets = []; // { mesh, velocity, life, radius, kind?:'player'|'fenix'|'bot' }
  const bulletGeometry = new THREE.SphereGeometry(0.25, 8, 8);
  const beamGeometry = new THREE.CylinderGeometry(0.06, 0.06, 12, 8, 1, true); // thinner Fenix beam

  // Bullet pools (player + fenix only; bots unchanged for now)
  const playerBulletPool = [];
  const fenixBeamPool = [];
  function acquirePlayerBulletMesh(){
    const m = playerBulletPool.pop();
    if (m) return m;
    return new THREE.Mesh(bulletGeometry, new THREE.MeshStandardMaterial({ color: 0x66ffff, emissive: 0x66ffff, emissiveIntensity: 3 }));
  }
  function releasePlayerBulletMesh(mesh){ playerBulletPool.push(mesh); }
  function acquireFenixBeamMesh(){
    const m = fenixBeamPool.pop();
    if (m) return m;
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    return new THREE.Mesh(beamGeometry, mat);
  }
  function releaseFenixBeamMesh(mesh){ fenixBeamPool.push(mesh); }

  const exhaustParticles = []; // { mesh, vel, life }
  const impactParticles = [];  // { mesh, vel, life }
  // Simple object pools to reduce GC churn
  const exhaustPool = [];
  const impactPool = [];
  function acquireExhaustMesh(){
    const m = exhaustPool.pop();
    if (m) return m;
    return new THREE.Mesh(exhaustGeometry, makeAdditiveMaterial(0x66ccff, 0.7));
  }
  function releaseExhaustMesh(mesh){
    exhaustPool.push(mesh);
  }
  function acquireImpactMesh(baseColor){
    const m = impactPool.pop();
    if (m){ if (m.material && m.material.color) m.material.color.setHex(baseColor); return m; }
    const mat = makeAdditiveMaterial(baseColor, 0.95);
    return new THREE.Mesh(impactGeometry, mat);
  }
  function releaseImpactMesh(mesh){
    impactPool.push(mesh);
  }
  const exhaustGeometry = new THREE.SphereGeometry(0.18, 6, 6);
  const impactGeometry = new THREE.SphereGeometry(0.22, 6, 6);

  // Ring burst effect (used by several orbs/events)
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
    // Move the exhaust origin further back as speed rises to avoid a visible gap
    const backOffset = 1.6 + Math.min(8, speedUnitsPerSec * 0.04);
    const origin = new THREE.Vector3().copy(shipPosition)
      .addScaledVector(back, backOffset)
      .add(new THREE.Vector3(0,0.25,0).applyQuaternion(q));
    for (let i=0;i<count;i++){
      const p = acquireExhaustMesh();
      p.position.copy(origin).add(randomVel(0.4));
      p.scale.setScalar(0.6 + Math.random()*0.5);
      if (!p.parent) scene.add(p);
      // Give particles some ship velocity so the trail stays connected and smooth at high speeds
      const vel = new THREE.Vector3().copy(velocity)
        .add(back.clone().multiplyScalar(14 + speedUnitsPerSec*0.55))
        .add(randomVel(0.8));
      exhaustParticles.push({ mesh:p, vel, life: 0.5 + Math.random()*0.25 });
    }
  }

  function spawnImpactBurst(position, baseColor=0xffaa66, count=26){
    for (let i=0;i<count;i++){
      const p = acquireImpactMesh(baseColor);
      p.position.copy(position);
      p.scale.setScalar(0.7 + Math.random()*0.9);
      if (!p.parent) scene.add(p);
      const vel = randomVel(20);
      impactParticles.push({ mesh:p, vel, life: 0.6 + Math.random()*0.2 });
    }
    cameraShake += 0.6;
  }

  // Shield-specific explosion (green variants for pickup/shot)
  function spawnShieldExplosion(position, variant='pickup'){
    const mainColor = variant === 'shot' ? 0x99ffcc : 0x66ff99;
    const count = variant === 'shot' ? 16 : 28;
    for (let i=0;i<count;i++){
      const p = acquireImpactMesh(mainColor);
      p.position.copy(position);
      p.scale.setScalar(0.6 + Math.random()*1.0);
      if (!p.parent) scene.add(p);
      const vel = randomVel(variant === 'shot' ? 16 : 12);
      impactParticles.push({ mesh:p, vel, life: variant === 'shot' ? (0.45 + Math.random()*0.2) : (0.7 + Math.random()*0.25) });
    }
    spawnShieldRing(position, mainColor);
    cameraShake += (variant === 'shot' ? 0.25 : 0.15);
  }

  function shoot() {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const tipWorld = new THREE.Vector3().copy(shipPosition).add(dir.clone().multiplyScalar(1.8));

    if (fenixActive) {
      const beam = acquireFenixBeamMesh();
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
      beam.quaternion.copy(alignQuat);
      const halfLen = 6; // visual length only; reach is controlled by life * speed
      beam.position.copy(tipWorld).add(dir.clone().multiplyScalar(halfLen));
      if (!beam.parent) scene.add(beam);
      bullets.push({ mesh: beam, velocity: dir.multiplyScalar(FENIX_BEAM_SPEED), life: FENIX_BEAM_LIFE, radius: 0.45, kind:'fenix' });
    } else {
      const bullet = acquirePlayerBulletMesh();
      bullet.position.copy(tipWorld);
      if (!bullet.parent) scene.add(bullet);
      bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(DEFAULT_BULLET_SPEED), life: DEFAULT_BULLET_LIFE, radius: 0.25, kind:'player' });
    }
    cameraShake += 0.05;
    // Notify server for authoritative hitscan
    if (MP.ws && MP.ws.readyState === 1){
      try{ MP.ws.send(JSON.stringify({ type:'shoot', t: Date.now(), p:[tipWorld.x, tipWorld.y, tipWorld.z], dir:[dir.x, dir.y, dir.z], fenix: !!fenixActive })); }catch(_){ }
    }
  }

  // Inputs
  const input = { yawLeft:false, yawRight:false, pitchUp:false, pitchDown:false, speedUp:false, speedDown:false, fire:false, toggleLb:false };
  function onKeyDown(e){
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR','KeyT','KeyL'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    // Standard yaw: Left/A => yaw left, Right/D => yaw right
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = true;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = true;
    // Throttle on W/S
    if (c==='KeyW') input.speedUp = true;
    if (c==='KeyS') input.speedDown = true;
    // Standard pitch: Up/I => pitch up, Down/K => pitch down (mouse unchanged)
    if (c==='ArrowUp'||c==='KeyI') input.pitchUp = true;
    if (c==='ArrowDown'||c==='KeyK') input.pitchDown = true;
    if (c==='Space') input.fire = true;
    if (c==='KeyH') {
      const to = new THREE.Vector3().copy(targetPlanet.position).sub(shipPosition).normalize();
      yaw = Math.atan2(to.x, to.z);
      pitch = Math.asin(THREE.MathUtils.clamp(to.y, -1, 1));
      targetSpeedUnitsPerSec = Math.max(targetSpeedUnitsPerSec, 22);
    }
    if (c==='KeyT') {
      devTurboActive = !devTurboActive;
      if (devTurboActive){
        targetSpeedUnitsPerSec = DEV_TURBO_SPEED;
        spawnCenteredTextLabel('DEV 500', shipPosition, 0xffee88, 2.2, 1.4);
      } else {
        targetSpeedUnitsPerSec = Math.min(targetSpeedUnitsPerSec, baseMaxSpeed);
        spawnCenteredTextLabel('DEV OFF', shipPosition, 0xff8888, 2.0, 1.2);
      }
    }
    if (c==='KeyL') { input.toggleLb = true; renderLb(); ensureLbOverlay().style.display = (ensureLbOverlay().style.display==='none'?'block':'none'); }
    if (c==='KeyR' && gameOver) resetGame();
  }
  function onKeyUp(e){
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR','KeyT','KeyL'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = false;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = false;
    if (c==='KeyW') input.speedUp = false;
    if (c==='KeyS') input.speedDown = false;
    if (c==='ArrowUp'||c==='KeyI') input.pitchUp = false;
    if (c==='ArrowDown'||c==='KeyK') input.pitchDown = false;
    if (c==='Space') input.fire = false;
    if (c==='KeyL') input.toggleLb = false;
  }
  document.addEventListener('keydown', onKeyDown, { capture:true });
  document.addEventListener('keyup', onKeyUp, { capture:true });
  window.addEventListener('keydown', onKeyDown, { capture:true });
  window.addEventListener('keyup', onKeyUp, { capture:true });
  window.addEventListener('pointerdown', e => { if (e.target === canvas) { canvas.focus(); mouseDown = true; } }, { capture:true });
  window.addEventListener('pointerup', () => { mouseDown = false; });
  window.addEventListener('pointermove', e => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // HUD
  let score = 0;
  let killsCount = 0;
  let asteroidsDestroyed = 0;
  let beltTimeSec = 0;
  // Multipliers and belt scoring
  let asteroidMultTimer = 0; // seconds for x2 asteroid points
  let killMultTimer = 0;     // seconds for x2 kill points
  let lastFireTimer = 0;     // seconds since last shot
  let beltPassiveAccu = 0;   // fractional accumulator for passive belt points
  function updateHud() {
    const speedTxt = speedUnitsPerSec.toFixed(1);
    const distFromOrigin = shipPosition.length().toFixed(0);
    const distToTarget = shipPosition.distanceTo(targetPlanet.position).toFixed(0);
    const hp = Math.max(0, Math.round(health));
    const sh = Math.max(0, Math.round(shield));
    const ax2 = asteroidMultTimer>0 ? ` | Ax2 ${Math.ceil(asteroidMultTimer)}s` : '';
    const kx2 = killMultTimer>0 ? ` | Kx2 ${Math.ceil(killMultTimer)}s` : '';
    let mp = '';
    if (MP && MP.ws){
      const st = MP.ws.readyState;
      const status = st===1?`ON (${MP.remotes.size+1||1})`:(st===0? 'CONNECTING':'OFF');
      mp = ` | MP ${status}`;
    }
    hud.textContent = `Speed ${speedTxt} | HP ${hp}% | Shield ${sh}% | Points ${score} | Kills ${killsCount} | Ast ${asteroidsDestroyed}${ax2}${kx2} | Dist ${distFromOrigin} | Target ${distToTarget}${mp}`;
  }

  function showGameOver(){ gameOverEl.style.display = 'block'; }
  function hideGameOver(){ gameOverEl.style.display = 'none'; }

  // Leaderboards (local with optional server sync)
  let survivalStartMs = performance.now();
  let statsSaved = false;
  let serverAvailable = false;
  async function detectServer(){
    const defaultApi = `http://${location.hostname}:8787`;
    const url = window.ORBIT_RUNNER_API || defaultApi;
    try{ const r = await fetch(url + '/health', { method:'GET', mode:'cors' }); if (r.ok){ window.ORBIT_RUNNER_API = url; serverAvailable = true; } }
    catch(_){ serverAvailable = false; }
  }
  detectServer();

  // Identity (local only; for display on leaderboards)
  function getOrMakeUid(){
    let id = localStorage.getItem('or_uid');
    if (!id){ id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('or_uid', id); }
    return id;
  }
  function getPlayerName(){ return localStorage.getItem('or_name') || ''; }
  function ensurePlayerName(){
    let name = getPlayerName();
    if (!name){
      name = (window.prompt('Enter a display name for leaderboards:', '') || '').trim().slice(0,24);
      if (name) localStorage.setItem('or_name', name);
    }
    return name;
  }

  // Live server leaderboards via WebSocket
  let lbWs = null;
  let latestServerLB = null;
  function connectLbWS(){
    if (!serverAvailable || lbWs) return;
    try {
      const httpBase = window.ORBIT_RUNNER_API || `http://${location.hostname}:8787`;
      const wsUrl = httpBase.replace(/^http/, 'ws');
      lbWs = new WebSocket(wsUrl);
      lbWs.onmessage = (ev)=>{
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === 'leaderboards'){ latestServerLB = msg.payload; if (lbOverlay && lbOverlay.style.display !== 'none') renderLb(); }
        } catch(_){}
      };
      lbWs.onclose = ()=>{ lbWs = null; setTimeout(connectLbWS, 2000); };
      lbWs.onerror = ()=>{ try{ lbWs.close(); }catch(_){} };
    } catch(_){}
  }
  // try to connect shortly after detection
  setTimeout(connectLbWS, 500);
  
  // --- Multiplayer (input → server, binary state ← server) ---
  const MP = {
    active: false,
    ws: null,
    myId: null,
    myNumId: null,
    worldSeed: 0,
    serverOffsetMs: 0,
    serverOffsetEma: null,
    idToNum: new Map(), // string id -> numId
    remotes: new Map(), // numId -> { mesh, samples:[{t,p,q,v}], lastRender:{p,q} }
    selfServerState: null,
  };

  function vec3From(arr){ return new THREE.Vector3(arr[0]||0, arr[1]||0, arr[2]||0); }
  function quatFrom(arr){ return new THREE.Quaternion(arr[0]||0, arr[1]||0, arr[2]||0, arr[3]||1); }
  function lerpQuat(a, b, t){ return a.clone().slerp(b, t); }

  function createRemoteShip(numId){
    const m = buildDefaultShip();
    m.matrixAutoUpdate = true;
    scene.add(m);
    MP.remotes.set(numId, { mesh: m, samples: [], lastRender: { p: new THREE.Vector3(), q: new THREE.Quaternion() } });
  }
  function removeRemoteShipByNumId(numId){
    const r = MP.remotes.get(numId); if (!r) return;
    try { scene.remove(r.mesh); } catch(_){}
    MP.remotes.delete(numId);
  }

  async function handleMpMessage(ev){
    if (!ev || !ev.data) return;
    if (typeof ev.data !== 'string'){
      // Binary state buffer
      const buf = ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer();
      const dv = new DataView(buf);
      const BYTES_PER = 2 + 4 + 12 + 16 + 12 + 1;
      const count = Math.floor(dv.byteLength / BYTES_PER);
      let off = 0;
      const nowLocal = performance.now();
      for (let i=0;i<count;i++){
        const numId = dv.getUint16(off); off+=2;
        const t = dv.getUint32(off); off+=4;
        const p = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8)]; off+=12;
        const q = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8), dv.getFloat32(off+12)]; off+=16;
        const v = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8)]; off+=12;
        const flags = dv.getUint8(off); off+=1;
        // Estimate server time offset EMA
        const estOffset = (t - nowLocal);
        MP.serverOffsetEma = (MP.serverOffsetEma==null? estOffset : MP.serverOffsetEma*0.9 + estOffset*0.1);
        if (numId === MP.myNumId){
          MP.selfServerState = { t, p, q, v, flags };
          continue;
        }
        let r = MP.remotes.get(numId);
        if (!r){ createRemoteShip(numId); r = MP.remotes.get(numId); }
        const MAX_BUF = 30;
        r.samples.push({ t, p, q, v, flags });
        if (r.samples.length > MAX_BUF) r.samples.shift();
      }
      return;
    }
    // JSON control/event message
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome'){
        MP.active = true;
        MP.myId = msg.playerId;
        MP.worldSeed = msg.worldSeed;
        // Build id->num and remote meshes
        MP.idToNum.clear();
        for (const p of (msg.players||[])){
          if (p.id === msg.playerId){ MP.myNumId = p.numId; continue; }
          if (p.numId!=null){ MP.idToNum.set(p.id, p.numId); createRemoteShip(p.numId); }
        }
        return;
      }
      if (msg.type === 'respawn'){
        if (msg.id === MP.myId){
          const p = vec3From(msg.p), q = quatFrom(msg.q);
          shipPosition.copy(p); ship.position.copy(p);
          ship.quaternion.copy(q);
        } else {
          const numId = MP.idToNum.get(msg.id);
          const r = numId!=null ? MP.remotes.get(numId) : null;
          if (r){ r.mesh.position.copy(vec3From(msg.p)); r.mesh.quaternion.copy(quatFrom(msg.q)); r.samples.length = 0; }
        }
        return;
      }
      if (msg.type === 'hit'){
        if (msg.id === MP.myId){ cameraShake += 0.4; }
        return;
      }
      if (msg.type === 'player-add'){
        if (msg.id === MP.myId) return;
        if (msg.numId!=null){ MP.idToNum.set(msg.id, msg.numId); createRemoteShip(msg.numId); }
        return;
      }
      if (msg.type === 'player-remove'){
        const numId = MP.idToNum.get(msg.id);
        if (numId!=null){ removeRemoteShipByNumId(numId); MP.idToNum.delete(msg.id); }
        return;
      }
      if (msg.type === 'pong'){
        const nowLocal = performance.now();
        const rtt = nowLocal - msg.tClient;
        const estServerNow = msg.tServer + rtt*0.5;
        const estOffset = estServerNow - nowLocal;
        MP.serverOffsetEma = (MP.serverOffsetEma==null? estOffset : MP.serverOffsetEma*0.8 + estOffset*0.2);
        return;
      }
    } catch(_){}
  }

  function connectMP(){
    if (!serverAvailable || MP.ws) return;
    try {
      const httpBase = window.ORBIT_RUNNER_API || `http://${location.hostname}:8787`;
      const wsUrl = httpBase.replace(/^http/, 'ws') + '/mp';
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = ()=>{
        ws.send(JSON.stringify({ type:'hello', name: ensurePlayerName(), clientVersion: 'mp1' }));
      };
      ws.onmessage = handleMpMessage;
      ws.onclose = ()=>{ MP.ws = null; MP.active = false; setTimeout(connectMP, 1500); };
      ws.onerror = ()=>{ try{ ws.close(); }catch(_){} };
      MP.ws = ws;
    } catch(_){ /* ignore */ }
  }

  // Send inputs at 30 Hz
  setInterval(()=>{
    if (!MP.ws || MP.ws.readyState !== 1) return;
    const yawKeys = (input.yawRight?-1:0) + (input.yawLeft?1:0);
    const pitchKeys = (input.pitchUp?1:0) + (input.pitchDown?-1:0);
    const yawInput = yawKeys + (mouseDown ? mouseX*0.6 : 0);
    const pitchInput = pitchKeys + (mouseDown ? -mouseY*0.6 : 0);
    const throttle = THREE.MathUtils.clamp((targetSpeedUnitsPerSec - minSpeed) / (baseMaxSpeed - minSpeed), 0, 1);
    const msg = { type:'input', t: Date.now(), throttle, yaw: THREE.MathUtils.clamp(yawInput, -1, 1), pitch: THREE.MathUtils.clamp(pitchInput, -1, 1), roll: 0, boost: boostActive, fire: !!input.fire, fenix: !!fenixActive };
    try{ MP.ws.send(JSON.stringify(msg)); }catch(_){}
  }, 33);

  // Defer MP connect slightly after server detection
  setTimeout(connectMP, 800);

  // When MP becomes active (welcome), rebuild deterministic world
  const originalSeedAll = seedAllOrbsInRingByProportion;
  function rebuildWorldForMP(){
    if (!MP.active) return;
    // Reset world random and clear existing spawned collections
    setRand(MP.worldSeed>>>0);
    // Clear existing orbs and asteroids
    for (const a of asteroids){ scene.remove(a.mesh); }
    asteroids.length = 0;
    disposeRingInstancedGroups();
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } fenixOrbs.length = 0;
    for (const o of zaphireOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } zaphireOrbs.length = 0;
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;
    for (const o of minerOrbs) { scene.remove(o.core); scene.remove(o.ring); } minerOrbs.length = 0;
    for (const o of hunterOrbs) { scene.remove(o.core); scene.remove(o.ring); } hunterOrbs.length = 0;

    // Reseed deterministic world
    seedAsteroids(7000, 1400, new THREE.Vector3());
    createRings(targetPlanet, 3600, 5200, 13000);
    buildRingInstancedGroups(3);
    seedAllOrbsInRingByProportion(targetPlanet, 3600, 5200);
  }

  // Hook welcome to trigger rebuild
  const prevHandleMpMessage = handleMpMessage;
  handleMpMessage = async function(ev){
    const wasActive = MP.active;
    await prevHandleMpMessage(ev);
    if (!wasActive && MP.active){ rebuildWorldForMP(); }
  };

  // Ping loop to estimate server offset (ms)
  setInterval(()=>{
    if (!MP.ws || MP.ws.readyState!==1) return;
    try{ MP.ws.send(JSON.stringify({ type:'ping', t: performance.now() })); }catch(_){ }
  }, 1000);

  // Reconcile local player gently to server truth when drift is large
  function reconcileSelf(dt){
    if (!MP.active || !MP.selfServerState) return;
    const s = MP.selfServerState;
    const sp = vec3From(s.p);
    const sq = quatFrom(s.q);
    const posErr = shipPosition.distanceTo(sp);
    if (posErr > 6){ // snap if way off
      shipPosition.copy(sp); ship.position.copy(sp); ship.quaternion.copy(sq);
      yaw = 0; pitch = 0; // allow controls to rebuild
      return;
    }
    if (posErr > 1){ // nudge toward server
      shipPosition.lerp(sp, Math.min(1, dt*2)); ship.position.copy(shipPosition);
      ship.quaternion.slerp(sq, Math.min(1, dt*2));
    }
  }
  function getSessionStats(){
    const now = performance.now();
    const survivalSec = Math.max(0, Math.round((now - survivalStartMs)/1000));
    return {
      ts: Date.now(),
      uid: getOrMakeUid(),
      name: getPlayerName(),
      points: score,
      kills: killsCount,
      asteroids: asteroidsDestroyed,
      beltTimeSec: Math.round(beltTimeSec),
      survivalSec,
    };
  }
  function pushTop(list, rec, key, maxLen=10){
    list.push(rec); list.sort((a,b)=> (b[key]||0)-(a[key]||0)); if (list.length>maxLen) list.length=maxLen; return list;
  }
  function saveLeaderboards(){
    const s = getSessionStats();
    try{
      const parse = k => { const v = localStorage.getItem(k); return v? JSON.parse(v): []; };
      const save  = (k,arr)=> localStorage.setItem(k, JSON.stringify(arr));
      save('or_sessions', pushTop(parse('or_sessions'), s, 'ts', 50));
      save('or_lb_points', pushTop(parse('or_lb_points'), s, 'points'));
      save('or_lb_kills', pushTop(parse('or_lb_kills'), s, 'kills'));
      save('or_lb_asteroids', pushTop(parse('or_lb_asteroids'), s, 'asteroids'));
      save('or_lb_belt', pushTop(parse('or_lb_belt'), s, 'beltTimeSec'));
      save('or_lb_survival', pushTop(parse('or_lb_survival'), s, 'survivalSec'));
      // fire-and-forget sync endpoint if configured
      if (window.ORBIT_RUNNER_API){
        fetch(`${window.ORBIT_RUNNER_API}/submit`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(s) }).catch(()=>{});
      }
    }catch(e){ console.warn('Leaderboard save failed', e); }
  }

  // Simple overlay to view top 5 leaderboards
  let lbOverlay = null;
  function ensureLbOverlay(){
    if (lbOverlay) return lbOverlay;
    const d = document.createElement('div');
    d.id = 'leaderboards';
    Object.assign(d.style, { position:'absolute', right:'10px', top:'10px', padding:'10px', background:'rgba(0,0,0,0.6)', color:'#fff', fontSize:'12px', border:'1px solid rgba(255,255,255,0.2)', borderRadius:'8px', maxWidth:'360px', display:'none', zIndex:'9998' });
    document.body.appendChild(d); lbOverlay = d; return d;
  }
  async function renderLb(){
    ensureLbOverlay();
    const get = k => { const v = localStorage.getItem(k); return v? JSON.parse(v): []; };
    const fmt = (s)=> new Date(s.ts).toLocaleTimeString();
    const rows = (arr,key,unit='')=> arr.slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')} • ${fmt(r)}</div>`).join('') || '<div>—</div>';
    let html = `
      <div style="font-weight:700;margin-bottom:6px">Leaderboards (Top 5)</div>
      <div><b>Survival</b>${rows(get('or_lb_survival'),'survivalSec','s')}</div>
      <div><b>Kills</b>${rows(get('or_lb_kills'),'kills')}</div>
      <div><b>Asteroids</b>${rows(get('or_lb_asteroids'),'asteroids')}</div>
      <div><b>Belt Time</b>${rows(get('or_lb_belt'),'beltTimeSec','s')}</div>
      <div><b>Points</b>${rows(get('or_lb_points'),'points')}</div>
    `;
    if (serverAvailable){
      if (latestServerLB){
        const rrows = (arr,key,unit='')=> (arr||[]).slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')}</div>`).join('') || '<div>—</div>';
        html += `
          <div style=\"margin-top:8px;font-weight:700\">Server (live)</div>
          <div><b>Survival</b>${rrows(latestServerLB.survival,'survivalSec','s')}</div>
          <div><b>Kills</b>${rrows(latestServerLB.kills,'kills')}</div>
          <div><b>Asteroids</b>${rrows(latestServerLB.asteroids,'asteroids')}</div>
          <div><b>Belt Time</b>${rrows(latestServerLB.belt,'beltTimeSec','s')}</div>
          <div><b>Points</b>${rrows(latestServerLB.points,'points')}</div>
        `;
      } else {
      try{
        const r = await fetch(window.ORBIT_RUNNER_API + '/leaderboards', { mode:'cors' });
        if (r.ok){
          const data = await r.json();
          const rrows = (arr,key,unit='')=> (arr||[]).slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')}</div>`).join('') || '<div>—</div>';
          html += `
            <div style=\"margin-top:8px;font-weight:700\">Server</div>
            <div><b>Survival</b>${rrows(data.survival,'survivalSec','s')}</div>
            <div><b>Kills</b>${rrows(data.kills,'kills')}</div>
            <div><b>Asteroids</b>${rrows(data.asteroids,'asteroids')}</div>
            <div><b>Belt Time</b>${rrows(data.belt,'beltTimeSec','s')}</div>
            <div><b>Points</b>${rrows(data.points,'points')}</div>
          `;
        }
      }catch(_){ /* ignore */ }
      }
    }
    lbOverlay.innerHTML = html;
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
    const items = [
      { key:'hp', label:'HP +100% (Cost: 1500)', cost:1500, action: () => { health = 100; } },
      { key:'fenix', label:'Fenix Upgrade (Cost: 2000)', cost:2000, action: () => { transformToFenixShip(); } },
      { key:'shield', label:'Shield +100% (Cost: 1000)', cost:1000, action: () => { shield = 100; } },
    ];
    items.forEach(entry => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.gap = '10px';
      const span = document.createElement('span'); span.textContent = entry.label;
      const buy = document.createElement('button'); buy.textContent = 'Buy';
      Object.assign(buy.style, { padding:'4px 10px', border:'none', borderRadius:'6px', cursor:'pointer', background:'rgba(0,255,180,0.25)', color:'#fff' });
      buy.onclick = () => {
        if (score >= entry.cost){
          score -= entry.cost;
          entry.action();
          updateHud();
          hideStoreOverlay();
        } else {
          buy.textContent = 'Not enough points';
          setTimeout(()=>{ buy.textContent = 'Buy'; }, 1200);
        }
      };
      li.append(span, buy); list.appendChild(li);
    });

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
  function rebuildStoreOverlay(){ if (storeOverlay){ try { document.body.removeChild(storeOverlay); } catch(_){} storeOverlay = null; } ensureStoreOverlay(); }
  function showStoreOverlay(){ rebuildStoreOverlay(); storeOverlay.style.display = 'block'; }
  function hideStoreOverlay(){ if (storeOverlay) storeOverlay.style.display = 'none'; }

  // Population/field maintenance
  function keepFieldPopulated() {
    const maxDist = 16000;
    for (let i = asteroids.length - 1; i >= 0; i--) {
      const a = asteroids[i];
      if (!a.inRing && a.mesh.position.distanceTo(shipPosition) > maxDist) {
        scene.remove(a.mesh);
        asteroids.splice(i,1);
      }
    }

    const distToPlanet = shipPosition.distanceTo(targetPlanet.position);
    const t = THREE.MathUtils.clamp(1 - (distToPlanet / 22000), 0, 1);
    const desiredAmbient = Math.floor(7000 + t * 7000);
    let ambientCount = 0; for (const a of asteroids) if (!a.inRing) ambientCount++;
    while (ambientCount < desiredAmbient) { spawnAsteroidAround(shipPosition, 800, 11000); ambientCount++; }

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

    const desiredOrbs = Math.min(CAPS.shield, Math.max(12, Math.floor(asteroids.length * 0.05)));
    for (let i = shieldOrbs.length - 1; i >= 0; i--){
      const o = shieldOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); shieldOrbs.splice(i,1); }
    }
    while (shieldOrbs.length < desiredOrbs) spawnShieldOrbAround(shipPosition);

    const desiredPink = Math.min(CAPS.pink, Math.max(6, Math.floor(asteroids.length * 0.01)));
    for (let i = pinkOrbs.length - 1; i >= 0; i--){
      const o = pinkOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); pinkOrbs.splice(i,1); }
    }
    while (pinkOrbs.length < desiredPink) spawnPinkOrbAround(shipPosition);

    const desiredFenix = Math.min(CAPS.fenix, Math.max(20, Math.floor(asteroids.length * 0.10)));
    for (let i = fenixOrbs.length - 1; i >= 0; i--){
      const o = fenixOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ if (o.glow) scene.remove(o.glow); scene.remove(o.mesh); fenixOrbs.splice(i,1); }
    }
    while (fenixOrbs.length < desiredFenix) spawnFenixOrbAround(shipPosition);

    const desiredZaphire = Math.min(CAPS.zaphire, Math.max(40, Math.floor(asteroids.length * 0.20)));
    for (let i = zaphireOrbs.length - 1; i >= 0; i--){
      const o = zaphireOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ if (o.glow) scene.remove(o.glow); scene.remove(o.mesh); zaphireOrbs.splice(i,1); }
    }
    while (zaphireOrbs.length < desiredZaphire) spawnZaphireOrbAround(shipPosition);

    const desiredWormholes = Math.min(CAPS.wormhole, Math.max(40, Math.floor(asteroids.length * 0.20)));
    for (let i = wormholeOrbs.length - 1; i >= 0; i--){
      const w = wormholeOrbs[i];
      if (!w.mesh.parent || w.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); wormholeOrbs.splice(i,1); }
    }
    while (wormholeOrbs.length < desiredWormholes) spawnWormholeOrbAround(shipPosition);

    const desiredBoost = Math.min(CAPS.boost, Math.max(30, Math.floor(asteroids.length * 0.15)));
    for (let i = boostOrbs.length - 1; i >= 0; i--){
      const o = boostOrbs[i];
      if (!o.core.parent || o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); boostOrbs.splice(i,1); }
    }

    // clean multiplier orbs
    for (let i = minerOrbs.length - 1; i >= 0; i--){ const o = minerOrbs[i]; if (!o.core.parent) { minerOrbs.splice(i,1); continue; } if (o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ring); minerOrbs.splice(i,1);} }
    for (let i = hunterOrbs.length - 1; i >= 0; i--){ const o = hunterOrbs[i]; if (!o.core.parent) { hunterOrbs.splice(i,1); continue; } if (o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ring); hunterOrbs.splice(i,1);} }
    while (boostOrbs.length < desiredBoost) spawnBoostOrbAround(shipPosition);

    ensurePatches();
  }

  function applyCrashDamage(type, hitPosition){
    if (damageCooldown > 0 || gameOver) return;
    const dmgFactor = (type === 'asteroid' && fenixActive) ? 0.5 : 1.0;
    if (type === 'asteroid'){
      const healthDamage = (45 + Math.random()*30) * dmgFactor;
      const shieldDamage = (22 + Math.random()*22) * dmgFactor;
      if (shield > 0){ shield = Math.max(0, shield - shieldDamage); }
      health = Math.max(0, health - healthDamage);
      spawnImpactBurst(hitPosition || shipPosition);
      cameraShake += 0.4;
    } else if (type === 'planet'){
      health = 0; spawnImpactBurst(hitPosition || shipPosition, 0xff7766, 40); cameraShake += 1.2;
    }
    damageCooldown = 0.6;
    if (health <= 0){
      gameOver = true;
      try { if (!statsSaved){ saveLeaderboards(); statsSaved = true; } } catch(_){}
      showGameOver();
    }
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
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;
    patches.length = 0;

    scene.remove(ship); ship = buildDefaultShip(); scene.add(ship);

    health = 100; shield = 0; score = 0; gameOver = false; hideGameOver();
    fenixActive = false; boostActive = false; boostTimer = 0;
    yaw = 0; pitch = 0; roll = 0; speedUnitsPerSec = 20; targetSpeedUnitsPerSec = 20;
    shipPosition.set(0,0,0); velocity.set(0,0,0);

    seedAsteroids(7000, 1400, shipPosition);
    createRings(targetPlanet, 3600, 5200, 13000);
    // Focus orb population into the planet ring with proportional counts
    seedAllOrbsInRingByProportion(targetPlanet, 3600, 5200);
  }

  let fireCooldown = 0;
  let frameCounter = 0; // used to throttle heavy updates
  const clock = new THREE.Clock();

  function animate(){
    const dt = Math.min(0.033, clock.getDelta());

    if (!gameOver){
      if (damageCooldown > 0) damageCooldown -= dt;
      if (boostActive){
        boostTimer -= dt;
        if (boostTimer <= 0){ boostActive = false; }
      }

      let effectiveMaxSpeed = devTurboActive ? DEV_TURBO_SPEED : (fenixActive ? 80 : baseMaxSpeed);
      if (boostActive && !devTurboActive) effectiveMaxSpeed *= 3.08; // boost speed reduced by ~30%
      // If boost just ended, ensure our target is clamped to non-boost top speed
      if (!boostActive) targetSpeedUnitsPerSec = Math.min(targetSpeedUnitsPerSec, effectiveMaxSpeed);

      if (input.speedUp) targetSpeedUnitsPerSec = Math.min(effectiveMaxSpeed, targetSpeedUnitsPerSec + 22*dt);
      if (input.speedDown) targetSpeedUnitsPerSec = Math.max(minSpeed, targetSpeedUnitsPerSec - 22*dt);
      if (boostActive || devTurboActive) targetSpeedUnitsPerSec = effectiveMaxSpeed;

      speedUnitsPerSec += (targetSpeedUnitsPerSec - speedUnitsPerSec) * Math.min(1, boostActive ? 10*dt : 6*dt);
      const fovKick = boostActive ? 10 : 0;
      const fovTarget = baseFov + THREE.MathUtils.clamp((speedUnitsPerSec-14)*0.7 + fovKick, 0, 28);
      camera.fov += (fovTarget - camera.fov) * Math.min(1, 6*dt);
      camera.updateProjectionMatrix();

      // Keyboard yaw/pitch: Left/A => yaw left; Right/D => yaw right. Up/I => pitch up; Down/K => pitch down.
      // Direct, explicit mapping with no extra signs
      // Left/A should turn left; Right/D should turn right
      const yawKeys = (input.yawRight?-1:0) + (input.yawLeft?1:0);
      // Up/I -> positive pitch (nose up), Down/K -> negative pitch (nose down)
      const pitchKeys = (input.pitchUp?1:0) + (input.pitchDown?-1:0);
      const yawInput = yawKeys + (mouseDown ? mouseX*0.6 : 0);
      const pitchInput = pitchKeys + (mouseDown ? -mouseY*0.6 : 0);
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
      if (input.fire && fireCooldown <= 0){ shoot(); fireCooldown = 0.11; lastFireTimer = 0; }
    }

    // decrement timers
    if (asteroidMultTimer > 0) asteroidMultTimer = Math.max(0, asteroidMultTimer - dt);
    if (killMultTimer > 0) killMultTimer = Math.max(0, killMultTimer - dt);
    lastFireTimer += dt;

    // passive belt points
    if (!gameOver && isWithinBeltXZ(shipPosition)){
      const rate = lastFireTimer < 10 ? 2 : 1; // 2/sec during recent combat, else 1/sec
      beltPassiveAccu += rate * dt;
      if (beltPassiveAccu >= 1){
        const add = Math.floor(beltPassiveAccu);
        score += add;
        beltPassiveAccu -= add;
      }
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
      b.life -= dt; if (b.life <= 0){
        scene.remove(b.mesh);
        if (b.kind==='player') releasePlayerBulletMesh(b.mesh);
        else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
        bullets.splice(i,1); continue;
      }
      b.mesh.position.addScaledVector(b.velocity, dt);
    }

    // Update asteroids; build spatial hash for broad-phase
    const hash = USE_SPATIAL_HASH ? new SpatialHash(120) : null;
    outer: for (let i = asteroids.length-1; i>=0; i--){
      const a = asteroids[i];
      if (a.inRing){
        // Smooth per-frame update to eliminate visible jitter
        a.orbitAngle += a.orbitSpeed * dt;
        const x = targetPlanet.position.x + Math.cos(a.orbitAngle) * a.orbitRadius;
        const z = targetPlanet.position.z + Math.sin(a.orbitAngle) * a.orbitRadius;
        a.mesh.position.set(x, a.mesh.position.y, z);
        // Update instanced matrix for its group
        if (a.instanceGroup>=0 && a.instanceId>=0){
          const im = ringInstancedGroups[a.instanceGroup];
          if (im){
            instTmp.position.copy(a.mesh.position);
            instTmp.rotation.set(0,0,0);
            instTmp.scale.set(a.scale, a.scale, a.scale);
            instTmp.updateMatrix();
            im.setMatrixAt(a.instanceId, instTmp.matrix);
            im.instanceMatrix.needsUpdate = true;
          }
        }
        } else {
        a.mesh.position.addScaledVector(a.vel, dt);
      }
      if (a.rotAxis && a.rotSpeed) a.mesh.rotateOnAxis(a.rotAxis, a.rotSpeed*dt);
      if (hash) hash.insert({ i, a }, a.mesh.position);

      if (a.nearMissCooldown > 0) a.nearMissCooldown -= dt;
      const nearMissDist = a.radius + 3.2;
      if (isWithinRadiusSquared(a.mesh.position, shipPosition, nearMissDist) && a.nearMissCooldown <= 0){
        spawnImpactBurst(a.mesh.position, 0x66ccff, 10); cameraShake += 0.25; a.nearMissCooldown = 1.2;
      }

      if (!gameOver && isWithinRadiusSquared(a.mesh.position, shipPosition, a.radius + shipHitRadius)){
        applyCrashDamage('asteroid', a.mesh.position);
        if (a.instanceGroup>=0 && a.instanceId>=0){
          const im = ringInstancedGroups[a.instanceGroup];
          if (im){
            instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
            im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
          }
        }
        scene.remove(a.mesh); asteroids.splice(i,1);
        break outer;
      }

      if (!hash){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(a.mesh.position, b.mesh.position, a.radius + b.radius)){
            spawnImpactBurst(a.mesh.position);
            if (a.instanceGroup>=0 && a.instanceId>=0){
              const im = ringInstancedGroups[a.instanceGroup];
              if (im){
                instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
                im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
              }
            }
            scene.remove(a.mesh); asteroids.splice(i,1);
            scene.remove(b.mesh);
            if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
            bullets.splice(j,1);
            score += getAsteroidScore(a.inRing ? 160 : 110, a.mesh.position);
            asteroidsDestroyed++;
            break outer;
          }
        }
      }
    }

    if (hash){
      for (let j = bullets.length-1; j>=0; j--){
        const b = bullets[j];
        const near = hash.query(b.mesh.position, 200);
        for (let k=0;k<near.length;k++){
          const { i, a } = near[k]; if (!asteroids[i]) continue;
           if (isWithinRadiusSquared(a.mesh.position, b.mesh.position, a.radius + b.radius)){
             spawnImpactBurst(a.mesh.position);
             // Hide instance immediately
             if (a.instanceGroup>=0 && a.instanceId>=0){
               const im = ringInstancedGroups[a.instanceGroup];
               if (im){
                 instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
                 im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
               }
             }
             scene.remove(a.mesh); asteroids.splice(i,1);
            scene.remove(b.mesh);
            if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
            bullets.splice(j,1);
            score += getAsteroidScore(a.inRing ? 160 : 110, a.mesh.position);
            asteroidsDestroyed++;
            break;
          }
        }
      }
    }

    // Shield orbs
    for (let i = shieldOrbs.length-1; i>=0; i--){
      const o = shieldOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.2 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.7 + 0.3 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          shield = Math.min(100, shield + 25);
          spawnShieldExplosion(o.mesh.position, 'pickup');
          scene.remove(o.mesh); shieldOrbs.splice(i,1); continue;
        }
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            shield = Math.min(100, shield + 25);
            spawnShieldText(o.mesh.position);
            spawnShieldExplosion(o.mesh.position, 'shot');
            scene.remove(o.mesh); shieldOrbs.splice(i,1);
            scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Pink orbs
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
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); continue;
        }
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Fenix orbs
    for (let i = fenixOrbs.length-1; i>=0; i--){
      const o = fenixOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.03;
      const pulse = 1 + 0.32 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      if (o.glow){ o.glow.scale.setScalar(14 + 7*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed))); o.glow.material.opacity = 0.85 + 0.12*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/8)); }
      o.mesh.material.opacity = 0.9 + 0.1 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.7*dt;

      if (!gameOver){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
           if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            spawnFenixLabel(o.mesh.position);
            spawnImpactBurst(o.mesh.position, 0xffaa55, 24);
            spawnShieldRing(o.mesh.position, 0xffaa55);
            transformToFenixShip();
            if (o.glow) scene.remove(o.glow);
            scene.remove(o.mesh); fenixOrbs.splice(i,1);
             scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Zaphire orbs (Store)
    for (let i = zaphireOrbs.length-1; i>=0; i--){
      const o = zaphireOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.03;
      const pulse = 1 + 0.28 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      if (o.glow){
        o.glow.scale.setScalar(14 + 6*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed)));
        o.glow.material.opacity = 0.85 + 0.1*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/6));
      }
      o.mesh.material.opacity = 0.9 + 0.1 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        // Fly-through opens store and removes both core and glow
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          spawnCenteredTextLabel('STORE', o.mesh.position, 0xffeeee, 2.8, 2.2);
          spawnImpactBurst(o.mesh.position, 0xff6666, 26);
          spawnShieldRing(o.mesh.position, 0xff6666);
          showStoreOverlay();
          if (o.glow) scene.remove(o.glow);
          scene.remove(o.mesh); zaphireOrbs.splice(i,1);
          continue;
        }
        // Shot also opens store and cleans up glow + core
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
            if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            spawnCenteredTextLabel('STORE', o.mesh.position, 0xffeeee, 2.8, 2.2);
            spawnImpactBurst(o.mesh.position, 0xff6666, 26);
            spawnShieldRing(o.mesh.position, 0xff6666);
            showStoreOverlay();
            if (o.glow) scene.remove(o.glow);
            scene.remove(o.mesh); zaphireOrbs.splice(i,1);
            scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Boost orbs (grant super speed 3–6s)
    for (let i = boostOrbs.length-1; i>=0; i--){
      const o = boostOrbs[i];
      o.bob += o.bobSpeed * dt;
      const puls = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(puls);
      o.ringG.lookAt(camera.position);
      o.ringP.lookAt(camera.position);
      o.ringG.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      o.ringP.material.opacity = 0.4 + 0.3 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/3));
      if (o.glow){ o.glow.scale.setScalar(9 + 3*(0.5 + 0.5*Math.sin(o.bob*o.pulseSpeed))); o.glow.material.color.setHex(0x66ddff); o.glow.material.opacity = 0.6 + 0.25*(0.5 + 0.5*Math.sin(o.bob*o.pulseSpeed + Math.PI/5)); }

      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 5.0; // extra generous radius for reliable activation
        const triggerBoost = () => {
          boostActive = true; boostTimer = 3 + Math.random()*3;
          spawnCenteredTextLabel('Boost', o.core.position, 0x99ff66, 2.2, 3.0);
          spawnShieldRing(o.core.position, 0x99ff66);
          spawnImpactBurst(o.core.position, 0xaa55ff, 18);
          cameraShake += 0.3;
          scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); boostOrbs.splice(i,1);
        };
        // Pickup
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){
          triggerBoost(); continue;
        }
        // Shot
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){
            triggerBoost(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Miner orbs (x2 asteroid points)
    for (let i = minerOrbs.length-1; i>=0; i--){
      const o = minerOrbs[i];
      o.bob += o.bobSpeed * dt;
      const s = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(s);
      o.ring.lookAt(camera.position);
      o.ring.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 3.0;
        const trigger = () => {
          asteroidMultTimer = Math.min(60, Math.max(asteroidMultTimer, 30));
          spawnShieldRing(o.core.position, 0x66ff99);
          spawnImpactBurst(o.core.position, 0x66ff99, 16);
          scene.remove(o.core); scene.remove(o.ring); minerOrbs.splice(i,1);
        };
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){ trigger(); continue; }
        for (let j = bullets.length-1; j>=0; j--){ const b = bullets[j]; if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){ trigger(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break; } }
      }
    }

    // Hunter orbs (x2 kill points)
    for (let i = hunterOrbs.length-1; i>=0; i--){
      const o = hunterOrbs[i];
      o.bob += o.bobSpeed * dt;
      const s = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(s);
      o.ring.lookAt(camera.position);
      o.ring.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 3.0;
        const trigger = () => {
          killMultTimer = Math.min(60, Math.max(killMultTimer, 30));
          spawnShieldRing(o.core.position, 0x66aaff);
          spawnImpactBurst(o.core.position, 0x66aaff, 16);
          scene.remove(o.core); scene.remove(o.ring); hunterOrbs.splice(i,1);
        };
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){ trigger(); continue; }
        for (let j = bullets.length-1; j>=0; j--){ const b = bullets[j]; if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){ trigger(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break; } }
      }
    }

    // Wormhole orbs (teleport)
    for (let i = wormholeOrbs.length-1; i>=0; i--){
      const w = wormholeOrbs[i];
      w.bob += w.bobSpeed * dt;
      const s = 1 + 0.25 * Math.sin(w.bob * w.pulseSpeed);
      w.mesh.scale.setScalar(s);
      w.halo.lookAt(camera.position);
      w.halo.material.opacity = 0.45 + 0.35 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed));
      if (w.glow){ w.glow.scale.setScalar(10 + 4 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed))); w.glow.material.opacity = 0.65 + 0.25 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed + Math.PI/4)); }
      // Mirror reflection only when close
      const dist = w.mesh.position.distanceTo(shipPosition);
      const intensity = THREE.MathUtils.clamp(1 - (dist-60)/180, 0, 1); // ramps within ~60..240m
      w.coreMat.envMapIntensity = intensity;
      if (intensity > 0.02){
        const now = performance.now() * 0.001;
        if (now - w.lastCubeUpdate > 0.25){
          const prevVis = w.mesh.visible; w.mesh.visible = false; // avoid self-capture
          w.cubeCam.position.copy(w.mesh.position);
          w.cubeCam.update(renderer, scene);
          w.mesh.visible = prevVis;
          w.lastCubeUpdate = now;
        }
      }

      if (!gameOver){
        const tryTeleport = ()=>{
          // Choose a destination at least 12 km away from the source
          const srcPos = w.mesh.position;
          const farCandidates = wormholeOrbs.filter(o => o !== w && o.mesh.position.distanceTo(srcPos) >= MIN_WORMHOLE_TELEPORT_DIST);
          let destPos;
          if (farCandidates.length > 0){
            const picked = farCandidates[Math.floor(Math.random()*farCandidates.length)];
            destPos = picked.mesh.position.clone();
          } else {
            const rnd = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize();
            const dist = MIN_WORMHOLE_TELEPORT_DIST + Math.random()*8000; // 12–20 km
            destPos = srcPos.clone().add(rnd.multiplyScalar(dist));
          }
          const local = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize().multiplyScalar(150 + Math.random()*250);
          shipPosition.copy(destPos).add(local);
          ship.position.copy(shipPosition);
          cameraShake += 1.0; spawnShieldRing(destPos, 0xffffff);
          scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); wormholeOrbs.splice(i,1);
        };
        // Fly-through activation
        if (isWithinRadiusSquared(w.mesh.position, shipPosition, w.radius + pickupHitRadius)){
          tryTeleport(); continue;
        }
        // Shot activation
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(w.mesh.position, b.mesh.position, w.radius + b.radius)){
            tryTeleport(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // 3D text labels update
    for (let i = shieldTextLabels.length-1; i>=0; i--){
      const lbl = shieldTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){ scene.remove(lbl.mesh); shieldTextLabels.splice(i,1); continue; }
      lbl.mesh.lookAt(camera.position);
      if (lbl.life < 0.8){ const mat = lbl.mesh.material; mat.opacity = Math.max(0, lbl.life / 0.8); }
    }
    for (let i = duendeTextLabels.length-1; i>=0; i--){
      const lbl = duendeTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){ scene.remove(lbl.group); duendeTextLabels.splice(i,1); continue; }
      if (lbl.group.lookAt) lbl.group.lookAt(camera.position);
      if (lbl.life < 0.8){
        if (lbl.group.traverse){ lbl.group.traverse(obj => { if (obj.material && obj.material.opacity !== undefined){ obj.material.opacity = Math.max(0, lbl.life / 0.8); } }); }
        else { const mat = lbl.group.material; if (mat && mat.opacity!==undefined) mat.opacity = Math.max(0, lbl.life / 0.8); }
      }
    }

    // Planet crash check + belt time accumulation
    if (!gameOver){
      for (const p of planets){
        const d = shipPosition.distanceTo(p.position);
        if (d < (p.userData.radius + 20)) { applyCrashDamage('planet', shipPosition); break; }
      }
      if (isWithinBeltXZ(shipPosition)) beltTimeSec += dt;
    }

    // Particles update
    for (let i = exhaustParticles.length-1; i>=0; i--){
      const p = exhaustParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); releaseExhaustMesh(p.mesh); exhaustParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      const s2 = Math.max(0.1, p.mesh.scale.x * (1 - 2.2*dt));
      p.mesh.scale.setScalar(s2);
      const mat = p.mesh.material; mat.opacity = Math.max(0, mat.opacity - 1.6*dt);
    }
    for (let i = impactParticles.length-1; i>=0; i--){
      const p = impactParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); releaseImpactMesh(p.mesh); impactParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 2.0*dt);
      const s3 = Math.max(0.05, p.mesh.scale.x * (1 - 1.8*dt));
      p.mesh.scale.setScalar(s3);
      const mat2 = p.mesh.material; mat2.opacity = Math.max(0, mat2.opacity - 2.8*dt);
    }

    // Animate ring bursts
    for (let i = ringBursts.length-1; i>=0; i--){
      const r = ringBursts[i];
      r.life -= dt; if (r.life <= 0){ scene.remove(r.mesh); ringBursts.splice(i,1); continue; }
      r.mesh.scale.x += r.growth * dt; r.mesh.scale.y += r.growth * dt;
      r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - r.fade * dt);
      r.mesh.lookAt(camera.position);
    }

    // Exhaust
    if (!gameOver) spawnExhaust(50 + speedUnitsPerSec*4, dt);

    // --- Bots update ---
    updateBots(dt);

    // Bot bullets -> player
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (b.owner === 'bot') {
        if (isWithinRadiusSquared(b.mesh.position, shipPosition, shipHitRadius + b.radius)) {
          if (!gameOver) {
            spawnImpactBurst(b.mesh.position);
            cameraShake += 0.25;
            const shieldDamage = 20, healthDamage = 12;
            if (shield > 0){ shield = Math.max(0, shield - shieldDamage); }
            health = Math.max(0, health - healthDamage);
            if (health <= 0){ gameOver = true; showGameOver(); }
          }
          scene.remove(b.mesh); bullets.splice(i, 1);
        }
      }
    }

    // Player bullets -> bots
    for (let bi = bots.length - 1; bi >= 0; bi--) {
      const bot = bots[bi];
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        if (b.owner !== 'bot') { // player's or fenix beams
          if (isWithinRadiusSquared(b.mesh.position, bot.pos, bot.radius + b.radius)) {
            spawnImpactBurst(bot.pos);
            scene.remove(bot.mesh); bots.splice(bi, 1);
            scene.remove(b.mesh); bullets.splice(i, 1);
            score += getKillScore(300, bot.pos); // base 300; belt & multipliers apply
            killsCount++;
            break;
          }
        }
      }
    }

    maintainPatches();
    keepFieldPopulated();
    updateHud();

    // Multiplayer: render remotes with 120ms interpolation buffer
    if (MP.active && MP.remotes.size){
      const renderNow = performance.now() + (MP.serverOffsetEma||0) - 120;
      for (const [numId, r] of MP.remotes){
        const s = r.samples;
        if (!s || s.length === 0) continue;
        // find two samples around renderNow
        let a = null, b = null;
        for (let i=0;i<s.length;i++){
          if (s[i].t <= renderNow) a = s[i];
          if (s[i].t > renderNow){ b = s[i]; break; }
        }
        if (!a) a = s[0]; if (!b) b = s[s.length-1];
        const ta = a.t, tb = Math.max(a.t+1, b.t);
        let t = (renderNow - ta) / (tb - ta);
        if (!Number.isFinite(t)) t = 1;
        t = THREE.MathUtils.clamp(t, 0, 1);
        const pa = vec3From(a.p), pb = vec3From(b.p);
        const qa = quatFrom(a.q), qb = quatFrom(b.q);
        let p = pa.lerp(pb, t);
        let q = lerpQuat(qa, qb, t);
        // If buffer underflow (renderNow beyond last sample), do a small extrapolation using last velocity
        if (renderNow > b.t + 16){
          const dtEx = Math.min(0.12, (renderNow - b.t)/1000);
          const vv = vec3From(b.v);
          p = vec3From(b.p).addScaledVector(vv, dtEx);
          q = qb; // keep last orientation
        }
        r.mesh.position.copy(p);
        r.mesh.quaternion.copy(q);
      }
    }

    // Reconcile self toward authoritative server state
    reconcileSelf(dt);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
    frameCounter++;
  }

  function onResize(){ const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w,h); camera.aspect = w/h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', onResize);
  onResize();
  animate();

  // --- Bots (AI players) ---
  // bots is declared early above to avoid TDZ errors
  const BOT_COUNT = 3;
  const BOT_FIRE_COOLDOWN = 0.45;
  const BOT_TURN_RATE = 1.2; // rad/s
  const BOT_PITCH_RATE = 0.9; // rad/s
  const BOT_SPEED = 20; // units/s
  const BOT_RANGE = 1400; // engage distance
  const BOT_SHOT_SPREAD = 0.02; // radians

  function tintShip(mesh, color = 0xff6666) {
    mesh.traverse?.(n => {
      if (n.isMesh && n.material) {
        if (Array.isArray(n.material)) n.material.forEach(m => { m.color?.setHex?.(color); m.emissive?.setHex?.(color); });
        else { n.material.color?.setHex?.(color); n.material.emissive?.setHex?.(color); }
      }
    });
  }

  function spawnBotAtPosition(pos) {
    const mesh = buildDefaultShip();
    tintShip(mesh, 0xff6666);
    mesh.position.copy(pos);
    scene.add(mesh);
    const bot = {
      mesh,
      pos: mesh.position,
      yaw: 0, pitch: 0, roll: 0,
      speed: BOT_SPEED,
      fireCooldown: 1.0 + Math.random()*0.5,
      radius: 1.8
    };
    // Face roughly toward player
    const toPlayer = new THREE.Vector3().copy(shipPosition).sub(bot.pos);
    bot.yaw = Math.atan2(toPlayer.x, toPlayer.z);
    bot.pitch = Math.atan2(-toPlayer.y, new THREE.Vector2(toPlayer.x, toPlayer.z).length());
    bots.push(bot);
  }

  function botShoot(bot) {
    // Simple blue-ish shot like player (not Fenix)
    const mat = new THREE.MeshStandardMaterial({ color: 0xff8866, emissive: 0xff6644, emissiveIntensity: 2.5 });
    const bullet = new THREE.Mesh(bulletGeometry, mat);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(bot.pitch, bot.yaw, bot.roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    // Apply slight random spread so it's not perfect aim
    const spread = BOT_SHOT_SPREAD;
    dir.applyAxisAngle(new THREE.Vector3(0,1,0), (Math.random()-0.5)*spread);
    dir.applyAxisAngle(new THREE.Vector3(1,0,0), (Math.random()-0.5)*spread);

    const tip = new THREE.Vector3().copy(bot.pos).add(dir.clone().multiplyScalar(1.8));
    bullet.position.copy(tip);
    scene.add(bullet);
    bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(DEFAULT_BULLET_SPEED), life: DEFAULT_BULLET_LIFE, radius: 0.25, owner: 'bot' });
  }

  function updateBots(dt) {
    for (let i = bots.length - 1; i >= 0; i--) {
      const b = bots[i];
      // Steering toward player
      const toPlayer = new THREE.Vector3().copy(shipPosition).sub(b.pos);
      const dist = toPlayer.length();
      if (dist < 0.001) continue;
      const desiredYaw = Math.atan2(toPlayer.x, toPlayer.z);
      const desiredPitch = Math.atan2(-toPlayer.y, new THREE.Vector2(toPlayer.x, toPlayer.z).length());

      // Shortest angle delta for yaw
      let dy = desiredYaw - b.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const dp = desiredPitch - b.pitch;

      const maxYawStep = BOT_TURN_RATE * dt;
      const maxPitchStep = BOT_PITCH_RATE * dt;

      b.yaw += THREE.MathUtils.clamp(dy, -maxYawStep, maxYawStep);
      b.pitch += THREE.MathUtils.clamp(dp, -maxPitchStep, maxPitchStep);

      // Move forward
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(b.pitch, b.yaw, b.roll, 'YXZ'));
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
      b.pos.addScaledVector(forward, b.speed * dt);
      b.mesh.quaternion.copy(q);

      // Fire when roughly aligned and in range
      b.fireCooldown -= dt;
      const facingDot = forward.dot(toPlayer.clone().normalize()); // 1 = directly at player
      if (dist < BOT_RANGE && facingDot > 0.985 && b.fireCooldown <= 0) {
        botShoot(b);
        b.fireCooldown = BOT_FIRE_COOLDOWN + Math.random()*0.2;
      }
    }
  }

  // Spawn initial bots around the player
  for (let i = 0; i < BOT_COUNT; i++) {
    const r = 1200 + Math.random()*1600;
    const theta = Math.random()*Math.PI*2;
    const phi = (Math.random()-0.5) * 0.6;
    const offset = new THREE.Vector3(
      r*Math.cos(theta)*Math.cos(phi),
      r*Math.sin(phi),
      r*Math.sin(theta)*Math.cos(phi)
    );
    spawnBotAtPosition(new THREE.Vector3().copy(shipPosition).add(offset));
  }

})();
