// The picture: planet, stars, ships, bullets and the chase camera. It draws
// whatever the netcode says is where; it decides nothing.

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
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
import type { BulletView, ShipView } from '../net/client.ts';
import type { RemoteView } from '../net/remotes.ts';
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

/** v1 draws other players' ships half as big again as its own (main.js:6836). */
const REMOTE_SHIP_SCALE = 1.5;

const MAX_BULLETS = 512;
const MAX_MARKERS = 32;
const MAX_SPARKS = 24;
const SPARK_SECONDS = 0.3;

const OWN_BULLET_COLOR = new Color(0xfff2a8);
const OTHER_BULLET_COLOR = new Color(0xff7a4d);

/** v1's saucer (main.js:4207-4275): disc, glowing dome, engine ring, rim lights. */
function buildSaucer(hullColor: number): Group {
  const group = new Group();
  const hull = new MeshStandardMaterial({ color: hullColor, metalness: 0.1, roughness: 0.9 });

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

interface Spark {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
}

export class GameScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly ship = buildSaucer(0x1a1a1a);
  private readonly remoteShips = new Map<number, Group>();
  private readonly bullets: InstancedMesh;
  private readonly markers: Points;
  private readonly markerPositions: Float32Array;
  private readonly sparks: Spark[] = [];
  private nextSpark = 0;

  // Scratch objects, reused every frame.
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly orientation = new Quaternion();
  private readonly offset = new Vector3();
  private readonly forward = new Vector3();
  private readonly lookAt = new Vector3();
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly direction = new Vector3();
  private readonly bulletScale = new Vector3(1, 1, 7);
  private readonly zAxis = new Vector3(0, 0, 1);

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

    // Every bullet is one instance of the same small glowing shape.
    this.bullets = new InstancedMesh(
      new SphereGeometry(SIM.bulletRadius, 8, 6),
      new MeshBasicMaterial({ color: 0xffffff }),
      MAX_BULLETS,
    );
    this.bullets.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bullets.frustumCulled = false;
    this.bullets.count = 0;

    // A dot on every other ship, the same size at any distance, so players
    // can find each other across the belt.
    this.markerPositions = new Float32Array(MAX_MARKERS * 3);
    const markerGeometry = new BufferGeometry();
    const markerAttribute = new BufferAttribute(this.markerPositions, 3);
    markerAttribute.setUsage(DynamicDrawUsage);
    markerGeometry.setAttribute('position', markerAttribute);
    markerGeometry.setDrawRange(0, 0);
    this.markers = new Points(
      markerGeometry,
      new PointsMaterial({ color: 0xff5533, size: 5, sizeAttenuation: false, depthTest: false }),
    );
    this.markers.frustumCulled = false;

    const sparkGeometry = new SphereGeometry(1, 10, 8);
    for (let i = 0; i < MAX_SPARKS; i++) {
      const material = new MeshBasicMaterial({
        color: 0xff6644,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new Mesh(sparkGeometry, material);
      mesh.visible = false;
      this.sparks.push({ mesh, material, age: SPARK_SECONDS });
      this.scene.add(mesh);
    }

    this.scene.add(planet, buildStars(), this.ship, this.bullets, this.markers);

    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  /** A short flash where a bullet met a ship. */
  spark(x: number, y: number, z: number): void {
    const spark = this.sparks[this.nextSpark];
    this.nextSpark = (this.nextSpark + 1) % MAX_SPARKS;
    if (!spark) return;
    spark.age = 0;
    spark.mesh.position.set(x, y, z);
    spark.mesh.visible = true;
  }

  /** Draws one frame. `elapsedSeconds` is real time since the previous frame. */
  render(
    view: ShipView,
    remotes: readonly RemoteView[],
    bullets: readonly BulletView[],
    ownId: number,
    elapsedSeconds: number,
  ): void {
    // The ship's orientation is yaw, then pitch, then roll (main.js:8835).
    this.euler.set(view.pitch, view.yaw, view.roll, 'YXZ');
    this.orientation.setFromEuler(this.euler);
    this.ship.position.set(view.x, view.y, view.z);
    this.ship.quaternion.copy(this.orientation);
    this.ship.visible = view.alive;

    this.drawRemotes(remotes);
    this.drawBullets(bullets, ownId);
    this.drawSparks(elapsedSeconds);

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

  private drawRemotes(remotes: readonly RemoteView[]): void {
    const seen = new Set<number>();
    let markers = 0;
    for (const remote of remotes) {
      seen.add(remote.id);
      let mesh = this.remoteShips.get(remote.id);
      if (!mesh) {
        // v1 draws other players in a light hull (main.js:6823).
        mesh = buildSaucer(0xf5f5f5);
        mesh.scale.setScalar(REMOTE_SHIP_SCALE);
        this.remoteShips.set(remote.id, mesh);
        this.scene.add(mesh);
      }
      // A distant ship arrives as a position only: it is a dot, not a model.
      mesh.visible = remote.alive && remote.full;
      if (mesh.visible) {
        this.euler.set(remote.pitch, remote.yaw, remote.roll, 'YXZ');
        mesh.quaternion.setFromEuler(this.euler);
        mesh.position.set(remote.x, remote.y, remote.z);
      }
      if (remote.alive && markers < MAX_MARKERS) {
        this.markerPositions[markers * 3] = remote.x;
        this.markerPositions[markers * 3 + 1] = remote.y;
        this.markerPositions[markers * 3 + 2] = remote.z;
        markers++;
      }
    }
    for (const [id, mesh] of this.remoteShips) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      this.remoteShips.delete(id);
    }
    const geometry = this.markers.geometry;
    geometry.setDrawRange(0, markers);
    const attribute = geometry.getAttribute('position');
    attribute.needsUpdate = true;
  }

  private drawBullets(bullets: readonly BulletView[], ownId: number): void {
    const count = Math.min(bullets.length, MAX_BULLETS);
    for (let i = 0; i < count; i++) {
      const bullet = bullets[i];
      if (!bullet) break;
      // A stretched dot pointing along its flight.
      this.position.set(bullet.x, bullet.y, bullet.z);
      this.direction.set(bullet.dx, bullet.dy, bullet.dz);
      this.orientation.setFromUnitVectors(this.zAxis, this.direction);
      this.matrix.compose(this.position, this.orientation, this.bulletScale);
      this.bullets.setMatrixAt(i, this.matrix);
      this.bullets.setColorAt(i, bullet.ownerId === ownId ? OWN_BULLET_COLOR : OTHER_BULLET_COLOR);
    }
    this.bullets.count = count;
    this.bullets.instanceMatrix.needsUpdate = true;
    if (this.bullets.instanceColor) this.bullets.instanceColor.needsUpdate = true;
  }

  private drawSparks(elapsedSeconds: number): void {
    for (const spark of this.sparks) {
      if (!spark.mesh.visible) continue;
      spark.age += elapsedSeconds;
      const t = spark.age / SPARK_SECONDS;
      if (t >= 1) {
        spark.mesh.visible = false;
        continue;
      }
      spark.mesh.scale.setScalar(1 + t * 5);
      spark.material.opacity = 0.9 * (1 - t);
    }
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
