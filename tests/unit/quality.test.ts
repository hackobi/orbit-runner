import { describe, expect, it } from 'vitest';
import { QualityController, TIERS } from '../../src/client/quality.ts';

/** Feeds `seconds` of frames of one length. Returns the tier after each change. */
function run(controller: QualityController, frameMs: number, seconds: number): number[] {
  const changes: number[] = [];
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += frameMs) {
    if (controller.frame(frameMs)) changes.push(controller.tier);
  }
  return changes;
}

describe('the quality controller', () => {
  it('each tier draws less than the one above', () => {
    expect(TIERS.map((t) => t.name)).toEqual(['high', 'medium', 'low']);
    for (let i = 1; i < TIERS.length; i++) {
      const above = TIERS[i - 1];
      const tier = TIERS[i];
      if (!above || !tier) throw new Error('missing tier');
      expect(tier.pixelRatio).toBeLessThan(above.pixelRatio);
      expect(tier.maxPixels).toBeLessThan(above.maxPixels);
      expect(tier.particles).toBeLessThan(above.particles);
      expect(tier.rockDistance).toBeLessThan(above.rockDistance);
    }
  });

  it('leaves a smooth picture alone, at 60 and at 120 frames a second', () => {
    expect(run(new QualityController(0), 1000 / 60, 120)).toEqual([]);
    expect(run(new QualityController(0), 1000 / 120, 120)).toEqual([]);
  });

  it('drops a tier after two slow seconds, and another if that was not enough', () => {
    const controller = new QualityController(0);
    expect(run(controller, 30, 2.2)).toEqual([1]);
    expect(run(controller, 30, 2.2)).toEqual([2]);
    // There is nothing below the lowest tier.
    expect(run(controller, 30, 20)).toEqual([]);
  });

  it('one slow second is not enough', () => {
    const controller = new QualityController(0);
    run(controller, 30, 1.1);
    expect(run(controller, 1000 / 60, 30)).toEqual([]);
    expect(controller.tier).toBe(0);
  });

  it('tries the tier above after ten smooth seconds', () => {
    const controller = new QualityController(2);
    expect(run(controller, 1000 / 60, 9)).toEqual([]);
    expect(run(controller, 1000 / 60, 2)).toEqual([1]);
  });

  it('waits twice as long each time a rise has to be undone, so it does not flicker', () => {
    const controller = new QualityController(1);
    // A device that manages the medium tier and not the high one.
    const secondsToRise: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      let seconds = 0;
      while (controller.tier === 1) {
        run(controller, 1000 / 60, 1);
        seconds += 1;
        if (seconds > 400) throw new Error('never rose');
      }
      secondsToRise.push(seconds);
      // On the high tier it is slow again.
      while (controller.tier === 0) run(controller, 30, 1);
    }
    expect(secondsToRise[0]).toBeLessThanOrEqual(11);
    expect(secondsToRise[1]).toBeGreaterThanOrEqual(19);
    expect(secondsToRise[2]).toBeGreaterThanOrEqual(39);
    expect(secondsToRise[3]).toBeGreaterThanOrEqual(79);
  });

  it('does not take a hidden tab for a slow device', () => {
    const controller = new QualityController(0);
    for (let i = 0; i < 20; i++) {
      run(controller, 1000 / 60, 0.5);
      expect(controller.frame(5000)).toBe(false);
    }
    expect(controller.tier).toBe(0);
  });

  it('settles a phone that draws at 30 frames a second on the lowest tier and stays there', () => {
    // Low Power Mode on iOS halves the frame rate whatever is drawn.
    const controller = new QualityController(1);
    run(controller, 1000 / 30, 60);
    expect(controller.tier).toBe(2);
    expect(run(controller, 1000 / 30, 300)).toEqual([]);
  });
});
