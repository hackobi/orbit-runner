// Glowing specks and soft lights: the exhaust trail, the bursts where
// something broke up or was picked up, and the glow around engines, shots
// and orbs. Each is a small square turned to face the camera and shaded as
// a round light that fades to nothing at its edge: two triangles apiece,
// all drawn in one call. Nothing here is part of the game; it may use
// Math.random.

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';

/** A set of round lights, each with a place, a size, a colour and a strength. */
export class SpriteBatch {
  readonly mesh: Mesh;
  count = 0;

  private readonly capacity: number;
  private readonly places: Float32Array;
  private readonly tints: Float32Array;
  private readonly placeAttribute: InstancedBufferAttribute;
  private readonly tintAttribute: InstancedBufferAttribute;
  private readonly geometry = new InstancedBufferGeometry();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.places = new Float32Array(capacity * 4);
    this.tints = new Float32Array(capacity * 4);
    const square = new PlaneGeometry(2, 2);
    this.geometry.index = square.index;
    this.geometry.setAttribute('position', square.getAttribute('position'));
    this.placeAttribute = new InstancedBufferAttribute(this.places, 4);
    this.tintAttribute = new InstancedBufferAttribute(this.tints, 4);
    this.placeAttribute.setUsage(DynamicDrawUsage);
    this.tintAttribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('place', this.placeAttribute);
    this.geometry.setAttribute('tint', this.tintAttribute);
    this.geometry.instanceCount = 0;
    this.mesh = new Mesh(
      this.geometry,
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: /* glsl */ `
          attribute vec4 place;
          attribute vec4 tint;
          varying vec4 colour;
          varying vec2 across;
          void main() {
            colour = tint;
            across = position.xy;
            vec4 seen = modelViewMatrix * vec4(place.xyz, 1.0);
            seen.xy += position.xy * place.w;
            gl_Position = projectionMatrix * seen;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec4 colour;
          varying vec2 across;
          void main() {
            float d = length(across);
            float glow = max(0.0, 1.0 - d);
            glow *= glow;
            // The middle of a bright light burns towards white; a dim one, such as smoke, stays dim.
            float bright = max(colour.r, max(colour.g, colour.b));
            vec3 lit = mix(colour.rgb, vec3(1.0), glow * glow * 0.35 * bright);
            gl_FragColor = vec4(lit, glow * colour.a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  /** Sets light `i`. Colours are linear, as `Color` holds them. */
  set(
    i: number,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    const at = i * 4;
    this.places[at] = x;
    this.places[at + 1] = y;
    this.places[at + 2] = z;
    this.places[at + 3] = size;
    this.tints[at] = r;
    this.tints[at + 1] = g;
    this.tints[at + 2] = b;
    this.tints[at + 3] = alpha;
  }

  /** Adds a light after the last. Dropped when the batch is full. */
  add(x: number, y: number, z: number, size: number, color: Color, alpha: number): void {
    if (this.count >= this.capacity) return;
    this.set(this.count, x, y, z, size, color.r, color.g, color.b, alpha);
    this.count += 1;
  }

  /** Moves light `from` into slot `to`. */
  move(from: number, to: number): void {
    this.places.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.tints.copyWithin(to * 4, from * 4, from * 4 + 4);
  }

  /** Hands what was set to the graphics card. */
  commit(): void {
    this.geometry.instanceCount = this.count;
    this.placeAttribute.needsUpdate = true;
    this.tintAttribute.needsUpdate = true;
  }
}

const VALUES = 9; // x, y, z, vx, vy, vz, life left, whole life, size
/** A soft light reads smaller than the hard ball it replaces, so it is drawn this much bigger. */
const SOFT_SCALE = 2.4;
const STRENGTH = 0.5;

export class Particles {
  /** How many may be alive at once. The quality controller lowers it on slow devices. */
  budget: number;

  private readonly batch: SpriteBatch;
  private readonly data: Float32Array;
  /** Each speck's colour, linear. */
  private readonly colors: Float32Array;
  private readonly capacity: number;
  private count = 0;
  private readonly color = new Color();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.budget = capacity;
    this.data = new Float32Array(capacity * VALUES);
    this.colors = new Float32Array(capacity * 3);
    this.batch = new SpriteBatch(capacity);
  }

  get mesh(): Mesh {
    return this.batch.mesh;
  }

  /** One speck. Dropped if the budget is spent. */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    color: number,
  ): void {
    if (this.count >= Math.min(this.budget, this.capacity)) return;
    const at = this.count * VALUES;
    const d = this.data;
    d[at] = x;
    d[at + 1] = y;
    d[at + 2] = z;
    d[at + 3] = vx;
    d[at + 4] = vy;
    d[at + 5] = vz;
    d[at + 6] = life;
    d[at + 7] = life;
    d[at + 8] = size;
    this.color.setHex(color);
    this.colors[this.count * 3] = this.color.r;
    this.colors[this.count * 3 + 1] = this.color.g;
    this.colors[this.count * 3 + 2] = this.color.b;
    this.count += 1;
  }

  /** v1's burst (main.js:5979): specks flying out in every direction at up to `speed`. */
  burst(x: number, y: number, z: number, color: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      this.emit(
        x,
        y,
        z,
        (Math.random() * 2 - 1) * speed,
        (Math.random() * 2 - 1) * speed,
        (Math.random() * 2 - 1) * speed,
        0.6 + Math.random() * 0.2,
        0.15 * (0.7 + Math.random() * 0.9),
        color,
      );
    }
  }

  update(elapsedSeconds: number): void {
    const d = this.data;
    const c = this.colors;
    let i = 0;
    while (i < this.count) {
      const at = i * VALUES;
      const life = (d[at + 6] ?? 0) - elapsedSeconds;
      if (life <= 0) {
        // Fill the gap with the last one.
        const last = this.count - 1;
        if (i !== last) {
          d.copyWithin(at, last * VALUES, last * VALUES + VALUES);
          c.copyWithin(i * 3, last * 3, last * 3 + 3);
        }
        this.count = last;
        continue;
      }
      d[at + 6] = life;
      const x = (d[at] ?? 0) + (d[at + 3] ?? 0) * elapsedSeconds;
      const y = (d[at + 1] ?? 0) + (d[at + 4] ?? 0) * elapsedSeconds;
      const z = (d[at + 2] ?? 0) + (d[at + 5] ?? 0) * elapsedSeconds;
      d[at] = x;
      d[at + 1] = y;
      d[at + 2] = z;
      // It shrinks and dims away over the second half of its life.
      const left = Math.min(1, (life / (d[at + 7] ?? 1)) * 2);
      this.batch.set(
        i,
        x,
        y,
        z,
        (d[at + 8] ?? 0) * SOFT_SCALE * (0.5 + 0.5 * left),
        c[i * 3] ?? 0,
        c[i * 3 + 1] ?? 0,
        c[i * 3 + 2] ?? 0,
        STRENGTH * left,
      );
      i += 1;
    }
    this.batch.count = this.count;
    this.batch.commit();
  }
}
