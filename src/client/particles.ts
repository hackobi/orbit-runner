// Glowing specks: the exhaust trail and the bursts where something broke up
// or was picked up. All of them are instances of one small sphere, moved in
// straight lines and shrunk away over their short lives. Nothing here is
// part of the game; it may use Math.random.

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  SphereGeometry,
} from 'three';

const VALUES = 8; // x, y, z, vx, vy, vz, life left, whole life

export class Particles {
  readonly mesh: InstancedMesh;
  /** How many may be alive at once. The quality controller lowers it on slow devices. */
  budget: number;

  private readonly data: Float32Array;
  private readonly sizes: Float32Array;
  private readonly capacity: number;
  private count = 0;
  private readonly matrix = new Matrix4();
  private readonly color = new Color();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.budget = capacity;
    this.data = new Float32Array(capacity * VALUES);
    this.sizes = new Float32Array(capacity);
    this.mesh = new InstancedMesh(
      new SphereGeometry(1, 6, 6),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.7,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
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
    this.sizes[this.count] = size;
    this.mesh.setColorAt(this.count, this.color.setHex(color));
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
        0.22 * (0.7 + Math.random() * 0.9),
        color,
      );
    }
  }

  update(elapsedSeconds: number): void {
    const d = this.data;
    const mesh = this.mesh;
    let i = 0;
    while (i < this.count) {
      const at = i * VALUES;
      const life = (d[at + 6] ?? 0) - elapsedSeconds;
      if (life <= 0) {
        // Fill the gap with the last one.
        const last = this.count - 1;
        if (i !== last) {
          d.copyWithin(at, last * VALUES, last * VALUES + VALUES);
          this.sizes[i] = this.sizes[last] ?? 0;
          mesh.getColorAt(last, this.color);
          mesh.setColorAt(i, this.color);
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
      const size = (this.sizes[i] ?? 0) * Math.min(1, (life / (d[at + 7] ?? 1)) * 2);
      this.matrix.makeScale(size, size, size).setPosition(x, y, z);
      mesh.setMatrixAt(i, this.matrix);
      i += 1;
    }
    mesh.count = this.count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
