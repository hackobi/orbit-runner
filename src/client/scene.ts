// The picture: planet, stars, rocks, orbs, ships, bullets and the chase camera. It draws
// whatever the netcode says is where; it decides nothing.

import type { BufferGeometry } from 'three';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BulletView, ShipView } from '../net/client.ts';
import type { RemoteView } from '../net/remotes.ts';
import { hullScaleOf, npcKindOf } from '../shared/progress.ts';
import { SIM } from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';
import { SUN_DIRECTION, buildBackdrop } from './backdrop.ts';
import type { Backdrop } from './backdrop.ts';
import { buildShip, disposeShip, showAs } from './models.ts';
import type { ShipModel } from './models.ts';
import type { Looks } from './skins.ts';
import { Particles, SpriteBatch } from './particles.ts';
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
// The fort's view: from above and behind where the ship was, drifting slowly
// round it, looking at the planet.
const FORT_EYE_DISTANCE = 90;
const FORT_EYE_HEIGHT = 45;
const FORT_ORBIT_RATE = 0.035; // radians a second
/** How quickly the camera goes between the flying view and the fort's. */
const FORT_CAMERA_FOLLOW = 2.6;
/** Where the pilot's eyes are, in the ship's frame: just above its centre. */
const COCKPIT_OFFSET = new Vector3(0, 0.5, 0);
/** A camera looks down its own -Z and the ship's nose is +Z: half a turn about Y. */
const COCKPIT_FACING = new Quaternion(0, 1, 0, 0);
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
const EXHAUST_BASE_RATE = 50;
const EXHAUST_RATE_PER_SPEED = 4;
/** Other ships leave a trail too, so that where one is heading can be read. v1 drew none. */
const REMOTE_EXHAUST_RATE = 45; // puffs a second, doubled under boost
/** A remote ship's speed is not sent, so its engines glow as at cruising speed. */
const REMOTE_GLOW_SPEED = 40;
/** Camera shake dies away at 6 units a second (main.js:8865). */
const SHAKE_DECAY = 6;
const SHAKE_MAX = 2.5;
const SPARK_SECONDS = 0.3;

const HIT_SPARK = 0xff6644;
/** A hit the shield took flashes in the shield's colour, so the two read apart. */
export const SHIELD_SPARK = 0x5ab8ff;
/** A ship breaking up. */
export const DEATH_SPARK = 0xffc070;
/** A hull at or under this trails smoke: two bullets from the end. */
const SMOKE_BELOW_HP = 35;
/** Dim, so that the soft lights it is drawn with read as haze and not as a lamp. */
const SMOKE_COLOR = 0x2c2c2c;
const SMOKE_SPARK = 0xff7a30;
const SMOKE_RATE = 30; // puffs a second
/** After a kill, sparks and debris play at this fraction of their speed for a moment. */
const SLOW_MOTION_RATE = 0.2;
const SLOW_MOTION_ZOOM = 9; // degrees the view closes in by
/** v1's burst when a rock breaks up (main.js:8998). */
const ROCK_SPARK = 0xffaa66;
/** v1's burst when a rock passes close (main.js:8951). */
export const NEAR_MISS_SPARK = 0x66ccff;

const OWN_BULLET_COLOR = new Color(0xfff2a8);
const OTHER_BULLET_COLOR = new Color(0xff7a4d);
/** v1's Fenix beam is red, thin and 12 long (main.js:6027). */
const BEAM_COLOR = new Color(0xff2222);
/**
 * A heavy shot is a ball of plasma, the same colour whoever fired it: it is the
 * thing to dodge. Its soft glow reaches exactly as far as it can hit; the hot
 * centre is much smaller.
 */
const HEAVY_COLOR = new Color(0xff8a1c);
const HEAVY_CORE_COLOR = new Color(0xfff3cf);
const HEAVY_CORE = 0.3; // of the radius
const HEAVY_EMBER = 0xff9a3c;
/** A homing shot: a see-through magenta dart that leaves a trail, so its turn can be read. */
const SEEKER_COLOR = new Color(0xff40e0);
const SEEKER_ALPHA = 0.7;
const SEEKER_TRAIL = 0xff80f0;
const MAX_GLOWS = 64;
const MAX_LIGHTS = 640;

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
/** The bright centre is this much of the orb as drawn; the rest is glow. */
const ORB_CENTRE = 0.55;
/** The soft halo reaches this many times further than the orb. */
const ORB_HALO = 3.2;
/** The flat rings v1 draws around some orbs: outer radius and colour. */
const ORB_RINGS: Partial<Record<OrbKind, readonly (readonly [number, number])[]>> = {
  boost: [
    [2.6, 0x33ff77],
    [3.8, 0xaa55ff],
  ],
  miner: [[2.8, 0x66ff99]],
  hunter: [[2.8, 0x66aaff]],
};

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

/**
 * Plasma: a glowing shape that is brightest where it faces the viewer and fades
 * to nothing at its edge, with bands of light crawling over it. Heavy and homing
 * shots are drawn with it, each with its own colour and strength (`tint`).
 */
function buildGlowMaterial(time: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { time },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 tint;
      varying vec4 colour;
      varying vec3 local;
      varying float facing;
      void main() {
        colour = tint;
        local = position;
        vec4 seen = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vec3 outward = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        facing = abs(dot(outward, normalize(-seen.xyz)));
        gl_Position = projectionMatrix * seen;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying vec4 colour;
      varying vec3 local;
      varying float facing;
      void main() {
        float bands = sin(local.x * 5.0 + time * 9.0) * sin(local.y * 6.0 - time * 7.0)
          * sin(local.z * 4.0 + time * 11.0);
        float body = pow(facing, 1.3);
        float heart = pow(facing, 7.0);
        vec3 lit = mix(colour.rgb, vec3(1.0), heart * 0.75) * (0.85 + 0.6 * bands);
        gl_FragColor = vec4(lit, body * colour.a);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** How wide a wormhole's mouth is drawn: v1's ring reached 4 units out (main.js:5565). */
const WORMHOLE_SIZE = 8;

/** Rock colours: mostly grey and brown stone, some slate, a little rust. */
const ROCK_COLORS = [0x9a948e, 0x8a7763, 0x6f7d92, 0x5a5860, 0x9c6a4c, 0xaaa6a0];

/**
 * One lumpy stone, in place of v1's twelve-sided one (main.js:4754). No
 * point of it is further out than a rock can be hit, and few are far inside.
 */
function buildRockGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const positions = geometry.getAttribute('position');
  const point = new Vector3();
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i);
    // The same number for every copy of a corner, so the faces stay joined.
    const seed =
      Math.round(point.x * 100) * 12.9898 +
      Math.round(point.y * 100) * 78.233 +
      Math.round(point.z * 100) * 37.719;
    const jag = Math.sin(seed) * 43758.5453;
    const lump =
      Math.sin(point.x * 2.1 + 1) * Math.sin(point.y * 1.7 + 2) * Math.sin(point.z * 1.9);
    point.multiplyScalar(0.8 + 0.2 * (jag - Math.floor(jag)) + 0.08 * lump);
    positions.setXYZ(i, point.x, point.y * 0.86, point.z * 0.94);
  }
  geometry.computeVertexNormals();
  return geometry;
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
  private ship = buildShip('own');
  /** What other players' ships wear, for those that wear anything. */
  private readonly remoteLooks = new Map<number, Looks>();
  private readonly backdrop: Backdrop;
  /** Lights redrawn every frame: engine glows and the halo round each shot. */
  private readonly lights = new SpriteBatch(MAX_LIGHTS);
  /** The halo round each orb, set when the orb comes or goes. */
  private orbHalos: SpriteBatch | null = null;
  private orbGlows: InstancedMesh | null = null;
  private readonly color = new Color();
  private readonly remoteShips = new Map<number, ShipModel>();
  private readonly bullets: InstancedMesh;
  private readonly glows: InstancedMesh;
  private readonly glowTints: InstancedBufferAttribute;
  private rocks: InstancedMesh | null = null;
  private rocksOf: World | null = null;
  /** Each rock's fixed tumble, so the belt is not two thousand copies of one stone. */
  private rockTurns: Quaternion[] = [];
  private rockWasGone: boolean[] = [];
  /** Each rock turns slowly about its own axis. */
  private rockAxes: Vector3[] = [];
  private rockRates: number[] = [];
  private readonly spin = new Quaternion();
  private readonly turned = new Quaternion();
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
  private slowMotionSeconds = 0;
  private shakeAmount = 0;
  private fort = false;
  /** 0 in the flying view, 1 in the fort's, and in between while the camera moves. */
  private fortBlend = 0;
  private readonly fortEye = new Vector3();
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
  private readonly heavyCoreScale = new Vector3().setScalar(
    (SIM.heavyRadius * HEAVY_CORE) / SIM.bulletRadius,
  );
  private readonly heavyGlowScale = new Vector3();
  private readonly seekerScale = new Vector3(3.2, 3.2, 12).multiplyScalar(SIM.bulletRadius);
  private readonly zAxis = new Vector3(0, 0, 1);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45; // main.js:287
    this.renderer.setClearColor(0x030a1a, 1); // main.js:288

    this.camera = new PerspectiveCamera(BASE_FOV, 1, 0.5, 60000);

    // The sky, the planet and the rest of the scenery, painted once.
    this.backdrop = buildBackdrop(this.renderer, matchMedia('(pointer: coarse)').matches);
    this.scene.background = this.backdrop.sky;
    this.scene.environment = this.backdrop.light;

    // A pale light that travels with the camera, so whatever is near is lit
    // from the player's side (main.js:340). v1's reached 800 units.
    const lamp = new PointLight(0x88bbff, 0.9, 800, 0);
    this.camera.add(lamp);
    this.scene.add(this.camera);

    this.scene.add(new AmbientLight(0x506080, 0.3));
    const sun = new DirectionalLight(0xfff0dc, 1.7);
    sun.position.copy(SUN_DIRECTION);
    this.scene.add(sun);

    // Every bullet is one instance of the same small glowing shape.
    this.bullets = new InstancedMesh(
      new SphereGeometry(SIM.bulletRadius, 8, 6),
      new MeshBasicMaterial({ color: 0xffffff }),
      MAX_BULLETS,
    );
    this.bullets.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bullets.frustumCulled = false;
    this.bullets.count = 0;

    // Heavy and homing shots glow; each instance carries its colour and strength.
    const glowGeometry = new SphereGeometry(1, 20, 14);
    this.glowTints = new InstancedBufferAttribute(new Float32Array(MAX_GLOWS * 4), 4);
    this.glowTints.setUsage(DynamicDrawUsage);
    glowGeometry.setAttribute('tint', this.glowTints);
    this.glows = new InstancedMesh(glowGeometry, buildGlowMaterial(this.seconds), MAX_GLOWS);
    this.glows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.glows.frustumCulled = false;
    this.glows.count = 0;

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

    this.scene.add(
      this.backdrop.group,
      this.ship.group,
      this.bullets,
      this.glows,
      this.particles.mesh,
      this.lights.mesh,
    );

    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  /** Dresses the player's own ship. It is built again; a look is chosen in settings, not in a fight. */
  setLooks(looks: Looks): void {
    this.scene.remove(this.ship.group);
    disposeShip(this.ship);
    this.ship = buildShip('own', looks);
    this.scene.add(this.ship.group);
  }

  /**
   * Dresses another player's ship. Nothing tells this screen what other
   * pilots chose, so today only the pictures made for judging looks use it.
   */
  setRemoteLooks(id: number, looks: Looks): void {
    this.remoteLooks.set(id, looks);
    const model = this.remoteShips.get(id);
    if (!model) return;
    this.scene.remove(model.group);
    disposeShip(model);
    this.remoteShips.delete(id);
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

  /**
   * A kill, drawn out: for `seconds` the debris and sparks move slowly and
   * the view closes in. Only the effects slow down. The game itself is
   * shared with every player and keeps its pace.
   */
  slowMotion(seconds: number): void {
    this.slowMotionSeconds = Math.max(this.slowMotionSeconds, seconds);
  }

  /** Smoke from a ship whose hull is nearly gone. */
  private emitSmoke(x: number, y: number, z: number, hp: number, elapsedSeconds: number): void {
    if (hp > SMOKE_BELOW_HP || Math.random() > SMOKE_RATE * elapsedSeconds) return;
    const drift = (): number => (Math.random() * 2 - 1) * 1.5;
    this.particles.emit(
      x + drift(),
      y + 0.8 + drift() * 0.4,
      z + drift(),
      drift(),
      2 + drift(),
      drift(),
      1.1,
      0.8,
      SMOKE_COLOR,
    );
    // And now and then a spark of fire in it.
    if (Math.random() < 0.35)
      this.particles.emit(
        x,
        y + 0.5,
        z,
        drift() * 2,
        3 + drift(),
        drift() * 2,
        0.5,
        0.1,
        SMOKE_SPARK,
      );
  }

  /**
   * The fort's view or the flying one. The camera glides from one to the other
   * over about a second; nothing else about the picture changes.
   */
  setFort(on: boolean): void {
    this.fort = on;
  }

  /**
   * The view from inside the ship: the camera sits where the pilot would and
   * turns and banks with the ship, and the ship itself is not drawn. The
   * middle of the screen is then exactly where the nose points.
   */
  cockpit = false;

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
    // The fort has its own view, whichever one the pilot flies with.
    const inside = this.cockpit && !this.fort;
    ship.visible = view.alive && !inside;
    showAs(this.ship, view.fenix);

    // Rigid chase camera: a fixed offset in the ship's frame, looking at a
    // point ahead of the nose (main.js:8863-8875).
    this.offset.copy(inside ? COCKPIT_OFFSET : CAMERA_OFFSET).applyQuaternion(this.orientation);
    this.camera.position.copy(ship.position).add(this.offset);
    this.forward.set(0, 0, 1).applyQuaternion(this.orientation);
    this.lookAt.copy(ship.position).addScaledVector(this.forward, LOOK_AHEAD);
    this.fortBlend +=
      ((this.fort ? 1 : 0) - this.fortBlend) * (1 - Math.exp(-FORT_CAMERA_FOLLOW * elapsedSeconds));
    if (this.fortBlend > 0.001) {
      const angle = this.seconds.value * FORT_ORBIT_RATE;
      this.fortEye.set(
        view.x + Math.cos(angle) * FORT_EYE_DISTANCE,
        view.y + FORT_EYE_HEIGHT,
        view.z + Math.sin(angle) * FORT_EYE_DISTANCE,
      );
      // Ease in and out, so the move starts and stops gently.
      const eased = this.fortBlend * this.fortBlend * (3 - 2 * this.fortBlend);
      this.camera.position.lerp(this.fortEye, eased);
      // The planet sits at the middle of the world.
      this.lookAt.multiplyScalar(1 - eased);
    }
    if (this.shakeAmount > 0) {
      const shake = this.shakeAmount;
      this.camera.position.x += (Math.random() * 2 - 1) * shake;
      this.camera.position.y += (Math.random() * 2 - 1) * shake * 0.6;
      this.camera.position.z += (Math.random() * 2 - 1) * shake;
      this.shakeAmount = Math.max(0, shake - SHAKE_DECAY * elapsedSeconds);
    }
    if (inside) this.camera.quaternion.copy(this.orientation).multiply(COCKPIT_FACING);
    else this.camera.lookAt(this.lookAt);
    this.seconds.value += elapsedSeconds;
    this.backdrop.update(this.camera.position, this.renderer.getPixelRatio(), this.seconds.value);
    this.lights.count = 0;

    const slow = this.slowMotionSeconds > 0;
    this.slowMotionSeconds = Math.max(0, this.slowMotionSeconds - elapsedSeconds);
    const effectSeconds = slow ? elapsedSeconds * SLOW_MOTION_RATE : elapsedSeconds;

    if (view.alive) {
      this.ship.animate(this.seconds.value);
      this.emitExhaust(view, elapsedSeconds);
      this.engineGlow(this.ship, view.fenix, view.speed, view.boosting, 1);
      // From inside, the ship's own smoke would fill the screen.
      if (!inside) this.emitSmoke(view.x, view.y, view.z, view.hp, elapsedSeconds);
    }
    for (const remote of remotes) {
      if (remote.alive && remote.full) {
        this.emitSmoke(remote.x, remote.y, remote.z, remote.hp, elapsedSeconds);
      }
    }
    this.particles.update(effectSeconds);

    if (world) {
      this.drawRocks(world);
      this.drawOrbs(world);
    }
    this.drawRemotes(remotes, elapsedSeconds);
    this.drawBullets(bullets, ownId);
    this.drawSparks(effectSeconds);
    this.lights.commit();

    // Field of view widens with speed (main.js:8726-8730). v1 moved 6·dt of
    // the way each frame; this is the same response at any frame rate.
    const extra =
      (view.speed - FOV_SPEED_FLOOR) * FOV_PER_SPEED + (view.boosting ? FOV_BOOST_KICK : 0);
    const target =
      BASE_FOV + Math.max(0, Math.min(FOV_MAX_EXTRA, extra)) - (slow ? SLOW_MOTION_ZOOM : 0);
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
    const engines = view.fenix ? this.ship.fenixEngines : this.ship.engines;
    const color = (view.fenix ? this.ship.fenixEngineColor : this.ship.engineColor).getHex();
    const behind = Math.min(8, view.speed * 0.04);
    const thrown = 14 + view.speed * 0.55;
    for (let i = 0; i < count; i++) {
      const engine = engines[i % engines.length];
      if (!engine) break;
      const from = this.offset.copy(engine).applyQuaternion(this.orientation);
      const jitter = (): number => (Math.random() * 2 - 1) * 0.12;
      this.particles.emit(
        view.x + from.x - back.x * behind + jitter(),
        view.y + from.y - back.y * behind + jitter(),
        view.z + from.z - back.z * behind + jitter(),
        back.x * (view.speed - thrown) + jitter() * 6,
        back.y * (view.speed - thrown) + jitter() * 6,
        back.z * (view.speed - thrown) + jitter() * 6,
        0.35 + Math.random() * 0.25,
        0.1 * (0.6 + Math.random() * 0.5),
        color,
      );
    }
  }

  /** A light at each engine, bigger the faster the ship goes, and flickering. */
  private engineGlow(
    model: ShipModel,
    fenix: boolean,
    speed: number,
    boosting: boolean,
    scale: number,
  ): void {
    // A big ship's glow grows by less than the ship does.
    const size = (0.42 + speed * 0.004 + (boosting ? 0.4 : 0)) * scale ** 0.6;
    const color = fenix ? model.fenixEngineColor : model.engineColor;
    for (const engine of fenix ? model.fenixEngines : model.engines) {
      this.position.copy(engine).multiplyScalar(scale).applyQuaternion(model.group.quaternion);
      this.position.add(model.group.position);
      this.lights.add(
        this.position.x,
        this.position.y,
        this.position.z,
        size * (0.9 + Math.random() * 0.2),
        color,
        0.7,
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
        buildRockGeometry(),
        new MeshStandardMaterial({ roughness: 0.92, metalness: 0.08, flatShading: true }),
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
      this.rockAxes = asteroids.map(() =>
        new Vector3(rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5).normalize(),
      );
      // A turn takes between 20 seconds and a minute and a half.
      this.rockRates = asteroids.map(() => 0.07 + rng.next() * 0.24);
      for (let id = 0; id < asteroids.length; id++) {
        const hex = ROCK_COLORS[Math.floor(rng.next() * ROCK_COLORS.length)] ?? 0x999999;
        this.rocks.setColorAt(id, this.color.setHex(hex).multiplyScalar(0.75 + rng.next() * 0.4));
      }
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
      const axis = this.rockAxes[id];
      if (axis) {
        this.spin.setFromAxisAngle(axis, (this.rockRates[id] ?? 0) * this.seconds.value);
        this.turned.multiplyQuaternions(this.spin, turn);
      } else this.turned.copy(turn);
      this.matrix.compose(this.position, this.turned, this.rockScale);
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
      for (const old of [
        this.orbCores,
        this.orbRings,
        this.wormholes,
        this.orbGlows,
        this.orbHalos?.mesh,
      ]) {
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
      // Round each bright centre, a shell of plasma in the orb's colour and a soft halo.
      const glowGeometry = new SphereGeometry(1, 20, 14);
      const tints = new InstancedBufferAttribute(new Float32Array(Math.max(1, orbs.length) * 4), 4);
      for (const [id, orb] of orbs.entries()) {
        color.setHex(ORB_COLORS[orb.kind]);
        tints.setXYZW(id, color.r, color.g, color.b, 0.9);
      }
      glowGeometry.setAttribute('tint', tints);
      const glows = new InstancedMesh(
        glowGeometry,
        buildGlowMaterial(this.seconds),
        Math.max(1, orbs.length),
      );
      glows.count = orbs.length;
      glows.frustumCulled = false;
      for (let id = 0; id < orbs.length; id++)
        glows.setMatrixAt(id, this.matrix.makeScale(0, 0, 0));
      this.orbGlows = glows;
      this.orbHalos = new SpriteBatch(Math.max(1, orbs.length));
      this.orbHalos.count = orbs.length;
      this.scene.add(cores, rings, wormholes, glows, this.orbHalos.mesh);
      // Start as if every orb had been gone, so that each is placed once below.
      this.orbWasGone = orbs.map(() => true);
      for (let id = 0; id < orbs.length; id++)
        cores.setMatrixAt(id, this.matrix.makeScale(0, 0, 0));
    }
    const cores = this.orbCores;
    const rings = this.orbRings;
    const glows = this.orbGlows;
    const halos = this.orbHalos;
    if (!cores || !rings || !glows || !halos) return;

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
      const size = gone || orb.kind === 'wormhole' ? 0 : ORB_CORE[orb.kind];
      this.rockScale.setScalar(size * ORB_CENTRE);
      cores.setMatrixAt(id, this.matrix.compose(this.position, this.identity, this.rockScale));
      this.rockScale.setScalar(size);
      glows.setMatrixAt(id, this.matrix.compose(this.position, this.identity, this.rockScale));
      this.color.setHex(ORB_COLORS[orb.kind]);
      const c = this.color;
      halos.set(id, orb.x, orb.y, orb.z, size * ORB_HALO, c.r, c.g, c.b, size > 0 ? 0.45 : 0);
      coresChanged = true;
    }
    if (coresChanged) {
      cores.instanceMatrix.needsUpdate = true;
      glows.instanceMatrix.needsUpdate = true;
      halos.commit();
    }

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

  private drawRemotes(remotes: readonly RemoteView[], elapsedSeconds: number): void {
    const seen = new Set<number>();
    for (const remote of remotes) {
      seen.add(remote.id);
      let model = this.remoteShips.get(remote.id);
      if (!model) {
        // The server's own ships have shapes of their own; the Warlock is three times the size.
        model = buildShip(npcKindOf(remote.id) ?? 'other', this.remoteLooks.get(remote.id));
        model.group.scale.setScalar(REMOTE_SHIP_SCALE * hullScaleOf(remote.id));
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
        model.animate(this.seconds.value);
        const scale = REMOTE_SHIP_SCALE * hullScaleOf(remote.id);
        this.engineGlow(model, remote.fenix, REMOTE_GLOW_SPEED, remote.boosting, scale);
        // Its trail: puffs left where its engines were, which the ship flies away from.
        const rate = REMOTE_EXHAUST_RATE * (remote.boosting ? 2 : 1) * elapsedSeconds;
        const puffs = Math.floor(rate + Math.random());
        const engines = remote.fenix ? model.fenixEngines : model.engines;
        const hex = (remote.fenix ? model.fenixEngineColor : model.engineColor).getHex();
        for (let i = 0; i < puffs; i++) {
          const engine = engines[i % engines.length];
          if (!engine) break;
          this.direction.copy(engine).multiplyScalar(scale).applyQuaternion(mesh.quaternion);
          const jitter = (): number => (Math.random() * 2 - 1) * 0.3;
          this.particles.emit(
            remote.x + this.direction.x + jitter(),
            remote.y + this.direction.y + jitter(),
            remote.z + this.direction.z + jitter(),
            jitter(),
            jitter(),
            jitter(),
            0.7 + Math.random() * 0.3,
            0.26 * scale * (0.6 + Math.random() * 0.5),
            hex,
          );
        }
      }
    }
    for (const [id, model] of this.remoteShips) {
      if (seen.has(id)) continue;
      this.scene.remove(model.group);
      this.remoteShips.delete(id);
    }
  }

  private drawBullets(bullets: readonly BulletView[], ownId: number): void {
    let solid = 0;
    let glowing = 0;
    // Plasma swells and shrinks a little, 3 times a second.
    this.heavyGlowScale.setScalar(SIM.heavyRadius * (1 + 0.08 * Math.sin(this.seconds.value * 19)));
    for (const bullet of bullets) {
      if (solid >= MAX_BULLETS) break;
      // A stretched dot pointing along its flight.
      this.position.set(bullet.x, bullet.y, bullet.z);
      // A homing shot seen only once has no direction yet.
      if (bullet.dx === 0 && bullet.dy === 0 && bullet.dz === 0) this.direction.copy(this.zAxis);
      else this.direction.set(bullet.dx, bullet.dy, bullet.dz);
      this.orientation.setFromUnitVectors(this.zAxis, this.direction);

      if (bullet.shot === 'seeker' || bullet.shot === 'heavy') {
        const heavy = bullet.shot === 'heavy';
        if (heavy)
          this.particles.emit(bullet.x, bullet.y, bullet.z, 0, 0, 0, 0.3, 0.11, HEAVY_EMBER);
        else this.particles.emit(bullet.x, bullet.y, bullet.z, 0, 0, 0, 0.5, 0.22, SEEKER_TRAIL);
        if (glowing < MAX_GLOWS) {
          const tint = heavy ? HEAVY_COLOR : SEEKER_COLOR;
          this.matrix.compose(
            this.position,
            this.orientation,
            heavy ? this.heavyGlowScale : this.seekerScale,
          );
          this.glows.setMatrixAt(glowing, this.matrix);
          this.glowTints.setXYZW(glowing, tint.r, tint.g, tint.b, heavy ? 1 : SEEKER_ALPHA);
          glowing++;
        }
        // Only the heavy shot has a solid centre.
        if (!heavy) continue;
      }
      this.matrix.compose(
        this.position,
        this.orientation,
        bullet.shot === 'beam'
          ? this.beamScale
          : bullet.shot === 'heavy'
            ? this.heavyCoreScale
            : this.bulletScale,
      );
      this.bullets.setMatrixAt(solid, this.matrix);
      const tint =
        bullet.shot === 'beam'
          ? BEAM_COLOR
          : bullet.shot === 'heavy'
            ? HEAVY_CORE_COLOR
            : bullet.ownerId === ownId
              ? OWN_BULLET_COLOR
              : OTHER_BULLET_COLOR;
      this.bullets.setColorAt(solid, tint);
      // A soft light round each shot, so it reads from far off.
      if (bullet.shot !== 'heavy')
        this.lights.add(
          bullet.x,
          bullet.y,
          bullet.z,
          bullet.shot === 'beam' ? 2.2 : 1.5,
          tint,
          0.55,
        );
      solid++;
    }
    this.bullets.count = solid;
    this.bullets.instanceMatrix.needsUpdate = true;
    if (this.bullets.instanceColor) this.bullets.instanceColor.needsUpdate = true;
    this.glows.count = glowing;
    this.glows.instanceMatrix.needsUpdate = true;
    this.glowTints.needsUpdate = true;
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
