// The ships. Each is built once from simple shapes, joined into one piece
// per material, so a ship costs four or five draws however detailed it is.
// Every model has its nose along +Z and fits inside the hull's radius, so
// what is drawn is what can be hit. (The Fenix is the exception, as it was
// in v1: its wings reach past the hull. Other players' ships are drawn half
// as big again, also as in v1.)
//
// A player's ship can wear a look (`skins.ts`). The six plain looks are paint,
// trim and lights on the two shapes above. The three special ones are ships
// of their own, with a part that moves. No look is drawn further out than the
// standard ship of its shape, and none costs more than five draws.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { NpcKind } from '../shared/progress.ts';
import { STANDARD_LOOKS } from './skins.ts';
import type { Looks, SkinId } from './skins.ts';

type Triple = readonly [number, number, number];

/** Sizes, turns (about x, then y, then z) and moves a shape into its place on a ship. */
function part(
  geometry: BufferGeometry,
  placing: { at?: Triple; turn?: Triple; size?: Triple } = {},
): BufferGeometry {
  const { at, turn, size } = placing;
  if (size) geometry.scale(size[0], size[1], size[2]);
  if (turn) geometry.rotateX(turn[0]).rotateY(turn[1]).rotateZ(turn[2]);
  if (at) geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/** Joins shapes that share a material into one mesh. */
function joined(parts: BufferGeometry[], material: Material): Mesh {
  const loose = parts.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  const whole = mergeGeometries(loose);
  for (const geometry of [...parts, ...loose]) geometry.dispose();
  return new Mesh(whole, material);
}

const HALF = Math.PI / 2;

/** Bright metal, which mirrors the sky. */
function metal(color: number, roughness = 0.3, flatShading = false): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, metalness: 0.85, roughness, flatShading });
}
/** A light: it shines by itself, a little brighter than white so that it glows. */
function light(color: number, gain = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(color).multiplyScalar(gain) });
}
const DARK_TRIM = new MeshStandardMaterial({ color: 0x3a4658, metalness: 0.7, roughness: 0.45 });
/** Dark glass with a light inside it. */
function glass(color: number, emissive: number, emissiveIntensity = 0.55): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    metalness: 0.9,
    roughness: 0.08,
  });
}
const GLASS = glass(0x0c2c40, 0x0b5a78);
/** Materials every ship of a kind shares. They outlive any one ship. */
const SHARED: ReadonlySet<Material> = new Set([DARK_TRIM, GLASS]);

/** A ship as the scene draws it. */
export interface ShipModel {
  readonly group: Group;
  /** The ship's usual shape. */
  readonly base: Group;
  /** The shape it takes after a Fenix orb. */
  readonly fenix: Group;
  /** Where the engines are, in the ship's own frame: the glow and the trail start here. */
  readonly engines: readonly Vector3[];
  readonly fenixEngines: readonly Vector3[];
  /** The colour of its engines and trail, in each shape. */
  readonly engineColor: Color;
  readonly fenixEngineColor: Color;
  /** Moves the parts that move by themselves. `seconds` is the scene's clock. */
  animate(seconds: number): void;
}

/** One shape of a ship, as built. */
interface Form {
  readonly group: Group;
  readonly engines: readonly Vector3[];
  /** Its own engine colour. Without one it takes the ship's usual colour. */
  readonly engineColor?: number;
  /** Moves its moving parts, and may change the engine colour it is handed. */
  readonly animate?: (seconds: number, engineColor: Color) => void;
}

// Paint. A hull's colours are worked out once, point by point, into a small
// picture the graphics card then only looks up, as the sky and the planet are.

/** A colour part of the way from one to another. */
function mix(from: number, to: number, amount: number): number {
  const k = Math.max(0, Math.min(1, amount));
  const channel = (shift: number): number => {
    const a = (from >> shift) & 255;
    const b = (to >> shift) & 255;
    return Math.round(a + (b - a) * k) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}

const scratchColor = new Color();
/** A colour from its place on the colour wheel (0 to 1, and round again). */
function wheel(hue: number, saturation: number, lightness: number): number {
  return scratchColor
    .setHSL(((hue % 1) + 1) % 1, saturation, lightness, SRGBColorSpace)
    .getHex(SRGBColorSpace);
}

function frac(value: number): number {
  return value - Math.floor(value);
}

/** A picture whose colour at each point (0 to 1 each way) is asked of `colorAt`. */
function painted(
  width: number,
  height: number,
  colorAt: (u: number, v: number) => number,
): DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colorAt((x + 0.5) / width, (y + 0.5) / height);
      data.set([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255], (y * width + x) * 4);
    }
  }
  const picture = new DataTexture(data, width, height);
  picture.colorSpace = SRGBColorSpace;
  picture.magFilter = LinearFilter;
  picture.minFilter = LinearMipmapLinearFilter;
  picture.generateMipmaps = true;
  picture.anisotropy = 4;
  picture.wrapS = RepeatWrapping;
  picture.needsUpdate = true;
  return picture;
}

/** A hull's outline from the top of its axis to the bottom: distance out, then height. */
type Profile = readonly (readonly [number, number])[];
/** A turned hull's paint, asked for in the ship's own frame: across, forward, distance out, height. */
type HullPaint = (x: number, z: number, r: number, y: number) => number;

/**
 * A turned hull's picture reaches this far down it. The strip below holds
 * plain colours for the parts that are not turned: the prow, the engines.
 */
const HULL_ROWS = 0.875;
const SWATCHES = 8;

/** The picture for a hull turned from `profile`, and the plain colours beside it. */
function hullPicture(profile: Profile, paint: HullPaint, swatches: readonly number[]): DataTexture {
  const last = profile.length - 1;
  return painted(512, 256, (u, v) => {
    if (v >= HULL_ROWS) return swatches[Math.floor(u * SWATCHES)] ?? 0;
    const along = (v / HULL_ROWS) * last;
    const from = profile[Math.min(last - 1, Math.floor(along))] ?? [0, 0];
    const to = profile[Math.min(last, Math.floor(along) + 1)] ?? from;
    const between = along - Math.floor(along);
    const r = from[0] + (to[0] - from[0]) * between;
    const angle = u * Math.PI * 2;
    return paint(
      r * Math.sin(angle),
      r * Math.cos(angle),
      r,
      from[1] + (to[1] - from[1]) * between,
    );
  });
}

/**
 * A hull turned from `profile`, laid out for `hullPicture`.
 *
 * The standard saucer has always been turned top to bottom, which faces its
 * skin inwards: from above, what is seen is the inside of its belly, a
 * shallow bowl under the dome. That is the ship as players know it, so it is
 * kept (`insideOut`), and the looks painted on it are painted the same on
 * both skins. The special ships are turned the right way out.
 */
function turned(profile: Profile, segments: number, insideOut = false): BufferGeometry {
  const points = profile.map(([r, y]) => new Vector2(r, y));
  const hull = new LatheGeometry(insideOut ? points : points.reverse(), segments);
  const uv = hull.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, (insideOut ? uv.getY(i) : 1 - uv.getY(i)) * HULL_ROWS);
  }
  return hull;
}

/** Gives a whole shape one of the plain colours beside a hull's picture. */
function swatch(geometry: BufferGeometry, index: number): BufferGeometry {
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (index + 0.5) / SWATCHES, (HULL_ROWS + 1) / 2);
  }
  return geometry;
}

// A winged ship's picture is laid over it from above. It covers this much of
// the ship's own frame, which holds every Fenix there is.
const WING_SPAN = 3.5;
const WING_TAIL = -2.8;
const WING_LENGTH = 6.1;
/** A wing's paint: how far out from the middle, and how far forward. */
type WingPaint = (span: number, z: number) => number;

function wingPicture(paint: WingPaint): DataTexture {
  return painted(512, 512, (u, v) =>
    paint(Math.abs(u * 2 - 1) * WING_SPAN, WING_TAIL + v * WING_LENGTH),
  );
}

/** Lays a wing's picture over a shape that is already in its place. */
function fromAbove(geometry: BufferGeometry): BufferGeometry {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (position.getX(i) / WING_SPAN + 1) / 2,
      (position.getZ(i) - WING_TAIL) / WING_LENGTH,
    );
  }
  return geometry;
}

/** Gives a shape a colour of its own, for a material that takes its colours from its shapes. */
function tinted(geometry: BufferGeometry, color: number, gain = 1): BufferGeometry {
  const { r, g, b } = scratchColor.set(color).multiplyScalar(gain);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([r, g, b], i * 3);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}
/** Lights of several colours in one draw: each shape brings its own (`tinted`). */
function lights(): MeshBasicMaterial {
  return new MeshBasicMaterial({ vertexColors: true });
}

/** A straight bar between two points seen from above (across, forward), at one height. */
function strut(
  from: readonly [number, number],
  to: readonly [number, number],
  y: number,
  width: number,
): BufferGeometry {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  return part(new BoxGeometry(width, width, Math.hypot(dx, dz)), {
    turn: [0, Math.atan2(dx, dz), 0],
    at: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
  });
}

/** A flat crystal, pointed at both ends, between two points seen from above. */
function blade(
  from: readonly [number, number],
  to: readonly [number, number],
  y: number,
  halfWidth: number,
  halfHeight: number,
): BufferGeometry {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  return part(new OctahedronGeometry(1, 0), {
    size: [halfWidth, halfHeight, Math.hypot(dx, dz) / 2],
    turn: [0, Math.atan2(dx, dz), 0],
    at: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
  });
}

/** A winged outline seen from above, the same on both sides: nose, one side's corners, tail. */
function winged(nose: number, half: readonly (readonly [number, number])[], tail: number): Shape {
  const outline = new Shape();
  outline.moveTo(0, nose);
  for (const [x, y] of half) outline.lineTo(x, y);
  outline.lineTo(0, tail);
  for (const [x, y] of [...half].reverse()) outline.lineTo(-x, y);
  outline.closePath();
  return outline;
}

/** What a saucer is made of. A look is a set of these on the one shape. */
interface SaucerLivery {
  readonly hull: Material;
  readonly trim: Material;
  readonly glow: Material;
  readonly canopy: Material;
}

const SAUCER_PROFILE: Profile = [
  [0, 0.44],
  [0.5, 0.42],
  [0.78, 0.3],
  [1.25, 0.2],
  [1.82, 0.07],
  [2.0, 0],
  [1.82, -0.08],
  [1.2, -0.24],
  [0.6, -0.34],
  [0, -0.36],
];
/** The plain colours beside a saucer's picture: the prow, then the engines. */
const PROW = 0;
const NACELLE = 1;

/**
 * A player's ship: v1's saucer (main.js:4207-4275) grown up. Still a disc
 * with a dome, but with twin engines behind and a prow in front, so its
 * heading can be read from any side.
 */
function buildSaucer(livery: SaucerLivery): Group {
  const group = new Group();
  const hull = [
    turned(SAUCER_PROFILE, 48, true),
    swatch(
      part(new ConeGeometry(0.3, 0.95, 4), {
        turn: [HALF, 0, 0],
        size: [1, 0.45, 1],
        at: [0, 0.1, 1.5],
      }),
      PROW,
    ),
  ];
  const trim = [
    part(new TorusGeometry(1.08, 0.03, 6, 40), { turn: [HALF, 0, 0], at: [0, 0.25, 0] }),
    part(new BoxGeometry(0.07, 0.34, 0.95), { at: [0, 0.4, -1.15] }),
  ];
  const glow = [
    part(new TorusGeometry(1.95, 0.035, 6, 56), { turn: [HALF, 0, 0] }),
    part(new TorusGeometry(0.85, 0.05, 6, 32), { turn: [HALF, 0, 0], at: [0, -0.31, 0] }),
    part(new SphereGeometry(0.09, 8, 6), { at: [0, 0.13, 1.93] }),
  ];
  for (const side of [1, -1]) {
    hull.push(
      swatch(
        part(new CylinderGeometry(0.2, 0.27, 1.25, 14), {
          turn: [HALF, 0, 0],
          at: [side * 0.72, 0.16, -1.2],
        }),
        NACELLE,
      ),
    );
    trim.push(
      part(new TorusGeometry(0.28, 0.05, 6, 16), { at: [side * 0.72, 0.16, -1.82] }),
      part(new TorusGeometry(0.21, 0.04, 6, 16), { at: [side * 0.72, 0.16, -0.6] }),
    );
    glow.push(
      part(new CircleGeometry(0.23, 14), { turn: [0, Math.PI, 0], at: [side * 0.72, 0.16, -1.83] }),
    );
  }
  const canopy = part(new SphereGeometry(0.56, 24, 10, 0, Math.PI * 2, 0, HALF), {
    size: [1, 0.72, 1.3],
    at: [0, 0.36, 0.2],
  });
  group.add(
    joined(hull, livery.hull),
    joined(trim, livery.trim),
    joined(glow, livery.glow),
    joined([canopy], livery.canopy),
  );
  return group;
}
const SAUCER_ENGINES = [new Vector3(0.72, 0.16, -1.9), new Vector3(-0.72, 0.16, -1.9)];

/** A saucer as it has always been: bare metal, with lights in the colour given. */
function standardSaucer(accent: number): Form {
  return {
    group: buildSaucer({
      hull: metal(0xaeb8c8, 0.34),
      trim: DARK_TRIM,
      glow: light(accent),
      canopy: GLASS,
    }),
    engines: SAUCER_ENGINES,
  };
}

/** A saucer in paint: how shiny the paint is, and the colours of everything else. */
function paintedSaucer(look: {
  paint: HullPaint;
  prow: number;
  nacelle: number;
  metalness: number;
  roughness: number;
  trim: Material;
  lights: number;
  canopy: Material;
  engine: number;
}): Form {
  return {
    group: buildSaucer({
      hull: new MeshStandardMaterial({
        map: hullPicture(SAUCER_PROFILE, look.paint, [look.prow, look.nacelle]),
        metalness: look.metalness,
        roughness: look.roughness,
      }),
      trim: look.trim,
      glow: light(look.lights, 1.1),
      canopy: look.canopy,
    }),
    engines: SAUCER_ENGINES,
    engineColor: look.engine,
  };
}

/** Comet: a racer. Pearl white, two red stripes nose to tail, red rim and engines. */
function buildComet(): Form {
  const pearl = 0xf1f3f7;
  const red = 0xd81e2c;
  const navy = 0x18223c;
  return paintedSaucer({
    paint: (x, _z, r) => {
      if (r > 1.8) return red;
      const off = Math.abs(x);
      if (off > 0.2 && off < 0.47) return red;
      if (off > 0.54 && off < 0.6) return navy;
      return pearl;
    },
    prow: red,
    nacelle: red,
    metalness: 0.15,
    roughness: 0.3,
    trim: metal(navy, 0.4),
    lights: 0xff5d4a,
    canopy: GLASS,
    engine: 0xff8266,
  });
}

/** Tidal: sea-green anodised metal with brass fittings, the rim cut into sixteen panels. */
function buildTidal(): Form {
  const teal = 0x12a39a;
  const deep = 0x075a63;
  const brass = 0xdcaa45;
  return paintedSaucer({
    paint: (x, z, r) => {
      if ((r > 0.78 && r < 0.92) || (r > 1.2 && r < 1.27)) return brass;
      if (r >= 1.27) {
        const panel = Math.floor((Math.atan2(x, z) / (Math.PI * 2) + 1) * 16);
        return panel % 2 === 0 ? teal : deep;
      }
      return teal;
    },
    prow: brass,
    nacelle: deep,
    metalness: 0.5,
    roughness: 0.3,
    trim: metal(brass, 0.3),
    lights: 0x5dffb4,
    canopy: glass(0x06302c, 0x18c79a),
    engine: 0x66ffc4,
  });
}

/** Hornet: warning yellow with black chevrons round the rim, pointing forward. */
function buildHornet(): Form {
  const yellow = 0xffc610;
  const black = 0x121318;
  return paintedSaucer({
    paint: (x, z, r) => {
      if (r < 0.8) return black;
      if (r < 1.25) return yellow;
      const round = Math.abs(Math.atan2(x, z)) / (Math.PI * 2);
      return frac(round * 14 + r * 1.6) < 0.5 ? yellow : black;
    },
    prow: black,
    nacelle: yellow,
    metalness: 0.15,
    roughness: 0.35,
    trim: metal(black, 0.5),
    lights: 0xfff3b0,
    canopy: glass(0x2a1800, 0xff9a10),
    engine: 0xffe680,
  });
}

/** What a Fenix is made of. A look is a set of these on the one shape. */
interface FenixLivery {
  readonly wing: Material;
  readonly body: Material;
  readonly canopy: Material;
  readonly edges: Material;
  readonly engines: Material;
}

/**
 * The Fenix: a swept-wing raptor in deep red, edged in glowing gold.
 * v1's was a plain black dart (main.js:5038-5094), which vanished against space.
 */
function buildFenix(livery: FenixLivery): Group {
  const group = new Group();
  // Wings, drawn from above: x across, y forward. Swept back, with a notched trailing edge.
  const half: [number, number][] = [
    [0.5, 1.3],
    [3.4, -2.3],
    [3.0, -2.7],
    [1.4, -1.2],
    [0.7, -2.1],
  ];
  const outline = new Shape();
  outline.moveTo(0, 1.6);
  for (const [x, y] of half) outline.lineTo(x, y);
  outline.lineTo(0, -1.5);
  for (const [x, y] of [...half].reverse()) outline.lineTo(-x, y);
  outline.closePath();
  const hull = [
    part(new ExtrudeGeometry(outline, { depth: 0.1, bevelEnabled: false }), {
      turn: [HALF, 0, 0],
      at: [0, 0.05, 0],
    }),
  ];
  const edges: BufferGeometry[] = [];
  const engines: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    // A glowing strip along each leading edge, from wing root to wing tip.
    edges.push(
      part(new BoxGeometry(4.6, 0.1, 0.12), {
        turn: [0, side === 1 ? 0.893 : Math.PI - 0.893, 0],
        at: [side * 1.95, 0.08, -0.5],
      }),
    );
    hull.push(
      part(new BoxGeometry(0.08, 0.95, 1.2), {
        turn: [0, 0, side * -0.5],
        at: [side * 0.75, 0.45, -1.5],
      }),
    );
    engines.push(part(new SphereGeometry(0.34, 12, 8), { at: [side * 0.5, 0, -2.05] }));
  }
  // The body is a cone laid along the nose and flattened.
  const body = part(new ConeGeometry(0.8, 5.4, 6), {
    size: [1, 1, 0.6],
    turn: [HALF, 0, 0],
    at: [0, 0, 0.5],
  });
  const canopy = part(new SphereGeometry(0.4, 12, 8), { size: [0.7, 0.5, 1.9], at: [0, 0.3, 0.7] });
  group.add(
    joined(hull.map(fromAbove), livery.wing),
    joined([body], livery.body),
    joined([canopy], livery.canopy),
    joined(edges, livery.edges),
    joined(engines, livery.engines),
  );
  return group;
}
const FENIX_ENGINES = [new Vector3(0.5, 0, -2.3), new Vector3(-0.5, 0, -2.3)];

/** The Fenix as it has always been. Its engines glow in the ship's usual colour. */
function standardFenix(): Form {
  return {
    group: buildFenix({
      wing: new MeshStandardMaterial({
        color: 0xb81d14,
        emissive: 0x2a0502,
        metalness: 0.3,
        roughness: 0.35,
        flatShading: true,
      }),
      body: metal(0x4a505e, 0.4, true),
      canopy: GLASS,
      edges: light(0xffa01e),
      engines: light(0xff5a1e),
    }),
    engines: FENIX_ENGINES,
  };
}

/** How far a point on a Fenix wing is behind the wing's leading edge. */
function behindLeadingEdge(span: number, z: number): number {
  return (span - 0.5) * -0.7787 + (z - 1.3) * -0.6273;
}

/** A Fenix in paint. */
function paintedFenix(look: {
  paint: WingPaint;
  metalness: number;
  roughness: number;
  body: number;
  canopy: Material;
  edges: number;
  engines: number;
  engine: number;
}): Form {
  return {
    group: buildFenix({
      wing: new MeshStandardMaterial({
        map: wingPicture(look.paint),
        metalness: look.metalness,
        roughness: look.roughness,
        flatShading: true,
      }),
      body: metal(look.body, 0.35, true),
      canopy: look.canopy,
      edges: light(look.edges, 1.1),
      engines: light(look.engines),
    }),
    engines: FENIX_ENGINES,
    engineColor: look.engine,
  };
}

/** Frostbite: ice white at the leading edge, deepening to glacier blue, ruled with frost. */
function buildFrostbite(): Form {
  return paintedFenix({
    paint: (span, z) => {
      const behind = behindLeadingEdge(span, z);
      if (frac(behind / 0.5) < 0.1) return 0xdff2ff;
      return mix(0x8fc4f0, 0x0b47a8, behind / 2.0);
    },
    metalness: 0.15,
    roughness: 0.5,
    body: 0x6f8fb5,
    canopy: GLASS,
    edges: 0x8ff0ff,
    engines: 0x49d6ff,
    engine: 0x6fe2ff,
  });
}

/** Venom: green scales banded in black, with acid wing tips. */
function buildVenom(): Form {
  return paintedFenix({
    paint: (span, z) => {
      if (span > 2.85) return 0xb4f51e;
      const behind = behindLeadingEdge(span, z) + 0.1 * Math.sin(span * 9);
      return Math.floor(behind / 0.42) % 2 === 0 ? 0x0a8c2e : 0x04140a;
    },
    metalness: 0.15,
    roughness: 0.5,
    body: 0x232b26,
    canopy: glass(0x1a2a04, 0x8ac000),
    edges: 0xb8ff3c,
    engines: 0x6dff3a,
    engine: 0x8cff55,
  });
}

/** Dusk: violet at the root, through magenta, to a burning orange at the tips. */
function buildDusk(): Form {
  return paintedFenix({
    paint: (span, z) => {
      const behind = behindLeadingEdge(span, z);
      if (behind > 0.14 && behind < 0.26) return 0xffc840;
      const out = span / 3.4;
      return out < 0.5
        ? mix(0x2c0c7a, 0xb00c66, out * 2)
        : mix(0xb00c66, 0xe05c0c, (out - 0.5) * 2);
    },
    metalness: 0.15,
    roughness: 0.5,
    body: 0x3a2456,
    canopy: GLASS,
    edges: 0xffc2e2,
    engines: 0xff4fb0,
    engine: 0xff6ec4,
  });
}

/**
 * A raider: a dark pincer with red lights. Two prongs reach forward past
 * the cockpit, which no player's ship does, so it is known at a glance.
 */
function buildRaider(): Group {
  const group = new Group();
  const half: [number, number][] = [
    [0.32, 0.75],
    [0.5, 1.93],
    [0.98, 0.85],
    [1.78, -0.45],
    [1.25, -0.95],
    [0.62, -0.7],
    [0.45, -1.55],
  ];
  const outline = new Shape();
  outline.moveTo(0, 0.45);
  for (const [x, y] of half) outline.lineTo(x, y);
  outline.lineTo(0, -1.2);
  for (const [x, y] of [...half].reverse()) outline.lineTo(-x, y);
  outline.closePath();
  const hull = [
    part(
      new ExtrudeGeometry(outline, {
        depth: 0.18,
        bevelEnabled: true,
        bevelSize: 0.06,
        bevelThickness: 0.06,
        bevelSegments: 1,
      }),
      { turn: [HALF, 0, 0], at: [0, 0.09, 0] },
    ),
  ];
  const pod = [
    part(new SphereGeometry(0.5, 16, 10), { size: [0.9, 0.62, 2.1], at: [0, 0.12, -0.2] }),
  ];
  const lights = [
    part(new SphereGeometry(0.16, 10, 8), { size: [1.6, 0.6, 1], at: [0, 0.34, 0.5] }),
    part(new CircleGeometry(0.26, 12), { turn: [0, Math.PI, 0], at: [0, 0.12, -1.26] }),
  ];
  for (const side of [1, -1]) {
    // A red strip down the inside of each prong, and a light at each wing tip.
    lights.push(
      part(new BoxGeometry(0.05, 0.05, 1.1), {
        turn: [0, side * 0.15, 0],
        at: [side * 0.37, 0.2, 1.3],
      }),
      part(new SphereGeometry(0.07, 8, 6), { at: [side * 1.74, 0.1, -0.45] }),
    );
  }
  group.add(
    joined(hull, metal(0x3a3340, 0.42, true)),
    joined(pod, metal(0x7d241c, 0.35)),
    joined(lights, light(0xff3a1c, 1.2)),
  );
  return group;
}
const RAIDER_ENGINES = [new Vector3(0, 0.12, -1.4)];

/**
 * The Warlock: a dark crystal with a burning heart, a crown of spikes swept
 * back from it, and a ring of light that turns around it.
 */
function buildWarlock(): { group: Group; spinner: Object3D } {
  const group = new Group();
  const core = [part(new OctahedronGeometry(0.8, 0), { size: [1, 0.72, 2.2] })];
  for (let i = 0; i < 6; i++) {
    // Six spikes round the middle, leaning back.
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    core.push(
      part(new ConeGeometry(0.15, 1.5, 5), { at: [0, 0.95, 0] })
        .rotateX(-0.65)
        .rotateZ(angle)
        .translate(0, 0, -0.2),
    );
  }
  for (const side of [1, -1]) {
    core.push(
      part(new ConeGeometry(0.13, 1.5, 5), { turn: [HALF, 0, 0], at: [side * 0.5, -0.1, 1.2] }),
    );
  }
  // The same crystal, turned and a little smaller: its corners break through as seams of light.
  const heart = [
    part(new OctahedronGeometry(0.8, 0), { size: [1.02, 0.5, 2.0] }),
    part(new IcosahedronGeometry(0.3, 0), { at: [0, 0, -1.55] }),
  ];
  const spinner = joined(
    [
      new TorusGeometry(1.7, 0.04, 6, 64),
      part(new OctahedronGeometry(0.12, 0), { at: [1.7, 0, 0] }),
      part(new OctahedronGeometry(0.12, 0), { at: [-1.7, 0, 0] }),
      part(new OctahedronGeometry(0.12, 0), { at: [0, 1.7, 0] }),
      part(new OctahedronGeometry(0.12, 0), { at: [0, -1.7, 0] }),
    ],
    light(0xc070ff, 1.2),
  );
  group.add(
    joined(core, metal(0x6a45a8, 0.38, true)),
    joined(heart, light(0xa050ff, 1.2)),
    spinner,
  );
  return { group, spinner };
}
const WARLOCK_ENGINES = [new Vector3(0, 0, -1.9)];

// The three special looks. Each is a ship of its own in both shapes: a
// different outline, a part that moves, and engines of its own colour.

/** A crystal: every facet mirrors the sky and carries a colour of its own, faintly lit from inside. */
function crystal(picture: DataTexture): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: picture,
    emissive: 0xffffff,
    emissiveMap: picture,
    emissiveIntensity: 0.22,
    metalness: 0.9,
    roughness: 0.14,
    flatShading: true,
  });
}
const PRISM_WHITE = 0xf4f6ff;
/** How fast Prism's colours go round: turns of the colour wheel a second. */
const PRISM_RATE = 0.1;

/** What all of Prism turns each frame: its colours slide, and its heart and engines follow them. */
function prismColors(
  picture: DataTexture,
  heart: MeshStandardMaterial,
  seconds: number,
  engineColor: Color,
): void {
  picture.offset.x = seconds * PRISM_RATE * 0.5;
  const hue = frac(seconds * PRISM_RATE);
  heart.emissive.setHSL(hue, 1, 0.5, SRGBColorSpace);
  engineColor.setHSL(hue, 1, 0.68, SRGBColorSpace);
}

const PRISM_PROFILE: Profile = [
  [0, 0.42],
  [0.55, 0.42],
  [1.15, 0.2],
  [1.5, 0.04],
  [1.5, -0.04],
  [0.7, -0.34],
  [0, -0.4],
];
const PRISM_SAUCER_ENGINES = [new Vector3(0.36, 0, -1.72), new Vector3(-0.36, 0, -1.72)];

/**
 * Prism, the saucer: a cut gem with eight sides, every facet a different
 * colour, and six shards of light circling its girdle.
 */
function buildPrismSaucer(): Form {
  const group = new Group();
  const picture = hullPicture(
    PRISM_PROFILE,
    (x, z, r, y) =>
      r < 0.55 && y > 0
        ? PRISM_WHITE
        : wheel(Math.atan2(x, z) / (Math.PI * 2) + r * 0.06, 0.85, y > 0 ? 0.6 : 0.5),
    Array.from({ length: SWATCHES }, () => PRISM_WHITE),
  );
  const hull = [
    turned(PRISM_PROFILE, 8),
    swatch(
      part(new ConeGeometry(0.2, 0.95, 4), {
        turn: [HALF, 0, 0],
        size: [1, 0.5, 1],
        at: [0, 0.02, 1.5],
      }),
      PROW,
    ),
  ];
  const glow = [
    // Eight-sided, to lie along the gem's girdle.
    part(new TorusGeometry(1.5, 0.03, 6, 8), { turn: [HALF, 0, 0] }),
    part(new SphereGeometry(0.07, 8, 6), { at: [0, 0.02, 1.95] }),
  ];
  for (const side of [1, -1]) {
    hull.push(
      swatch(blade([side * 0.55, -0.9], [side * 0.95, -1.72], 0.02, 0.2, 0.09), PROW),
      swatch(
        part(new CylinderGeometry(0.14, 0.18, 0.5, 6), {
          turn: [HALF, 0, 0],
          at: [side * 0.36, 0, -1.42],
        }),
        PROW,
      ),
    );
    glow.push(
      part(new CircleGeometry(0.15, 6), { turn: [0, Math.PI, 0], at: [side * 0.36, 0, -1.68] }),
    );
  }
  const shards: BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    shards.push(
      tinted(
        part(new OctahedronGeometry(1, 0), {
          size: [0.09, 0.26, 0.09],
          at: [Math.sin(angle) * 1.78, 0.05, Math.cos(angle) * 1.78],
        }),
        wheel(i / 6, 1, 0.62),
        1.25,
      ),
    );
  }
  const circling = joined(shards, lights());
  const heart = glass(0x10162c, 0xffffff, 0.9);
  group.add(
    joined(hull, crystal(picture)),
    joined(glow, light(0xeaf2ff, 1.2)),
    joined([part(new ConeGeometry(0.5, 0.26, 8), { at: [0, 0.55, 0] })], heart),
    circling,
  );
  return {
    group,
    engines: PRISM_SAUCER_ENGINES,
    engineColor: 0xffffff,
    animate(seconds, engineColor) {
      circling.rotation.y = seconds * 0.9;
      prismColors(picture, heart, seconds, engineColor);
    },
  };
}

const PRISM_FENIX_ENGINES = [new Vector3(0.28, 0, -1.85), new Vector3(-0.28, 0, -1.85)];
/** Prism's wing, one side: four crystals fanned back, each from its root to its tip, and how wide. */
const PRISM_BLADES: readonly (readonly [number, number, number, number, number])[] = [
  [0.3, 1.0, 3.3, -2.2, 0.34],
  [0.3, 0.4, 2.55, -2.5, 0.3],
  [0.3, -0.2, 1.75, -2.6, 0.27],
  [0.25, -0.7, 0.95, -2.6, 0.22],
];

/**
 * Prism, the Fenix: wings that are four long crystals a side, a light running
 * down the ridge of each, and three shards circling the nose.
 */
function buildPrismFenix(): Form {
  const group = new Group();
  const picture = wingPicture((span) => wheel(0.5 + (span / WING_SPAN) * 0.9, 0.85, 0.6));
  const hull = [blade([0, -1.7], [0, 3.1], 0, 0.42, 0.3)];
  const ridges: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    for (const [i, [x0, z0, x1, z1, width]] of PRISM_BLADES.entries()) {
      const y = 0.1 - i * 0.05;
      hull.push(blade([side * x0, z0], [side * x1, z1], y, width, 0.08));
      // The same crystal, thin and a little taller: its ridge breaks through as a line of light.
      ridges.push(
        tinted(
          blade([side * x0, z0], [side * x1, z1], y, 0.045, 0.1),
          wheel(0.55 + i * 0.22, 1, 0.72),
          1.2,
        ),
      );
    }
    ridges.push(
      tinted(part(new SphereGeometry(0.2, 10, 8), { at: [side * 0.28, 0, -1.6] }), 0xffffff, 1.2),
    );
  }
  const shards: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    shards.push(
      tinted(
        part(new OctahedronGeometry(1, 0), {
          size: [0.07, 0.07, 0.28],
          at: [Math.cos(angle) * 0.55, Math.sin(angle) * 0.55, 0],
        }),
        wheel(i / 3, 1, 0.62),
        1.25,
      ),
    );
  }
  const circling = joined(shards, lights());
  circling.position.z = 1.9;
  const heart = glass(0x10162c, 0xffffff, 0.9);
  group.add(
    joined(hull.map(fromAbove), crystal(picture)),
    joined(ridges, lights()),
    joined(
      [part(new OctahedronGeometry(1, 0), { size: [0.2, 0.16, 0.7], at: [0, 0.24, 1.1] })],
      heart,
    ),
    circling,
  );
  return {
    group,
    engines: PRISM_FENIX_ENGINES,
    engineColor: 0xffffff,
    animate(seconds, engineColor) {
      circling.rotation.z = seconds * 1.6;
      prismColors(picture, heart, seconds, engineColor);
    },
  };
}

const GOLD = 0xffc247;
const BRONZE = 0x8a5512;
const WHITE_GOLD = 0xfff0b0;

/**
 * Gold with lines cut into it that burn. A turned hull is polished and
 * mirrors the sky. A flat wing is not: a mirror that big shows one patch of
 * sky and no gold, so a wing is gilt, which keeps its own colour.
 */
function burningGold(
  picture: DataTexture,
  burning: DataTexture,
  wing: boolean,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: picture,
    emissive: 0xffffff,
    emissiveMap: burning,
    metalness: wing ? 0.35 : 0.9,
    roughness: wing ? 0.4 : 0.22,
    flatShading: wing,
  });
}
/** Solar Crown's fire rises and falls, a little under three seconds a breath. */
function solarGlow(seconds: number): number {
  return 1.25 + 0.5 * Math.sin(seconds * 2.2);
}

const SOLAR_PROFILE: Profile = [
  [0, 0.5],
  [0.34, 0.47],
  [0.6, 0.36],
  [0.8, 0.3],
  [1.2, 0.2],
  [1.5, 0.08],
  [1.62, 0],
  [1.5, -0.1],
  [1.0, -0.26],
  [0.5, -0.34],
  [0, -0.36],
];
/** Where Solar Crown's rays stand round the rim, in degrees from the nose. None where the engines are. */
const SOLAR_RAYS = [15, 45, 75, 105, 135, 225, 255, 285, 315, 345];

/**
 * Solar Crown, the saucer: polished gold cut with twenty-four burning rays,
 * a crown of ten spikes round the rim, and a halo turning above the dome.
 */
function buildSolarSaucer(): Form {
  const group = new Group();
  /** Whether a point on the top of the hull is on one of the rays or the ring they start from. */
  const onRay = (x: number, z: number, r: number, y: number): boolean =>
    y >= -0.02 &&
    ((r > 0.86 && r < 0.92) ||
      (r >= 0.92 && r < 1.5 && frac((Math.atan2(x, z) / (Math.PI * 2)) * 24) < 0.14));
  const picture = hullPicture(
    SOLAR_PROFILE,
    (x, z, r, y) => {
      if (y < -0.02) return mix(GOLD, BRONZE, 0.5);
      if (onRay(x, z, r, y)) return 0xffe59a;
      if (r > 0.8 && r <= 0.86) return BRONZE;
      return GOLD;
    },
    [GOLD, GOLD],
  );
  const burning = hullPicture(
    SOLAR_PROFILE,
    (x, z, r, y) => (onRay(x, z, r, y) ? WHITE_GOLD : 0),
    [],
  );
  const hull = [
    turned(SOLAR_PROFILE, 48),
    swatch(
      part(new ConeGeometry(0.3, 0.95, 4), {
        turn: [HALF, 0, 0],
        size: [1, 0.45, 1],
        at: [0, 0.06, 1.5],
      }),
      PROW,
    ),
  ];
  for (const [i, degrees] of SOLAR_RAYS.entries()) {
    const angle = (degrees * Math.PI) / 180;
    const length = i % 2 === 0 ? 0.6 : 0.38;
    const middle = 1.45 + length / 2;
    hull.push(
      swatch(
        part(new ConeGeometry(0.15, length, 4), {
          size: [1, 1, 0.3],
          turn: [HALF, angle, 0],
          at: [Math.sin(angle) * middle, 0.02, Math.cos(angle) * middle],
        }),
        PROW,
      ),
    );
  }
  const trim = [part(new BoxGeometry(0.07, 0.3, 0.9), { at: [0, 0.36, -1.0] })];
  const glow = [
    part(new TorusGeometry(1.62, 0.03, 6, 56), { turn: [HALF, 0, 0] }),
    part(new TorusGeometry(0.8, 0.05, 6, 32), { turn: [HALF, 0, 0], at: [0, -0.3, 0] }),
    part(new SphereGeometry(0.09, 8, 6), { at: [0, 0.08, 1.93] }),
  ];
  for (const side of [1, -1]) {
    hull.push(
      swatch(
        part(new CylinderGeometry(0.2, 0.27, 1.25, 14), {
          turn: [HALF, 0, 0],
          at: [side * 0.72, 0.16, -1.2],
        }),
        NACELLE,
      ),
    );
    trim.push(
      part(new TorusGeometry(0.28, 0.05, 6, 16), { at: [side * 0.72, 0.16, -1.82] }),
      part(new TorusGeometry(0.21, 0.04, 6, 16), { at: [side * 0.72, 0.16, -0.6] }),
    );
    glow.push(
      part(new CircleGeometry(0.23, 14), { turn: [0, Math.PI, 0], at: [side * 0.72, 0.16, -1.83] }),
    );
  }
  const canopy = part(new SphereGeometry(0.5, 24, 10, 0, Math.PI * 2, 0, HALF), {
    size: [1, 0.7, 1.2],
    at: [0, 0.4, 0.15],
  });
  const halo = [part(new TorusGeometry(0.74, 0.028, 6, 48), { turn: [HALF, 0, 0] })];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    halo.push(
      part(new OctahedronGeometry(1, 0), {
        size: [0.06, 0.06, 0.16],
        turn: [0, angle, 0],
        at: [Math.sin(angle) * 0.74, 0, Math.cos(angle) * 0.74],
      }),
    );
  }
  const turning = joined(halo, light(0xfff4cc, 1.3));
  turning.position.y = 1.0;
  const gold = burningGold(picture, burning, false);
  group.add(
    joined(hull, gold),
    joined(trim, metal(0x5a3510, 0.4)),
    joined(glow, light(0xffdc8f, 1.15)),
    joined([canopy], glass(0x3a1c00, 0xff9a20, 0.9)),
    turning,
  );
  return {
    group,
    engines: SAUCER_ENGINES,
    engineColor: 0xffcf70,
    animate(seconds) {
      turning.rotation.y = seconds * -0.7;
      gold.emissiveIntensity = solarGlow(seconds);
    },
  };
}

/**
 * Solar Crown, the Fenix: the firebird itself. Gold wings cut into feathers
 * that burn white at their tips, three tail feathers, a crest swept back
 * from the head, and a wheel of light standing behind it.
 */
function buildSolarFenix(): Form {
  const group = new Group();
  /** How far behind this wing's leading edge a point is, as a part of the wing's depth. */
  const back = (span: number, z: number): number =>
    ((span - 0.45) * -0.7553 + (z - 1.5) * -0.6554) / 2.3;
  const onBody = (span: number, z: number): boolean => span < 0.5 && z > -0.9;
  const onTail = (span: number, z: number): boolean => span < 0.9 && z < -1.3;
  const picture = wingPicture((span, z) => {
    // Darker than gold looks: a flat wing takes the sun full on, and the picture is brightened after.
    if (onBody(span, z)) return 0xc48a00;
    if (onTail(span, z)) return mix(0xc48a00, 0xecb822, (-1.3 - z) / 1.4);
    const depth = back(span, z);
    if (frac(depth / 0.26) < 0.08) return 0x3a1e02;
    return depth < 0.5
      ? mix(0xa85c00, 0xc48a00, depth * 2)
      : mix(0xc48a00, 0xecb822, (depth - 0.5) * 2);
  });
  const burning = wingPicture((span, z) => {
    if (onBody(span, z)) return 0;
    if (onTail(span, z)) return mix(0, 0xff8a20, (-1.6 - z) / 1.1);
    return mix(0, 0xff8a20, (back(span, z) - 0.7) / 0.3);
  });
  const outline = winged(
    1.7,
    [
      [0.45, 1.5],
      [3.4, -1.9],
      [3.0, -2.6],
      [2.6, -1.85],
      [2.25, -2.65],
      [1.85, -1.6],
      [1.55, -2.45],
      [1.2, -1.3],
      [0.9, -2.05],
      [0.55, -1.05],
    ],
    -1.3,
  );
  const hull = [
    part(new ExtrudeGeometry(outline, { depth: 0.1, bevelEnabled: false }), {
      turn: [HALF, 0, 0],
      at: [0, 0.05, 0],
    }),
    part(new ConeGeometry(0.6, 5.4, 6), { size: [1, 1, 0.6], turn: [HALF, 0, 0], at: [0, 0, 0.5] }),
    blade([0, -0.9], [0, -2.7], -0.02, 0.2, 0.05),
  ];
  const fire: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    hull.push(blade([side * 0.2, -0.9], [side * 0.75, -2.6], -0.02, 0.17, 0.05));
    fire.push(
      tinted(strut([side * 0.45, 1.5], [side * 3.3, -1.78], 0.1, 0.08), 0xffe2a0, 1.1),
      tinted(part(new SphereGeometry(0.3, 12, 8), { at: [side * 0.5, 0, -2.05] }), 0xffa040, 1.1),
    );
  }
  for (const k of [-1, 0, 1]) {
    // The crest: three spines leaning back over the head.
    hull.push(
      part(new ConeGeometry(0.06, k === 0 ? 0.9 : 0.7, 4), {
        turn: [-1.15, 0, 0],
        at: [k * 0.14, 0.42, 1.25 - Math.abs(k) * 0.15],
      }),
    );
  }
  const wheelOfLight: BufferGeometry[] = [new TorusGeometry(0.5, 0.03, 6, 40)];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    wheelOfLight.push(
      part(new OctahedronGeometry(1, 0), {
        size: [0.05, 0.14, 0.05],
        turn: [0, 0, -angle],
        at: [Math.sin(angle) * 0.58, Math.cos(angle) * 0.58, 0],
      }),
    );
  }
  const turning = joined(wheelOfLight, light(0xfff4cc, 1.3));
  turning.position.set(0, 0.72, 0.1);
  const gold = burningGold(picture, burning, true);
  const canopy = part(new SphereGeometry(0.4, 12, 8), {
    size: [0.6, 0.5, 1.7],
    at: [0, 0.26, 0.8],
  });
  group.add(
    joined(hull.map(fromAbove), gold),
    joined([canopy], glass(0x3a1c00, 0xff9a20, 0.9)),
    joined(fire, lights()),
    turning,
  );
  return {
    group,
    engines: FENIX_ENGINES,
    engineColor: 0xffc86a,
    animate(seconds) {
      turning.rotation.z = seconds * 0.8;
      gold.emissiveIntensity = solarGlow(seconds);
    },
  };
}

const ROSE = 0xff5c8a;
/** What a Phantom is made of in place of a hull: light you can see through. */
function ghost(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: ROSE,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
}
/** How solid a Phantom looks: it breathes, and now and then it flares. */
function ghostOpacity(seconds: number): number {
  const flare = Math.sin(seconds * 1.7) * Math.sin(seconds * 7.3) > 0.9 ? 0.16 : 0;
  return 0.17 + 0.05 * Math.sin(seconds * 3.1) + flare;
}
/** The cage of three rings that tumbles round a Phantom's heart. */
function ghostCage(): Mesh {
  return joined(
    [
      tinted(new TorusGeometry(0.5, 0.018, 6, 40), 0xffc4d6, 1.3),
      tinted(part(new TorusGeometry(0.44, 0.018, 6, 36), { turn: [HALF, 0, 0] }), 0xffc4d6, 1.3),
      tinted(part(new TorusGeometry(0.38, 0.018, 6, 32), { turn: [0, HALF, 0] }), 0xffc4d6, 1.3),
    ],
    lights(),
  );
}

const PHANTOM_PROFILE: Profile = [
  [0, 0.3],
  [0.6, 0.27],
  [1.3, 0.14],
  [1.9, 0],
  [1.3, -0.14],
  [0.6, -0.24],
  [0, -0.26],
];
const PHANTOM_SAUCER_ENGINES = [new Vector3(0.6, 0.05, -1.86), new Vector3(-0.6, 0.05, -1.86)];

/**
 * Phantom, the saucer: no hull at all. A lens of rose light, the lines of a
 * ship drawn on it, spokes that turn inside it and a white heart in a
 * tumbling cage.
 */
function buildPhantomSaucer(): Form {
  const group = new Group();
  const line = (geometry: BufferGeometry): BufferGeometry => tinted(geometry, ROSE, 1.25);
  const heart = (geometry: BufferGeometry): BufferGeometry => tinted(geometry, 0xffffff, 1.5);
  const lines = [
    line(part(new TorusGeometry(1.9, 0.03, 6, 64), { turn: [HALF, 0, 0] })),
    line(part(new TorusGeometry(1.3, 0.02, 6, 48), { turn: [HALF, 0, 0], at: [0, 0.14, 0] })),
    line(part(new TorusGeometry(1.3, 0.02, 6, 48), { turn: [HALF, 0, 0], at: [0, -0.14, 0] })),
    line(part(new TorusGeometry(0.6, 0.02, 6, 32), { turn: [HALF, 0, 0], at: [0, 0.27, 0] })),
    heart(new IcosahedronGeometry(0.26, 1)),
    heart(part(new SphereGeometry(0.07, 8, 6), { at: [0, 0.03, 1.93] })),
  ];
  for (const side of [1, -1]) {
    lines.push(
      // An arrowhead at the nose, and a strut back to each engine: which way it is going.
      line(strut([side * 0.45, 1.55], [0, 1.96], 0.03, 0.045)),
      line(strut([side * 0.6, -1.0], [side * 0.6, -1.78], 0.05, 0.05)),
      heart(part(new SphereGeometry(0.12, 10, 8), { at: [side * 0.6, 0.05, -1.78] })),
    );
  }
  const spokes: BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    // From the inner ring down to the rim, lying on the lens.
    spokes.push(
      line(
        part(new BoxGeometry(0.03, 0.03, 1.3), { turn: [0.2047, 0, 0], at: [0, 0.135, 1.25] }),
      ).rotateY((i / 10) * Math.PI * 2),
    );
  }
  const shell = ghost();
  const turning = joined(spokes, lights());
  const cage = ghostCage();
  group.add(joined([turned(PHANTOM_PROFILE, 40)], shell), joined(lines, lights()), turning, cage);
  return {
    group,
    engines: PHANTOM_SAUCER_ENGINES,
    engineColor: 0xff8fb0,
    animate(seconds) {
      turning.rotation.y = seconds * 0.4;
      cage.rotation.set(seconds * 1.3, seconds * 0.9, 0);
      shell.opacity = ghostOpacity(seconds);
    },
  };
}

const PHANTOM_FENIX_ENGINES = [new Vector3(0.3, 0, -1.7), new Vector3(-0.3, 0, -1.7)];
/** A Phantom wing's ribs, one side: from the leading edge back to each feather's tip. */
const PHANTOM_RIBS: readonly (readonly [number, number, number, number])[] = [
  [2.7, -1.18, 3.05, -2.6],
  [1.8, -0.13, 2.0, -2.4],
  [1.05, 0.74, 1.0, -2.2],
];

/**
 * Phantom, the Fenix: the ghost of a bird. Wings of rose light with their
 * leading edges and ribs drawn in, and the same caged heart.
 */
function buildPhantomFenix(): Form {
  const group = new Group();
  const line = (geometry: BufferGeometry): BufferGeometry => tinted(geometry, ROSE, 1.25);
  const heart = (geometry: BufferGeometry): BufferGeometry => tinted(geometry, 0xffffff, 1.5);
  const outline = winged(
    1.7,
    [
      [0.4, 1.5],
      [3.4, -2.0],
      [3.05, -2.6],
      [2.3, -1.5],
      [2.0, -2.4],
      [1.3, -1.0],
      [1.0, -2.2],
      [0.45, -0.8],
    ],
    -2.3,
  );
  const lines = [
    line(strut([0, -2.3], [0, 3.0], 0.02, 0.04)),
    heart(part(new IcosahedronGeometry(0.24, 1), { at: [0, 0, 0.3] })),
  ];
  for (const side of [1, -1]) {
    lines.push(
      line(strut([side * 0.4, 1.5], [side * 3.4, -2.0], 0.06, 0.08)),
      heart(part(new SphereGeometry(0.16, 10, 8), { at: [side * 0.3, 0, -1.5] })),
    );
    for (const [x0, z0, x1, z1] of PHANTOM_RIBS) {
      lines.push(line(strut([side * x0, z0], [side * x1, z1], 0.04, 0.04)));
    }
  }
  const shell = ghost();
  const cage = ghostCage();
  cage.position.z = 0.3;
  group.add(
    joined(
      [
        part(new ExtrudeGeometry(outline, { depth: 0.04, bevelEnabled: false }), {
          turn: [HALF, 0, 0],
          at: [0, 0.02, 0],
        }),
        blade([0, -2.1], [0, 3.1], 0, 0.45, 0.3),
      ],
      shell,
    ),
    joined(lines, lights()),
    cage,
  );
  return {
    group,
    engines: PHANTOM_FENIX_ENGINES,
    engineColor: 0xff8fb0,
    animate(seconds) {
      cage.rotation.set(seconds * 1.3, seconds * 0.9, 0);
      shell.opacity = ghostOpacity(seconds);
    },
  };
}

/** A player's lights are cyan on their own screen and amber on everyone else's. */
const OWN_ACCENT = 0x1ec8ff;
const OTHER_ACCENT = 0xff9a2e;

/** A player's ship in its own shape, in the look asked for. */
function saucerIn(skin: SkinId, accent: number): Form {
  switch (skin) {
    case 'comet':
      return buildComet();
    case 'tidal':
      return buildTidal();
    case 'hornet':
      return buildHornet();
    case 'prism':
      return buildPrismSaucer();
    case 'solar':
      return buildSolarSaucer();
    case 'phantom':
      return buildPhantomSaucer();
    default:
      return standardSaucer(accent);
  }
}

/** The Fenix in the look asked for. */
function fenixIn(skin: SkinId): Form {
  switch (skin) {
    case 'frostbite':
      return buildFrostbite();
    case 'venom':
      return buildVenom();
    case 'dusk':
      return buildDusk();
    case 'prism':
      return buildPrismFenix();
    case 'solar':
      return buildSolarFenix();
    case 'phantom':
      return buildPhantomFenix();
    default:
      return standardFenix();
  }
}

/**
 * `kind` is 'own' for the player's ship, 'other' for another player's, or a
 * ship the server flies. Only a player's ship wears a look.
 */
export function buildShip(
  kind: 'own' | 'other' | NpcKind,
  looks: Looks = STANDARD_LOOKS,
): ShipModel {
  const group = new Group();
  let base: Form;
  let fenix: Form;
  let usual = 0xffb070;
  if (kind === 'raider') {
    base = { group: buildRaider(), engines: RAIDER_ENGINES };
    fenix = standardFenix();
    usual = 0xff4a2a;
  } else if (kind === 'warlord') {
    const { group: crystalShip, spinner } = buildWarlock();
    base = {
      group: crystalShip,
      engines: WARLOCK_ENGINES,
      animate(seconds) {
        spinner.rotation.z = seconds * 0.8;
      },
    };
    fenix = standardFenix();
    usual = 0xb060ff;
  } else {
    base = saucerIn(looks.saucer, kind === 'own' ? OWN_ACCENT : OTHER_ACCENT);
    fenix = fenixIn(looks.fenix);
    if (kind === 'own') usual = 0x66ccff;
  }
  fenix.group.visible = false;
  group.add(base.group, fenix.group);
  const engineColor = new Color(base.engineColor ?? usual);
  const fenixEngineColor = new Color(fenix.engineColor ?? usual);
  return {
    group,
    base: base.group,
    fenix: fenix.group,
    engines: base.engines,
    fenixEngines: fenix.engines,
    engineColor,
    fenixEngineColor,
    animate(seconds) {
      base.animate?.(seconds, engineColor);
      fenix.animate?.(seconds, fenixEngineColor);
    },
  };
}

/** Frees what a ship was drawn with, when it is rebuilt in another look. */
export function disposeShip(model: ShipModel): void {
  model.group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    (object.geometry as BufferGeometry).dispose();
    const material = object.material as Material;
    if (SHARED.has(material)) return;
    if (material instanceof MeshStandardMaterial) {
      material.map?.dispose();
      // A crystal's two pictures are one; freeing it twice is harmless.
      material.emissiveMap?.dispose();
    }
    material.dispose();
  });
}

export function showAs(model: ShipModel, fenix: boolean): void {
  model.base.visible = !fenix;
  model.fenix.visible = fenix;
}
