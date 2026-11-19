// The ships. Each is built once from simple shapes, joined into one piece
// per material, so a ship costs four or five draws however detailed it is.
// Every model has its nose along +Z and fits inside the hull's radius, so
// what is drawn is what can be hit. (The Fenix is the exception, as it was
// in v1: its wings reach past the hull. Other players' ships are drawn half
// as big again, also as in v1.)

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { NpcKind } from '../shared/progress.ts';

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
const GLASS = new MeshStandardMaterial({
  color: 0x0c2c40,
  emissive: 0x0b5a78,
  emissiveIntensity: 0.55,
  metalness: 0.9,
  roughness: 0.08,
});

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
  /** The colour of its engines and trail. */
  readonly engineColor: Color;
  /** A part that turns by itself, if the ship has one. */
  readonly spinner: Object3D | null;
}

/**
 * A player's ship: v1's saucer (main.js:4207-4275) grown up. Still a disc
 * with a dome, but with twin engines behind and a prow in front, so its
 * heading can be read from any side.
 */
function buildSaucer(accent: number): Group {
  const group = new Group();
  const profile: [number, number][] = [
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
  const hull = [
    new LatheGeometry(
      profile.map(([r, y]) => new Vector2(r, y)),
      48,
    ),
    part(new ConeGeometry(0.3, 0.95, 4), {
      turn: [HALF, 0, 0],
      size: [1, 0.45, 1],
      at: [0, 0.1, 1.5],
    }),
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
      part(new CylinderGeometry(0.2, 0.27, 1.25, 14), {
        turn: [HALF, 0, 0],
        at: [side * 0.72, 0.16, -1.2],
      }),
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
    joined(hull, metal(0xaeb8c8, 0.34)),
    joined(trim, DARK_TRIM),
    joined(glow, light(accent)),
    joined([canopy], GLASS),
  );
  return group;
}
const SAUCER_ENGINES = [new Vector3(0.72, 0.16, -1.9), new Vector3(-0.72, 0.16, -1.9)];

/**
 * The Fenix: a swept-wing raptor in deep red, edged in glowing gold.
 * v1's was a plain black dart (main.js:5038-5094), which vanished against space.
 */
function buildFenix(): Group {
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
  const red = new MeshStandardMaterial({
    color: 0xb81d14,
    emissive: 0x2a0502,
    metalness: 0.3,
    roughness: 0.35,
    flatShading: true,
  });
  group.add(
    joined(hull, red),
    joined([body], metal(0x4a505e, 0.4, true)),
    joined([canopy], GLASS),
    joined(edges, light(0xffa01e)),
    joined(engines, light(0xff5a1e)),
  );
  return group;
}
const FENIX_ENGINES = [new Vector3(0.5, 0, -2.3), new Vector3(-0.5, 0, -2.3)];

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

/** A player's lights are cyan on their own screen and amber on everyone else's. */
const OWN_ACCENT = 0x1ec8ff;
const OTHER_ACCENT = 0xff9a2e;

/** `kind` is 'own' for the player's ship, 'other' for another player's, or a ship the server flies. */
export function buildShip(kind: 'own' | 'other' | NpcKind): ShipModel {
  const group = new Group();
  const fenix = buildFenix();
  fenix.visible = false;
  let base: Group;
  let engines = SAUCER_ENGINES;
  let engineColor = 0xffb070;
  let spinner: Object3D | null = null;
  if (kind === 'raider') {
    base = buildRaider();
    engines = RAIDER_ENGINES;
    engineColor = 0xff4a2a;
  } else if (kind === 'warlord') {
    ({ group: base, spinner } = buildWarlock());
    engines = WARLOCK_ENGINES;
    engineColor = 0xb060ff;
  } else {
    base = buildSaucer(kind === 'own' ? OWN_ACCENT : OTHER_ACCENT);
    if (kind === 'own') engineColor = 0x66ccff;
  }
  group.add(base, fenix);
  return {
    group,
    base,
    fenix,
    engines,
    fenixEngines: FENIX_ENGINES,
    engineColor: new Color(engineColor),
    spinner,
  };
}

export function showAs(model: ShipModel, fenix: boolean): void {
  model.base.visible = !fenix;
  model.fenix.visible = fenix;
}
