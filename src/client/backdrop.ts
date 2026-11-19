// Everything that is scenery: the sky with its nebula and sun, the planet
// and its air, the haze of the belt, the stars, and the motes of dust that
// show how fast the ship is going.
//
// The sky and the planet's surface are painted once, when the game starts,
// into pictures the graphics card then only has to look up. Painting them
// every frame would cost a slow phone its frame rate.

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CubeCamera,
  DoubleSide,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  PMREMGenerator,
  RepeatWrapping,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { SIM } from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';

/** Where the sun is: the direction v1's light came from (main.js:347). */
export const SUN_DIRECTION = new Vector3(1000, 1500, 800).normalize();

/** Smooth random patterns, shared by the sky and the planet. */
const NOISE = /* glsl */ `
  float hash(vec3 p) {
    vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
          mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
          mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float sum = 0.0;
    float weight = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += weight * noise(p);
      // Turned between layers, so the grid the pattern is built on never lines up with itself.
      p = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64) * p * 2.03 + vec3(1.7, 9.2, 3.1);
      weight *= 0.5;
    }
    return sum;
  }
`;

/**
 * The sky in one direction. `soft` is 0 for the sky that is looked at and 1
 * for the copy that only lights the ships: brighter, with a wide sun.
 */
const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 sun;
  uniform float soft;
  varying vec3 direction;
  ${NOISE}
  void main() {
    vec3 d = normalize(direction);
    // A band of gas round the sky, tilted against the belt.
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.86, -0.4))) * 2.6, 2.0));
    float cloud = fbm(d * 2.4 + vec3(fbm(d * 1.3 + 4.0) * 1.6));
    float lanes = smoothstep(0.28, 0.62, fbm(d * 5.5 + 5.0));
    vec3 colour = vec3(0.004, 0.008, 0.022);
    colour += vec3(0.014, 0.034, 0.095) * smoothstep(0.38, 0.8, cloud) * (0.2 + 0.8 * band);
    colour += vec3(0.055, 0.015, 0.075) * smoothstep(0.48, 0.85, fbm(d * 3.1 + 11.0)) * (0.25 + 0.75 * band);
    colour += vec3(0.006, 0.045, 0.05) * smoothstep(0.52, 0.9, fbm(d * 2.6 + 27.0));
    colour *= 0.45 + 0.55 * lanes;

    float towards = max(dot(d, sun), 0.0);
    vec3 sunlight = vec3(1.0, 0.86, 0.68);
    colour += sunlight * (pow(towards, 3000.0) * 9.0 + pow(towards, 220.0) * 0.5 + pow(towards, 14.0) * 0.07);

    if (soft > 0.5) {
      // For lighting: lift everything and spread the sun, with cool light from the far side.
      colour = colour * 10.0 + vec3(0.05, 0.065, 0.1);
      colour += sunlight * pow(towards, 6.0) * 2.2;
      colour += vec3(0.1, 0.22, 0.5) * pow(max(dot(d, -sun), 0.0), 3.0) * 0.6;
    }
    gl_FragColor = vec4(colour, 1.0);
  }
`;

function paintSky(renderer: WebGLRenderer, size: number, soft: boolean): WebGLCubeRenderTarget {
  const target = new WebGLCubeRenderTarget(size, { type: HalfFloatType });
  const material = new ShaderMaterial({
    uniforms: { sun: { value: SUN_DIRECTION }, soft: { value: soft ? 1 : 0 } },
    side: BackSide,
    vertexShader: /* glsl */ `
      varying vec3 direction;
      void main() {
        direction = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: SKY_FRAGMENT,
  });
  const dome = new Mesh(new SphereGeometry(10, 32, 16), material);
  const scene = new Scene();
  scene.add(dome);
  new CubeCamera(0.1, 100, target).update(renderer, scene);
  dome.geometry.dispose();
  material.dispose();
  return target;
}

/** The planet's surface, laid flat: bands of cloud over deep blue, with paler storms. */
function paintPlanet(renderer: WebGLRenderer, width: number): Texture {
  const target = new WebGLRenderTarget(width, width / 2, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });
  target.texture.wrapS = RepeatWrapping;
  const material = new ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 at;
      void main() {
        at = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 at;
      ${NOISE}
      void main() {
        float longitude = at.x * 6.2831853;
        float latitude = (at.y - 0.5) * 3.1415927;
        vec3 d = vec3(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
        float warp = fbm(d * 2.6 + 2.0);
        float bands = fbm(vec3(d.x * 1.1, (d.y + warp * 0.35) * 6.5, d.z * 1.1) + 7.0);
        float fine = fbm(d * 13.0 + bands * 3.0);
        vec3 colour = mix(vec3(0.02, 0.07, 0.3), vec3(0.07, 0.3, 0.72), smoothstep(0.28, 0.68, bands));
        colour = mix(colour, vec3(0.2, 0.12, 0.5), smoothstep(0.5, 0.85, fbm(d * 1.9 + 40.0)) * 0.45);
        colour = mix(colour, vec3(0.55, 0.8, 0.95), smoothstep(0.56, 0.82, bands * 0.55 + fine * 0.55) * 0.6);
        // One great storm.
        float storm = 1.0 - smoothstep(0.0, 0.2, distance(d, normalize(vec3(0.5, -0.32, 0.8))) * (0.8 + 0.4 * fine));
        colour = mix(colour, vec3(0.9, 0.95, 1.0), storm * 0.7);
        // Stored the way pictures are, so the dark blues keep their detail.
        gl_FragColor = vec4(pow(colour, vec3(1.0 / 2.2)), 1.0);
      }
    `,
  });
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(before);
  quad.geometry.dispose();
  material.dispose();
  return target.texture;
}

function buildPlanet(surface: Texture): Group {
  const group = new Group();
  const planet = new Mesh(
    new SphereGeometry(SIM.planetRadius, 96, 64),
    new ShaderMaterial({
      uniforms: { surface: { value: surface }, sun: { value: SUN_DIRECTION } },
      vertexShader: /* glsl */ `
        varying vec2 at;
        varying vec3 outward;
        varying vec3 place;
        void main() {
          at = uv;
          outward = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          place = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D surface;
        uniform vec3 sun;
        varying vec2 at;
        varying vec3 outward;
        varying vec3 place;
        void main() {
          vec3 n = normalize(outward);
          vec3 toEye = normalize(cameraPosition - place);
          vec3 albedo = pow(texture2D(surface, at).rgb, vec3(2.2));
          float lit = dot(n, sun);
          float day = smoothstep(-0.18, 0.55, lit);
          float edge = pow(1.0 - max(dot(n, toEye), 0.0), 2.6);
          vec3 colour = albedo * (0.02 + 0.62 * day);
          // The air: a blue edge, and a warm line where day meets night.
          colour += vec3(0.12, 0.34, 0.9) * edge * (0.08 + 0.55 * day);
          colour += vec3(1.0, 0.45, 0.2) * edge * smoothstep(0.35, 0.0, abs(lit)) * 0.25;
          gl_FragColor = vec4(colour, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  // The planet turns slowly under its clouds; `update` moves it.
  planet.name = 'planet';

  const air = new Mesh(
    new SphereGeometry(SIM.planetRadius * 1.09, 64, 48),
    new ShaderMaterial({
      uniforms: { sun: { value: SUN_DIRECTION } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 outward;
        varying vec3 place;
        void main() {
          outward = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          place = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 sun;
        varying vec3 outward;
        varying vec3 place;
        void main() {
          vec3 n = normalize(outward);
          float facing = max(dot(n, normalize(cameraPosition - place)), 0.0);
          // Strongest just outside the planet's edge, gone at the shell's own edge.
          float glow = smoothstep(0.0, 0.42, facing) * pow(1.0 - facing, 2.0) * 1.3;
          float day = smoothstep(-0.35, 0.5, dot(n, sun));
          gl_FragColor = vec4(vec3(0.25, 0.55, 1.0), glow * (0.08 + 0.92 * day));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  group.add(planet, air);
  return group;
}

/** A thin sheet of dust through the belt: seen from above it is the planet's ring. */
function buildBeltHaze(): Mesh {
  const inner = SIM.beltInner - 500;
  const outer = SIM.beltOuter + 500;
  const haze = new Mesh(
    new RingGeometry(inner, outer, 160, 1),
    new ShaderMaterial({
      uniforms: { inner: { value: inner }, outer: { value: outer } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 place;
        void main() {
          place = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float inner;
        uniform float outer;
        varying vec3 place;
        void main() {
          float r = length(place.xy);
          float t = (r - inner) / (outer - inner);
          float edges = smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.75, t);
          float lanes = 0.6 + 0.25 * sin(r * 0.008) + 0.15 * sin(r * 0.019 + 1.3);
          gl_FragColor = vec4(vec3(0.55, 0.62, 0.8), edges * lanes * 0.085);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  haze.rotation.x = -Math.PI / 2;
  return haze;
}

/**
 * v1's starfield (main.js:4583-4603): 4,000 points in a shell 8,000 to 20,000 out.
 * One pixel each and mostly faint: on a phone bigger stars read as bigger
 * than the rocks of the belt. A few are warm or blue.
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
    const warmth = rng.next();
    colors[i * 3] = brightness * (warmth > 0.8 ? 1 : 0.72);
    colors[i * 3 + 1] = brightness * 0.84;
    colors[i * 3 + 2] = brightness * (warmth > 0.8 ? 0.7 : 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return new Points(
    geometry,
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        varying vec3 tint;
        void main() {
          tint = color;
          gl_PointSize = 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 tint;
        void main() {
          gl_FragColor = vec4(tint, 0.9);
          #include <colorspace_fragment>
        }
      `,
    }),
  );
}

const DUST_SPAN = 260;
const DUST_COUNT = 420;

/**
 * Motes of dust around the camera. They stand still, so they slide past as
 * the ship moves: in empty space they are what shows its speed. The same
 * few hundred are reused for ever: one that falls behind comes round in front.
 */
function buildDust(eye: { value: Vector3 }, pixels: { value: number }): Points {
  const rng = new Rng(77);
  const positions = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = rng.next() * DUST_SPAN;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const dust = new Points(
    geometry,
    new ShaderMaterial({
      uniforms: { eye, pixels, span: { value: DUST_SPAN } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform vec3 eye;
        uniform float pixels;
        uniform float span;
        varying float strength;
        void main() {
          vec3 near = mod(position - eye, span) - span * 0.5;
          float away = length(near);
          strength = (1.0 - smoothstep(span * 0.3, span * 0.5, away)) * smoothstep(4.0, 14.0, away);
          vec4 seen = viewMatrix * vec4(near + eye, 1.0);
          gl_PointSize = clamp(pixels * 70.0 / max(1.0, -seen.z), 1.0, 2.5 * pixels);
          gl_Position = projectionMatrix * seen;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float strength;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(vec3(0.6, 0.75, 1.0), strength * 0.5 * max(0.0, 1.0 - d));
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  dust.frustumCulled = false;
  return dust;
}

export interface Backdrop {
  /** Planet, haze, stars and dust: add it to the scene. */
  readonly group: Group;
  /** The sky, for the scene's background. */
  readonly sky: Texture;
  /** A brighter, blurred sky that lights whatever is shiny. */
  readonly light: Texture;
  /** Once a frame: where the camera is, and device pixels per CSS pixel. */
  update(eye: Vector3, pixelRatio: number, seconds: number): void;
}

/** `small` paints the sky at half the size, for phones. */
export function buildBackdrop(renderer: WebGLRenderer, small: boolean): Backdrop {
  const sky = paintSky(renderer, small ? 512 : 1024, false).texture;
  const lightSource = paintSky(renderer, 128, true);
  const blur = new PMREMGenerator(renderer);
  const light = blur.fromCubemap(lightSource.texture).texture;
  blur.dispose();
  lightSource.dispose();

  const eye = { value: new Vector3() };
  const pixels = { value: 1 };
  const planet = buildPlanet(paintPlanet(renderer, small ? 1024 : 2048));
  const group = new Group();
  group.add(planet, buildBeltHaze(), buildStars(), buildDust(eye, pixels));
  const globe = planet.getObjectByName('planet');
  return {
    group,
    sky,
    light,
    update(at, pixelRatio, seconds) {
      eye.value.copy(at);
      pixels.value = pixelRatio;
      // One turn in about 17 minutes.
      if (globe) globe.rotation.y = seconds * 0.006;
    },
  };
}
