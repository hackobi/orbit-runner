// The picture: planet, stars, rocks, orbs, ships, bullets and the chase camera. It draws
// whatever the netcode says is where; it decides nothing.

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
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
  RingGeometry,
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
import type { OrbKind } from '../shared/sim/orbs.ts';
import type { World, WorldState } from '../shared/sim/world.ts';

/** What the scene needs to draw rocks and orbs: where they are, the moment, and which are gone. */
export interface WorldView {
  world: World;
  tick: number;
  state: WorldState;
}

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

const HIT_SPARK = 0xff6644;
/** v1's burst when a rock breaks up (main.js:8998). */
const ROCK_SPARK = 0xffaa66;
/** v1's burst when a rock passes close (main.js:8951). */
export const NEAR_MISS_SPARK = 0x66ccff;

const OWN_BULLET_COLOR = new Color(0xfff2a8);
const OTHER_BULLET_COLOR = new Color(0xff7a4d);
/** v1's Fenix beam is red, thin and 12 long (main.js:6027). */
const BEAM_COLOR = new Color(0xff2222);

/** v1's orb colours (main.js:5126-5845). */
const ORB_COLORS: Record<OrbKind, number> = {
  shield: 0x66ff99,
  pink: 0xff33cc,
  fenix: 0xfff066,
  zaphire: 0xff4444,
  wormhole: 0x111111,
  boost: 0x88ccff,
  miner: 0xffe08a,
  hunter: 0xff9a8a,
};
/** How big each orb's glowing core is drawn. The collision radius is the simulation's. */
const ORB_CORE: Record<OrbKind, number> = {
  shield: 1.2,
  pink: 1.6,
  fenix: 1.7,
  zaphire: 2.4,
  wormhole: 1.6,
  boost: 1.1,
  miner: 1.2,
  hunter: 1.2,
};
/** The flat rings v1 draws around some orbs: outer radius and colour. */
const ORB_RINGS: Partial<Record<OrbKind, readonly (readonly [number, number])[]>> = {
  wormhole: [[4.0, 0xffffff]],
  boost: [
    [2.6, 0x33ff77],
    [3.8, 0xaa55ff],
  ],
  miner: [[2.8, 0x66ff99]],
  hunter: [[2.8, 0x66aaff]],
};

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

/** v1's Fenix (main.js:5038-5094): a black dart with wings and pale edges, nose along +Z. */
function buildFenix(): Group {
  const group = new Group();
  const dark = new MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.4, roughness: 0.5 });
  const pale = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffeedd,
    emissiveIntensity: 1.5,
  });
  const body = new Mesh(new ConeGeometry(1.2, 4, 12), dark);
  body.rotation.x = Math.PI / 2;
  const wings = new Mesh(new BoxGeometry(5.2, 0.12, 1.3), dark);
  wings.position.z = -1.1;
  const edge = new Mesh(new BoxGeometry(5.2, 0.05, 0.12), pale);
  edge.position.set(0, 0.07, -0.5);
  const tail = new Mesh(
    new SphereGeometry(0.45, 12, 8),
    new MeshStandardMaterial({ color: 0xff5522, emissive: 0xff5522, emissiveIntensity: 3 }),
  );
  tail.position.z = -2;
  group.add(body, wings, edge, tail);
  return group;
}

/** A ship that can be drawn as a saucer or as a Fenix. */
interface ShipModel {
  group: Group;
  saucer: Group;
  fenix: Group;
}

function buildShip(hullColor: number): ShipModel {
  const group = new Group();
  const saucer = buildSaucer(hullColor);
  const fenix = buildFenix();
  fenix.visible = false;
  group.add(saucer, fenix);
  return { group, saucer, fenix };
}

function showAs(model: ShipModel, fenix: boolean): void {
  model.saucer.visible = !fenix;
  model.fenix.visible = fenix;
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
  size: number;
}

export class GameScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly ship = buildShip(0x1a1a1a);
  private readonly remoteShips = new Map<number, ShipModel>();
  private readonly bullets: InstancedMesh;
  private rocks: InstancedMesh | null = null;
  private rocksOf: World | null = null;
  /** Each rock's fixed tumble, so the belt is not two thousand copies of one stone. */
  private rockTurns: Quaternion[] = [];
  private rockWasGone: boolean[] = [];
  private readonly rockScale = new Vector3();
  private orbCores: InstancedMesh | null = null;
  private orbRings: InstancedMesh | null = null;
  /** For each ring drawn: the orb it belongs to and its outer radius. */
  private ringOf: { orbId: number; outer: number }[] = [];
  private orbsOf: World | null = null;
  private orbWasGone: boolean[] = [];
  private readonly identity = new Quaternion();
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
  /** A beam is 12 long and thin (main.js:6027); the shape it is drawn from has radius 0.25. */
  private readonly beamScale = new Vector3(0.5, 0.5, 24);
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
      this.sparks.push({ mesh, material, age: SPARK_SECONDS, size: 1 });
      this.scene.add(mesh);
    }

    this.scene.add(planet, buildStars(), this.ship.group, this.bullets, this.markers);

    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  /** A short flash: where a bullet met a ship, or a rock broke up or passed close. */
  spark(x: number, y: number, z: number, color = HIT_SPARK, size = 1): void {
    const spark = this.sparks[this.nextSpark];
    this.nextSpark = (this.nextSpark + 1) % MAX_SPARKS;
    if (!spark) return;
    spark.age = 0;
    spark.size = size;
    spark.material.color.setHex(color);
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
    world: WorldView | null,
  ): void {
    // The ship's orientation is yaw, then pitch, then roll (main.js:8835).
    this.euler.set(view.pitch, view.yaw, view.roll, 'YXZ');
    this.orientation.setFromEuler(this.euler);
    const ship = this.ship.group;
    ship.position.set(view.x, view.y, view.z);
    ship.quaternion.copy(this.orientation);
    ship.visible = view.alive;
    showAs(this.ship, view.fenix);

    // Rigid chase camera: a fixed offset in the ship's frame, looking at a
    // point ahead of the nose (main.js:8863-8875).
    this.offset.copy(CAMERA_OFFSET).applyQuaternion(this.orientation);
    this.camera.position.copy(ship.position).add(this.offset);
    this.forward.set(0, 0, 1).applyQuaternion(this.orientation);
    this.lookAt.copy(ship.position).addScaledVector(this.forward, LOOK_AHEAD);
    this.camera.lookAt(this.lookAt);

    if (world) {
      this.drawRocks(world);
      this.drawOrbs(world);
    }
    this.drawRemotes(remotes);
    this.drawBullets(bullets, ownId);
    this.drawSparks(elapsedSeconds);

    // Field of view widens with speed (main.js:8726-8730). v1 moved 6·dt of
    // the way each frame; this is the same response at any frame rate.
    const extra =
      (view.speed - FOV_SPEED_FLOOR) * FOV_PER_SPEED + (view.boosting ? FOV_BOOST_KICK : 0);
    const target = BASE_FOV + Math.max(0, Math.min(FOV_MAX_EXTRA, extra));
    this.camera.fov += (target - this.camera.fov) * (1 - Math.exp(-FOV_FOLLOW * elapsedSeconds));
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * The belt. Every rock is one instance of v1's twelve-sided stone
   * (main.js:4754, 4841-4847), placed where its orbit puts it at the moment
   * the own ship is drawn. A rock that has just gone breaks up in a flash.
   */
  private drawRocks(view: WorldView): void {
    const asteroids = view.world.belt.asteroids;
    if (this.rocksOf !== view.world) {
      if (this.rocks) {
        this.scene.remove(this.rocks);
        this.rocks.geometry.dispose();
      }
      this.rocksOf = view.world;
      this.rocks = new InstancedMesh(
        new DodecahedronGeometry(1, 0),
        new MeshStandardMaterial({
          color: 0xa8a8a8,
          roughness: 0.95,
          metalness: 0.05,
          emissive: 0x222222,
          emissiveIntensity: 0.18,
          flatShading: true,
        }),
        Math.max(1, asteroids.length),
      );
      this.rocks.instanceMatrix.setUsage(DynamicDrawUsage);
      this.rocks.frustumCulled = false;
      this.rocks.count = asteroids.length;
      this.scene.add(this.rocks);
      const rng = new Rng(view.world.seed);
      this.rockTurns = asteroids.map(() =>
        new Quaternion().setFromEuler(
          new Euler(rng.next() * Math.PI * 2, rng.next() * Math.PI * 2, rng.next() * Math.PI * 2),
        ),
      );
      this.rockWasGone = asteroids.map((_, id) => view.state.asteroidGone(id, view.tick));
    }
    const rocks = this.rocks;
    if (!rocks) return;

    const wholeTick = Math.floor(view.tick);
    for (let id = 0; id < asteroids.length; id++) {
      const rock = asteroids[id];
      const turn = this.rockTurns[id];
      if (!rock || !turn) continue;
      // Drawing may use the platform's sin and cos: nothing is decided here.
      const angle = rock.angle0 + rock.anglePerTick * view.tick;
      this.position.set(
        Math.cos(angle) * rock.orbitRadius,
        rock.y,
        Math.sin(angle) * rock.orbitRadius,
      );
      const gone = view.state.asteroidGone(id, wholeTick);
      if (gone && this.rockWasGone[id] === false) {
        this.spark(this.position.x, this.position.y, this.position.z, ROCK_SPARK, rock.scale);
      }
      this.rockWasGone[id] = gone;
      this.rockScale.setScalar(gone ? 0 : rock.scale);
      this.matrix.compose(this.position, turn, this.rockScale);
      rocks.setMatrixAt(id, this.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
  }

  /**
   * The orbs: a glowing core each, and for some kinds v1's flat rings, which
   * are turned to face the camera. An orb that has just been taken goes in a
   * flash of its own colour.
   */
  private drawOrbs(view: WorldView): void {
    const orbs = view.world.orbs.orbs;
    if (this.orbsOf !== view.world) {
      for (const old of [this.orbCores, this.orbRings]) {
        if (!old) continue;
        this.scene.remove(old);
        old.geometry.dispose();
      }
      this.orbsOf = view.world;
      this.ringOf = [];
      const ringColors: number[] = [];
      for (const [orbId, orb] of orbs.entries()) {
        for (const [outer, color] of ORB_RINGS[orb.kind] ?? []) {
          this.ringOf.push({ orbId, outer });
          ringColors.push(color);
        }
      }
      const cores = new InstancedMesh(
        new SphereGeometry(1, 14, 10),
        new MeshBasicMaterial({ color: 0xffffff }),
        Math.max(1, orbs.length),
      );
      cores.count = orbs.length;
      cores.frustumCulled = false;
      const rings = new InstancedMesh(
        // v1's rings are about 0.6 of their outer radius on the inside.
        new RingGeometry(0.62, 1, 40),
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.6,
          side: DoubleSide,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
        Math.max(1, this.ringOf.length),
      );
      rings.count = this.ringOf.length;
      rings.frustumCulled = false;
      rings.instanceMatrix.setUsage(DynamicDrawUsage);
      const color = new Color();
      for (const [id, orb] of orbs.entries())
        cores.setColorAt(id, color.setHex(ORB_COLORS[orb.kind]));
      for (const [i, hex] of ringColors.entries()) rings.setColorAt(i, color.setHex(hex));
      this.orbCores = cores;
      this.orbRings = rings;
      this.scene.add(cores, rings);
      // Start as if every orb had been gone, so that each is placed once below.
      this.orbWasGone = orbs.map(() => true);
      for (let id = 0; id < orbs.length; id++)
        cores.setMatrixAt(id, this.matrix.makeScale(0, 0, 0));
    }
    const cores = this.orbCores;
    const rings = this.orbRings;
    if (!cores || !rings) return;

    const tick = Math.floor(view.tick);
    let coresChanged = false;
    for (let id = 0; id < orbs.length; id++) {
      const orb = orbs[id];
      if (!orb) continue;
      const gone = view.state.orbGone(id, tick);
      if (gone === this.orbWasGone[id]) continue;
      // Only the first pass places orbs without a flash.
      if (gone) this.spark(orb.x, orb.y, orb.z, ORB_COLORS[orb.kind], orb.radius);
      this.orbWasGone[id] = gone;
      this.position.set(orb.x, orb.y, orb.z);
      this.rockScale.setScalar(gone ? 0 : ORB_CORE[orb.kind]);
      cores.setMatrixAt(id, this.matrix.compose(this.position, this.identity, this.rockScale));
      coresChanged = true;
    }
    if (coresChanged) cores.instanceMatrix.needsUpdate = true;

    for (const [i, ring] of this.ringOf.entries()) {
      const orb = orbs[ring.orbId];
      if (!orb) continue;
      this.position.set(orb.x, orb.y, orb.z);
      this.rockScale.setScalar(this.orbWasGone[ring.orbId] ? 0 : ring.outer);
      rings.setMatrixAt(
        i,
        this.matrix.compose(this.position, this.camera.quaternion, this.rockScale),
      );
    }
    rings.instanceMatrix.needsUpdate = true;
  }

  private drawRemotes(remotes: readonly RemoteView[]): void {
    const seen = new Set<number>();
    let markers = 0;
    for (const remote of remotes) {
      seen.add(remote.id);
      let model = this.remoteShips.get(remote.id);
      if (!model) {
        // v1 draws other players in a light hull (main.js:6823).
        model = buildShip(0xf5f5f5);
        model.group.scale.setScalar(REMOTE_SHIP_SCALE);
        this.remoteShips.set(remote.id, model);
        this.scene.add(model.group);
      }
      const mesh = model.group;
      // A distant ship arrives as a position only: it is a dot, not a model.
      mesh.visible = remote.alive && remote.full;
      if (mesh.visible) {
        showAs(model, remote.fenix);
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
    for (const [id, model] of this.remoteShips) {
      if (seen.has(id)) continue;
      this.scene.remove(model.group);
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
      this.matrix.compose(
        this.position,
        this.orientation,
        bullet.beam ? this.beamScale : this.bulletScale,
      );
      this.bullets.setMatrixAt(i, this.matrix);
      this.bullets.setColorAt(
        i,
        bullet.beam ? BEAM_COLOR : bullet.ownerId === ownId ? OWN_BULLET_COLOR : OTHER_BULLET_COLOR,
      );
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
      spark.mesh.scale.setScalar(spark.size * (1 + t * 5));
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
