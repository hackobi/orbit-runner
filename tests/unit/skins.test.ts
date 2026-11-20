// The looks a ship can wear. A look must change the picture and nothing else:
// it may not be drawn further out than the standard ship (what is drawn is
// what can be hit), and it may not cost more draws.

import { Mesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { buildShip } from '../../src/client/models.ts';
import { SKINS, skinOr, skinsFor } from '../../src/client/skins.ts';
import type { ShipForm, SkinId } from '../../src/client/skins.ts';

/** How far a shape reaches each way, in the ship's own frame, with its moving parts where they are. */
function reach(shape: Object3D): { out: number; span: number; nose: number; tail: number } {
  shape.updateMatrixWorld(true);
  const point = new Vector3();
  const size = { out: 0, span: 0, nose: 0, tail: 0 };
  shape.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const position = (object.geometry as BufferGeometry).getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      size.out = Math.max(size.out, point.length());
      size.span = Math.max(size.span, Math.abs(point.x));
      size.nose = Math.max(size.nose, point.z);
      size.tail = Math.max(size.tail, -point.z);
    }
  });
  return size;
}

function draws(shape: Object3D): number {
  let count = 0;
  shape.traverse((object) => {
    if (object instanceof Mesh) count += 1;
  });
  return count;
}

function shapeOf(skin: SkinId, form: ShipForm): { shape: Object3D; animate: (s: number) => void } {
  const model = buildShip('own', {
    saucer: form === 'saucer' ? skin : 'standard',
    fenix: form === 'fenix' ? skin : 'standard',
  });
  return {
    shape: form === 'saucer' ? model.base : model.fenix,
    animate: (seconds) => {
      model.animate(seconds);
    },
  };
}

/** Moments in the scene's clock at which the moving parts are somewhere different. */
const MOMENTS = [0, 0.37, 1.9, 4.2, 11.3];
const SLACK = 1e-6;

describe('ship looks', () => {
  it('offers three looks for each shape and three special ones for both', () => {
    const only = (form: ShipForm): number =>
      SKINS.filter((skin) => skin.forms.length === 1 && skin.forms[0] === form).length;
    expect(only('saucer')).toBe(3);
    expect(only('fenix')).toBe(3);
    const both = SKINS.filter((skin) => skin.id !== 'standard' && skin.forms.length === 2);
    expect(both.map((skin) => skin.tier)).toEqual(['Epic', 'Legendary', 'Mythic']);
  });

  it('a stored look that this shape cannot wear, or that does not exist, is the standard one', () => {
    expect(skinOr('comet', 'saucer')).toBe('comet');
    expect(skinOr('comet', 'fenix')).toBe('standard');
    expect(skinOr('frostbite', 'saucer')).toBe('standard');
    expect(skinOr('solar', 'fenix')).toBe('solar');
    expect(skinOr('gone-in-a-later-build', 'saucer')).toBe('standard');
    expect(skinOr(undefined, 'fenix')).toBe('standard');
  });

  for (const form of ['saucer', 'fenix'] as const) {
    const standard = reach(shapeOf('standard', form).shape);
    for (const skin of skinsFor(form)) {
      if (skin.id === 'standard') continue;
      it(`${skin.name} as a ${form} is drawn no further out than the standard ship, at any moment`, () => {
        const { shape, animate } = shapeOf(skin.id, form);
        for (const seconds of MOMENTS) {
          animate(seconds);
          const size = reach(shape);
          expect(size.out).toBeLessThanOrEqual(standard.out + SLACK);
          expect(size.span).toBeLessThanOrEqual(standard.span + SLACK);
          expect(size.nose).toBeLessThanOrEqual(standard.nose + SLACK);
          expect(size.tail).toBeLessThanOrEqual(standard.tail + SLACK);
        }
      });

      it(`${skin.name} as a ${form} costs no more than five draws`, () => {
        expect(draws(shapeOf(skin.id, form).shape)).toBeLessThanOrEqual(5);
      });
    }
  }

  it('a ship the server flies wears nothing, whatever it is handed', () => {
    const plain = buildShip('raider');
    const dressed = buildShip('raider', { saucer: 'solar', fenix: 'phantom' });
    expect(reach(dressed.group)).toEqual(reach(plain.group));
    expect(draws(dressed.group)).toBe(draws(plain.group));
  });
});
