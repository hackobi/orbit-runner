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
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BulletView, ShipView } from '../net/client.ts';
import type { RemoteView } from '../net/remotes.ts';
import { SHIP_HULL_RADIUS, SIM } from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';
import { Particles } from './particles.ts';
import { TIERS } from './quality.ts';
import type { QualityTier } from './quality.ts';
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

/** v1 draws other players' ships half as big again as its own (main.js:6836). */
const REMOTE_SHIP_SCALE = 1.5;

const MAX_BULLETS = 512;
const MAX_SPARKS = 24;
const MAX_PARTICLES = 1400;
/** v1's exhaust (main.js:5947-5976, 9685): a pale blue trail, denser the faster the ship goes. */
const EXHAUST_COLOR = 0x66ccff;
const EXHAUST_BASE_RATE = 50;
const EXHAUST_RATE_PER_SPEED = 4;
/** Camera shake dies away at 6 units a second (main.js:8865). */
const SHAKE_DECAY = 6;
const SHAKE_MAX = 2.5;
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
/** A heavy shot is a fat ball, the same colour whoever fired it: it is the thing to dodge. */
const HEAVY_COLOR = new Color(0xffa040);
/** A homing shot: a magenta dart that leaves a trail, so its turn can be read. */
const SEEKER_COLOR = new Color(0xff40e0);
const SEEKER_TRAIL = 0xff80f0;

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

/**
 * A wormhole's mouth: a dark centre inside a bright ring whose arms turn.
 * v1 gave every wormhole its own cube camera to bend the stars around it
 * (main.js:5560-5600), 120 extra renders of the scene. This is one small
 * program on one flat shape, drawn for all of them at once.
 */
function buildWormholeMaterial(time: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { time },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 across;
      void main() {
        across = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying vec2 across;
      void main() {
        float r = length(across);
        float angle = atan(across.y, across.x);
        float arms = 0.5 + 0.5 * sin(angle * 3.0 + r * 9.0 - time * 2.5);
        float ring = smoothstep(0.38, 0.52, r) * (1.0 - smoothstep(0.82, 1.0, r));
        float centre = 1.0 - smoothstep(0.36, 0.44, r);
        vec3 glow = mix(vec3(0.45, 0.65, 1.0), vec3(1.0), arms);
        float alpha = max(centre * 0.96, ring * (0.35 + 0.65 * arms));
        gl_FragColor = vec4(glow * ring, alpha);
      }
    `,
  });
}

/** How wide a wormhole's mouth is drawn: v1's ring reached 4 units out (main.js:5565). */
const WORMHOLE_SIZE = 8;

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

/**
 * v1's starfield (main.js:4583-4603): 4,000 points in a shell 8,000 to 20,000 out.
 * Smaller than v1's 1.6 pixels and mostly faint: on a phone they read bigger
 * than the rocks of the belt.
 */
function buildStars(): Points {
  const count = 4000;
  const rng = new Rng(4000);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 8000 + rng.next() * 12000;
    const theta = rng.next() * Math.PI * 2;
    const phi = Math.acos(2 * rng.next() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    // Cubed, so most stars are dim and a few bright.
    const brightness = 0.3 + 0.7 * rng.next() ** 3;
    colors.fill(brightness, i * 3, i * 3 + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return new Points(
    geometry,
    new PointsMaterial({
      color: 0x99ccff,
      vertexColors: true,
      size: 1,
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
  // The same light hull as other players: v1's near-black one vanished against space.
  private readonly ship = buildShip(0xf5f5f5);
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
  private readonly sparks: Spark[] = [];
  private nextSpark = 0;
  readonly particles = new Particles(MAX_PARTICLES);
  private exhaustOwed = 0;
  private shakeAmount = 0;
  private wormholes: InstancedMesh | null = null;
  private wormholeIds: number[] = [];
  /** Seconds since the scene was made. Turns the wormholes' arms. */
  private readonly seconds = { value: 0 };
  private quality: QualityTier = TIERS[0] ?? {
    name: 'high',
    pixelRatio: 1.75,
    maxPixels: Infinity,
    particles: MAX_PARTICLES,
    rockDistance: Infinity,
  };
  private readonly wormholeMaterial = buildWormholeMaterial(this.seconds);

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
  private readonly heavyScale = new Vector3().setScalar(SIM.heavyRadius / SIM.bulletRadius);
  private readonly seekerScale = new Vector3(3.2, 3.2, 12);
  private readonly zAxis = new Vector3(0, 0, 1);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45; // main.js:287
    this.renderer.setClearColor(0x030a1a, 1); // main.js:288

    this.camera = new PerspectiveCamera(BASE_FOV, 1, 0.5, 60000);

    // A pale light that travels with the camera, so whatever is near is lit
    // from the player's side (main.js:340). v1's reached 800 units.
    const lamp = new PointLight(0x88bbff, 1.6, 800, 0);
    this.camera.add(lamp);
    this.scene.add(this.camera);

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

    this.scene.add(planet, buildStars(), this.ship.group, this.bullets, this.particles.mesh);

    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  /** Draws more or less finely from now on. The quality controller decides when. */
  setQuality(tier: QualityTier): void {
    this.quality = tier;
    this.particles.budget = tier.particles;
    this.resize();
  }

  /**
   * Where a point of the world falls on the screen, in CSS pixels, as the
   * last frame was drawn. False if it is behind the camera or off the screen.
   */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    this.position.set(x, y, z).project(this.camera);
    const p = this.position;
    if (p.z > 1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) return false;
    out.x = (p.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-p.y * 0.5 + 0.5) * window.innerHeight;
    return true;
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
    // And v1's burst of specks (main.js:5979): 26 for a rock, fewer for small things.
    this.particles.burst(x, y, z, color, Math.round(10 + 4 * Math.min(4, size)), 20);
  }

  /** Jolts the camera (main.js:8865-8869). Amounts are v1's, 0.08 to 1.2. */
  shake(amount: number): void {
    this.shakeAmount = Math.min(SHAKE_MAX, this.shakeAmount + amount);
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
    if (this.shakeAmount > 0) {
      const shake = this.shakeAmount;
      this.camera.position.x += (Math.random() * 2 - 1) * shake;
      this.camera.position.y += (Math.random() * 2 - 1) * shake * 0.6;
      this.camera.position.z += (Math.random() * 2 - 1) * shake;
      this.shakeAmount = Math.max(0, shake - SHAKE_DECAY * elapsedSeconds);
    }
    this.camera.lookAt(this.lookAt);
    this.seconds.value += elapsedSeconds;

    if (view.alive) this.emitExhaust(view, elapsedSeconds);
    this.particles.update(elapsedSeconds);

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
   * The trail behind the own ship (main.js:5947-5976): specks thrown out of
   * the back, faster and from further back as the ship speeds up.
   */
  private emitExhaust(view: ShipView, elapsedSeconds: number): void {
    this.exhaustOwed += (EXHAUST_BASE_RATE + view.speed * EXHAUST_RATE_PER_SPEED) * elapsedSeconds;
    const count = Math.min(40, Math.floor(this.exhaustOwed));
    this.exhaustOwed -= Math.floor(this.exhaustOwed);
    if (count === 0) return;
    const back = this.forward; // set by render: the nose direction
    const up = this.offset.set(0, 0.25, 0).applyQuaternion(this.orientation);
    const behind = 1.6 + Math.min(8, view.speed * 0.04);
    const thrown = 14 + view.speed * 0.55;
    for (let i = 0; i < count; i++) {
      const jitter = (): number => (Math.random() * 2 - 1) * 0.4;
      this.particles.emit(
        view.x - back.x * behind + up.x + jitter(),
        view.y - back.y * behind + up.y + jitter(),
        view.z - back.z * behind + up.z + jitter(),
        back.x * (view.speed - thrown) + jitter() * 2,
        back.y * (view.speed - thrown) + jitter() * 2,
        back.z * (view.speed - thrown) + jitter() * 2,
        0.5 + Math.random() * 0.25,
        0.18 * (0.6 + Math.random() * 0.5),
        EXHAUST_COLOR,
      );
    }
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
    const ship = this.ship.group.position;
    const shipRadial = Math.hypot(ship.x, ship.z);
    const reach = this.quality.rockDistance;
    for (let id = 0; id < asteroids.length; id++) {
      const rock = asteroids[id];
      const turn = this.rockTurns[id];
      if (!rock || !turn) continue;
      // On a slow device only the rocks whose orbits pass near the ship are drawn.
      if (Math.abs(rock.orbitRadius - shipRadial) > reach) {
        rocks.setMatrixAt(id, this.matrix.makeScale(0, 0, 0));
        this.rockWasGone[id] = view.state.asteroidGone(id, wholeTick);
        continue;
      }
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
      for (const old of [this.orbCores, this.orbRings, this.wormholes]) {
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
      this.wormholeIds = [...orbs.keys()].filter((id) => orbs[id]?.kind === 'wormhole');
      const wormholes = new InstancedMesh(
        new PlaneGeometry(1, 1),
        this.wormholeMaterial,
        Math.max(1, this.wormholeIds.length),
      );
      wormholes.count = this.wormholeIds.length;
      wormholes.frustumCulled = false;
      wormholes.instanceMatrix.setUsage(DynamicDrawUsage);
      this.wormholes = wormholes;
      this.scene.add(cores, rings, wormholes);
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
      // A wormhole has no core of its own: its mouth is drawn below.
      this.rockScale.setScalar(gone || orb.kind === 'wormhole' ? 0 : ORB_CORE[orb.kind]);
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

    const wormholes = this.wormholes;
    if (!wormholes) return;
    for (const [i, orbId] of this.wormholeIds.entries()) {
      const orb = orbs[orbId];
      if (!orb) continue;
      this.position.set(orb.x, orb.y, orb.z);
      this.rockScale.setScalar(this.orbWasGone[orbId] ? 0 : WORMHOLE_SIZE);
      wormholes.setMatrixAt(
        i,
        this.matrix.compose(this.position, this.camera.quaternion, this.rockScale),
      );
    }
    wormholes.instanceMatrix.needsUpdate = true;
  }

  private drawRemotes(remotes: readonly RemoteView[]): void {
    const seen = new Set<number>();
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
    }
    for (const [id, model] of this.remoteShips) {
      if (seen.has(id)) continue;
      this.scene.remove(model.group);
      this.remoteShips.delete(id);
    }
  }

  private drawBullets(bullets: readonly BulletView[], ownId: number): void {
    const count = Math.min(bullets.length, MAX_BULLETS);
    for (let i = 0; i < count; i++) {
      const bullet = bullets[i];
      if (!bullet) break;
      // A stretched dot pointing along its flight.
      this.position.set(bullet.x, bullet.y, bullet.z);
      // A homing shot seen only once has no direction yet.
      if (bullet.dx === 0 && bullet.dy === 0 && bullet.dz === 0) this.direction.copy(this.zAxis);
      else this.direction.set(bullet.dx, bullet.dy, bullet.dz);
      this.orientation.setFromUnitVectors(this.zAxis, this.direction);
      if (bullet.shot === 'seeker') {
        this.particles.emit(bullet.x, bullet.y, bullet.z, 0, 0, 0, 0.5, 0.5, SEEKER_TRAIL);
      }
      this.matrix.compose(
        this.position,
        this.orientation,
        bullet.shot === 'beam'
          ? this.beamScale
          : bullet.shot === 'heavy'
            ? this.heavyScale
            : bullet.shot === 'seeker'
              ? this.seekerScale
              : this.bulletScale,
      );
      this.bullets.setMatrixAt(i, this.matrix);
      this.bullets.setColorAt(
        i,
        bullet.shot === 'beam'
          ? BEAM_COLOR
          : bullet.shot === 'heavy'
            ? HEAVY_COLOR
            : bullet.shot === 'seeker'
              ? SEEKER_COLOR
              : bullet.ownerId === ownId
                ? OWN_BULLET_COLOR
                : OTHER_BULLET_COLOR,
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
    // As sharp as the screen, up to the tier's limits on sharpness and on pixels in all.
    const fits = Math.sqrt(this.quality.maxPixels / Math.max(1, width * height));
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio, fits),
    );
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
