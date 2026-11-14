// The service worker: registered once, and told to switch to a new version
// only when the client says the moment is right (updatePolicy.ts).

import { registerSW } from 'virtual:pwa-register';

export interface Updates {
  /** True once a new version has been downloaded and is waiting. */
  readonly ready: boolean;
  /** Switches to the waiting version, which reloads the page. */
  apply(): void;
}

export function watchForUpdates(): Updates {
  let ready = false;
  let applied = false;
  const update = registerSW({
    onNeedRefresh() {
      ready = true;
    },
  });
  return {
    get ready() {
      return ready;
    },
    apply() {
      if (applied) return;
      applied = true;
      void update(true);
    },
  };
}
