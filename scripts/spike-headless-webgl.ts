// Phase 1 task 1: does headless Playwright give us WebGL2 and a usable
// requestAnimationFrame rate with four contexts open at once?
//
// Run: npm run spike:webgl
// The result decides whether the end-to-end suite renders or runs with
// render=off. Numbers are recorded in docs/PLAN.md.

import { chromium, webkit, devices } from '@playwright/test';
import type { BrowserContextOptions, BrowserType, LaunchOptions } from '@playwright/test';

const MEASURE_MS = 10_000;

interface FrameReport {
  webgl2: boolean;
  renderer: string;
  frames: number;
  meanFps: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  visibility: string;
}

const PAGE_HTML = `<!doctype html>
<html><body style="margin:0"><canvas id="c" width="800" height="450"></canvas></body></html>`;

// Runs inside the page. Draws 2,000 instanced triangles per frame and records
// the interval between requestAnimationFrame callbacks.
function measureInPage(measureMs: number): Promise<FrameReport> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    return Promise.resolve({
      webgl2: false,
      renderer: 'none',
      frames: 0,
      meanFps: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      visibility: document.visibilityState,
    });
  }
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );

  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(String(gl.getShaderInfoLog(shader)));
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(
    program,
    compile(
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 p; uniform float t; out vec3 col;
      void main() {
        float i = float(gl_InstanceID);
        float a = t + i * 0.37;
        vec2 o = vec2(cos(i * 1.7 + t * 0.3), sin(i * 2.3 + t * 0.2)) * 0.9;
        mat2 r = mat2(cos(a), -sin(a), sin(a), cos(a));
        gl_Position = vec4(o + r * p * 0.03, 0.0, 1.0);
        col = vec3(fract(i * 0.13), fract(i * 0.29), 1.0);
      }`,
    ),
  );
  gl.attachShader(
    program,
    compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float; in vec3 col; out vec4 o;
      void main() { o = vec4(col, 1.0); }`,
    ),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(String(gl.getProgramInfoLog(program)));
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, -1, -1, 1, -1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tLoc = gl.getUniformLocation(program, 't');

  return new Promise((resolve) => {
    const intervals: number[] = [];
    const start = performance.now();
    let last = start;
    const frame = (now: number): void => {
      intervals.push(now - last);
      last = now;
      gl.uniform1f(tLoc, (now - start) / 1000);
      gl.clearColor(0.01, 0.04, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2000);
      if (now - start < measureMs) {
        requestAnimationFrame(frame);
        return;
      }
      // Drop the first interval: it measures time to the first frame.
      const sorted = intervals.slice(1).sort((a, b) => a - b);
      const at = (q: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const total = sorted.reduce((sum, v) => sum + v, 0);
      resolve({
        webgl2: true,
        renderer,
        frames: sorted.length,
        meanFps: total > 0 ? (sorted.length * 1000) / total : 0,
        p50Ms: at(0.5),
        p99Ms: at(0.99),
        maxMs: sorted[sorted.length - 1] ?? 0,
        visibility: document.visibilityState,
      });
    };
    requestAnimationFrame(frame);
  });
}

async function run(
  name: string,
  type: BrowserType,
  profiles: [string, BrowserContextOptions][],
  launch: LaunchOptions = {},
): Promise<boolean> {
  const browser = await type.launch({ headless: true, ...launch });
  try {
    const pages = await Promise.all(
      profiles.map(async ([, options]) => {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        await page.setContent(PAGE_HTML);
        return page;
      }),
    );
    // All four measure at the same time, as they will in the suite.
    const reports = await Promise.all(
      pages.map((page) => page.evaluate(measureInPage, MEASURE_MS)),
    );
    console.log(`\n${name} ${browser.version()}`);
    console.table(
      reports.map((r, i) => ({
        profile: profiles[i]?.[0],
        webgl2: r.webgl2,
        frames: r.frames,
        meanFps: Number(r.meanFps.toFixed(1)),
        p50Ms: Number(r.p50Ms.toFixed(1)),
        p99Ms: Number(r.p99Ms.toFixed(1)),
        maxMs: Number(r.maxMs.toFixed(1)),
        visibility: r.visibility,
        renderer: r.renderer.slice(0, 60),
      })),
    );
    return reports.every((r) => r.webgl2);
  } finally {
    await browser.close();
  }
}

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 720 } };

const chromiumProfiles: [string, BrowserContextOptions][] = [
  ['desktop 1', desktop],
  ['desktop 2', desktop],
  ['Pixel 7', devices['Pixel 7']],
  ['Pixel 7 landscape', devices['Pixel 7 landscape']],
];
// Playwright's default headless Chromium is the headless shell, which renders
// WebGL in software (SwiftShader). The variants ask for the Metal backend.
const chromiumVariants: [string, LaunchOptions][] = [
  ['Chromium headless shell, default', {}],
  ['Chromium headless shell, --use-angle=metal', { args: ['--use-angle=metal'] }],
  ['Chromium new headless, default', { channel: 'chromium' }],
  [
    'Chromium new headless, --use-angle=metal',
    { channel: 'chromium', args: ['--use-angle=metal'] },
  ],
];
let chromiumOk = true;
for (const [name, launch] of chromiumVariants) {
  chromiumOk = (await run(name, chromium, chromiumProfiles, launch)) && chromiumOk;
}
const webkitOk = await run('WebKit', webkit, [
  ['desktop 1', desktop],
  ['desktop 2', desktop],
  ['iPhone 15', devices['iPhone 15']],
  ['iPhone 15 landscape', devices['iPhone 15 landscape']],
]);

if (!chromiumOk || !webkitOk) {
  console.error('\nFAIL: at least one context did not get a WebGL2 context.');
  process.exit(1);
}
