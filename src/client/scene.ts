// The picture: planet, stars, the own ship and the chase camera. It draws
// whatever the netcode says the ship's pose is; it decides nothing.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { ShipView } from '../net/client.ts';
import { SHIP_HULL_RADIUS, SIM } from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';

// Camera values are v1's.
const CAMERA_OFFSET = new Vector3(0, 3.7, -10.8); // main.js:4498
const LOOK_AHEAD = 20; // main.js:8875
const BASE_FOV = 70; // main.js:333
const FOV_SPEED_FLOOR = 14; // main.js:8729
const FOV_PER_SPEED = 0.7;
const FOV_BOOST_KICK = 10; // main.js:8726
const FOV_MAX_EXTRA = 28;
const FOV_FOLLOW = 6; // per second, main.js:8730
const MAX_PIXEL_RATIO = 1.75; // main.js:283

/** v1's saucer (main.js:4207-4275): matte disc, glowing dome, engine ring, rim lights. */
function buildSaucer(): Group {
  const group = new Group();
  const hull = new MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.1, roughness: 0.9 });

  const top = new SphereGeometry(SHIP_HULL_RADIUS, 24, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  top.scale(1, 0.3, 1);
  const bottom = new SphereGeometry(
    SHIP_HULL_RADIUS,
    24,
    8,
    0,
    Math.PI * 2,
    Math.PI * 0.5,
    Math.PI * 0.5,
  );
  bottom.scale(1, 0.25, 1);

  const dome = new Mesh(
    new SphereGeometry(0.6, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00cccc,
      emissiveIntensity: 2,
      metalness: 0.3,
      roughness: 0.1,
      transparent: true,
      opacity: 0.9,
    }),
  );
  dome.position.y = 0.3;

  const ring = new Mesh(
    new TorusGeometry(1.5, 0.1, 8, 24),
    new MeshStandardMaterial({
      color: 0x0099ff,
      emissive: 0x0066ff,
      emissiveIntensity: 3,
      metalness: 0.5,
      roughness: 0.3,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.1;

  const rimLight = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x00ffff,
    emissiveIntensity: 5,
  });
  const rimGeometry = new SphereGeometry(0.08, 8, 8);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const light = new Mesh(rimGeometry, rimLight);
    light.position.set(Math.cos(angle) * 1.8, 0, Math.sin(angle) * 1.8);
    group.add(light);
  }

  group.add(new Mesh(top, hull), new Mesh(bottom, hull), dome, ring);
  return group;
}

/** v1's starfield (main.js:4583-4603): 4,000 points in a shell 8,000 to 20,000 out. */
function buildStars(): Points {
  const count = 4000;
  const rng = new Rng(4000);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 8000 + rng.next() * 12000;
    const theta = rng.next() * Math.PI * 2;
    const phi = Math.acos(2 * rng.next() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return new Points(
    geometry,
    new PointsMaterial({
      color: 0x99ccff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
    }),
  );
}

export class GameScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly ship = buildSaucer();

  // Scratch objects, reused every frame.
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly orientation = new Quaternion();
  private readonly offset = new Vector3();
  private readonly forward = new Vector3();
  private readonly lookAt = new Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45; // main.js:287
    this.renderer.setClearColor(0x030a1a, 1); // main.js:288

    this.camera = new PerspectiveCamera(BASE_FOV, 1, 0.5, 60000);

    this.scene.add(new AmbientLight(0x708090, 0.6));
    const sun = new DirectionalLight(0xffffff, 1.1);
    sun.position.set(1000, 1500, 800); // main.js:347
    this.scene.add(sun);

    // The planet at the origin (main.js:4524).
    const planet = new Mesh(
      new SphereGeometry(SIM.planetRadius, 64, 64),
      new MeshStandardMaterial({
        color: 0x3355aa,
        emissive: 0x3355aa,
        emissiveIntensity: 0.22,
        metalness: 0.1,
        roughness: 0.85,
      }),
    );
    this.scene.add(planet, buildStars(), this.ship);

    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  /** Draws one frame. `elapsedSeconds` is real time since the previous frame. */
  render(view: ShipView, elapsedSeconds: number): void {
    // The ship's orientation is yaw, then pitch, then roll (main.js:8835).
    this.euler.set(view.pitch, view.yaw, view.roll, 'YXZ');
    this.orientation.setFromEuler(this.euler);
    this.ship.position.set(view.x, view.y, view.z);
    this.ship.quaternion.copy(this.orientation);
    this.ship.visible = view.alive;

    // Rigid chase camera: a fixed offset in the ship's frame, looking at a
    // point ahead of the nose (main.js:8863-8875).
    this.offset.copy(CAMERA_OFFSET).applyQuaternion(this.orientation);
    this.camera.position.copy(this.ship.position).add(this.offset);
    this.forward.set(0, 0, 1).applyQuaternion(this.orientation);
    this.lookAt.copy(this.ship.position).addScaledVector(this.forward, LOOK_AHEAD);
    this.camera.lookAt(this.lookAt);

    // Field of view widens with speed (main.js:8726-8730). v1 moved 6·dt of
    // the way each frame; this is the same response at any frame rate.
    const extra =
      (view.speed - FOV_SPEED_FLOOR) * FOV_PER_SPEED + (view.boosting ? FOV_BOOST_KICK : 0);
    const target = BASE_FOV + Math.max(0, Math.min(FOV_MAX_EXTRA, extra));
    this.camera.fov += (target - this.camera.fov) * (1 - Math.exp(-FOV_FOLLOW * elapsedSeconds));
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
