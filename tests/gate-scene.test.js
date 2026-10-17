'use strict';
// v3.81: the sign-in gate's whale drift (features.js, kjrGateScene*). The scene is decoration over a static whale, so these tests pin
// what must never go wrong: it starts only for a loading state that is still showing 250ms on, with motion allowed and WebGL present,
// it falls back to the static whale on every failure without throwing, it disposes everything on both hooks, it never leaves a
// listener behind and it never touches the window pointer or key listeners. The harness has no WebGL and no import(), so the library is
// a fake with dispose spies (and, for the maths and the real constructors, the vendored three.js with only the renderer faked).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT, plain } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const appSrc = fs.readFileSync(ROOT + '/app.js', 'utf8');
const featSrc = fs.readFileSync(ROOT + '/features.js', 'utf8');

const LOADING = 'kjr-auth-loading';
const FORM = 'kjr-auth-form';

// ── a DOM small enough to read: parent tracking, a class set, a size ──
function makeEl(tag, props) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null, _classes: new Set(),
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
  };
  return Object.assign(el, props || {});
}

// ── a fake three.js: only what the scene calls, with a dispose spy on everything that owns GPU memory ──
function makeFakeThree(opts) {
  opts = opts || {};
  const made = { renderers: [], geometries: [], materials: [], textures: [], objects: [] };
  const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const maybeThrow = (name) => { if (opts.throwIn === name) throw new Error('fake ' + name + ' failed'); };
  class Obj {
    constructor(geometry, material) {
      this.position = vec(); this.rotation = vec(); this.scale = vec();
      this.scale.x = 1; this.scale.y = 1; this.scale.z = 1;
      this.renderOrder = 0; this.geometry = geometry; this.material = material;
      made.objects.push(this);
    }
  }
  // A constructor that throws hands nothing back, so whatever it was building is never in `made` and the scene has nothing to free.
  // The check therefore comes first, before the object is recorded. new.target is the class being built, so opts.throwIn can name any
  // one of the disposable classes below (a CanvasTexture or a PlaneGeometry throws only when built as itself, not as a base class).
  class Disposable {
    constructor(bucket) { maybeThrow(new.target.name); this.disposeCalls = 0; bucket.push(this); }
    dispose() { this.disposeCalls++; }
  }
  class Scene extends Obj { constructor() { super(); this.children = []; } add(o) { this.children.push(o); } }
  class OrthographicCamera {
    constructor(l, r, t, b, n, f) { Object.assign(this, { left: l, right: r, top: t, bottom: b, near: n, far: f }); this.position = vec(); this.projectionUpdates = 0; }
    updateProjectionMatrix() { this.projectionUpdates++; }
  }
  class WebGLRenderer extends Disposable {
    constructor(params) {
      super(made.renderers);
      this.params = params; this.domElement = opts.makeCanvas(); this.pixelRatio = 1; this.sizes = []; this.renders = 0; this.contextLosses = 0;
    }
    setPixelRatio(v) { this.pixelRatio = v; }
    setSize(w, h, style) { this.sizes.push([w, h, style]); }
    render(scene, camera) {
      this.renders++;
      if (opts.renderThrowsOn && this.renders >= opts.renderThrowsOn) throw new Error('fake render failed');
      this.lastScene = scene; this.lastCamera = camera;
    }
    forceContextLoss() { this.contextLosses++; }
  }
  class Texture extends Disposable { constructor(image) { super(made.textures); this.image = image; this.needsUpdate = false; } }
  class CanvasTexture extends Texture { constructor(canvas) { super(canvas); } }
  class Material extends Disposable { constructor(o) { super(made.materials); this.opts = o || {}; this.opacity = this.opts.opacity === undefined ? 1 : this.opts.opacity; } }
  class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; } }
  class BufferGeometry extends Disposable { constructor() { super(made.geometries); this.attributes = {}; } setAttribute(n, a) { this.attributes[n] = a; } }
  class PlaneGeometry extends BufferGeometry { constructor(w, h) { super(); this.w = w; this.h = h; } }
  class Color { constructor(hex) { this.hex = hex; this.r = ((hex >> 16) & 255) / 255; this.g = ((hex >> 8) & 255) / 255; this.b = (hex & 255) / 255; } }
  return {
    made,
    THREE: {
      Scene, OrthographicCamera, WebGLRenderer, Texture, CanvasTexture, BufferAttribute, BufferGeometry, PlaneGeometry, Color,
      SpriteMaterial: class extends Material {}, PointsMaterial: class extends Material {}, MeshBasicMaterial: class extends Material {},
      Sprite: class extends Obj { constructor(m) { super(undefined, m); } },
      Points: class extends Obj {}, Mesh: class extends Obj {},
      AdditiveBlending: 2, NormalBlending: 1, SRGBColorSpace: 'srgb',
    },
  };
}

// ── one app, with the gate, a measured box, a canvas factory, an Image, listener recording and a library seam ──
async function sceneApp(o) {
  o = o || {};
  const app = await loadApp({ seed: null, authenticated: false, authGate: true });
  // 0 is a real size (a box that is not laid out), so only an absent one takes the default
  const box = makeEl('div', { clientWidth: o.width === undefined ? 356 : o.width, clientHeight: o.height === undefined ? 198 : o.height });
  app.document._byId.set('kjr-auth-scene', box);
  app.box = box;
  app.canvases = [];
  const makeCanvas = () => makeEl('canvas');
  app.document.createElement = (tag) => {
    const c = makeEl(tag);
    if (tag === 'canvas') {
      c.contexts = [];
      c.getContext = (type) => {
        c.contexts.push(type);
        if (type === '2d') return { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} };
        return o.webgl === false ? null : {};
      };
      app.canvases.push(c);
    }
    return c;
  };
  // an Image that loads (or fails) a microtask after its src is set, or never when o.image is 'hang'
  app.sandbox.Image = class {
    constructor() { this.naturalWidth = 512; this.naturalHeight = 512; this.width = 512; this.height = 512; }
    set src(v) {
      this._src = v;
      app.imageSrcs.push(v);
      if (o.image === 'hang') { app.hungImage = this; return; }
      queueMicrotask(() => { if (o.image === 'fail') { if (this.onerror) this.onerror(); } else if (this.onload) this.onload(); });
    }
    get src() { return this._src; }
  };
  app.imageSrcs = [];
  // the library: a fake by default, o.three replaces it (a namespace, or a function of this app's own fake namespace, so a library
  // that borrows the fake renderer counts its renderers on this app), o.importer replaces the whole seam
  app.fake = makeFakeThree({ makeCanvas, throwIn: o.throwIn, renderThrowsOn: o.renderThrowsOn });
  app.importCalls = 0;
  app.sandbox.kjrGateSceneImport = o.importer
    ? () => { app.importCalls++; return o.importer(); }
    : () => { app.importCalls++; return Promise.resolve(typeof o.three === 'function' ? o.three(app.fake.THREE) : (o.three || app.fake.THREE)); };
  // console.warn as the scene called it. The harness keeps only a JSON string of the arguments, which turns an Error into "{}".
  app.warnArgs = [];
  const harnessWarn = app.sandbox.console.warn;
  app.sandbox.console.warn = (...a) => { app.warnArgs.push(a); return harnessWarn(...a); };
  // listener recording, from here on only: what the intro registered at load is not the scene's
  app.log = { win: [], doc: [] };
  const winAdd = app.sandbox.addEventListener, winRem = app.sandbox.removeEventListener;
  app.sandbox.addEventListener = (t, fn, opt) => { app.log.win.push({ op: 'add', type: t, fn }); return winAdd.call(app.sandbox, t, fn, opt); };
  app.sandbox.removeEventListener = (t, fn, opt) => { app.log.win.push({ op: 'remove', type: t, fn }); return winRem.call(app.sandbox, t, fn, opt); };
  app.document.addEventListener = (t, fn) => { app.log.doc.push({ op: 'add', type: t, fn }); };
  app.document.removeEventListener = (t, fn) => { app.log.doc.push({ op: 'remove', type: t, fn }); };
  if (o.reducedMotion) {
    app.sandbox.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  }
  return app;
}

// listeners added and not yet removed, per type
function live(log, type) {
  return log.filter((e) => e.type === type).reduce((n, e) => n + (e.op === 'add' ? 1 : -1), 0);
}
const info = (app) => plain(app.sandbox.__gateSceneDebug.info());
const state = (app) => app.ctx._kjrGateScene;
const startTimers = (app) => app.timers.list().filter((t) => t.delay === 250);
const fadeTimers = (app) => app.timers.list().filter((t) => t.delay === 260);

// show the loading state and let the 250ms timer fire, then let the import, the image and the build settle
async function showLoadingAndStart(app) {
  app.ctx._kjrShowAuthState(LOADING);
  const timers = startTimers(app);
  assert.equal(timers.length, 1, 'one start timer, 250ms');
  app.timers.invoke(timers[0].id);
  await app.settle(8);
}

// run the one frame the scene has queued, at timestamp ts (ms)
function frame(app, ts) {
  const id = state(app).raf;
  assert.ok(id, 'a frame is queued');
  const fn = app.rafState.calls.get(id);
  app.rafState.calls.delete(id);
  fn(ts);
}

let realThreePromise;
const realThree = () => realThreePromise || (realThreePromise = import('../Assets/lib/three.module.js'));

// ── markup and stylesheet ───────────────────────────────────────────────────────────────────────────────────────────────

test('gate scene: the loading state holds the scene box with the static whale, and the title is visually hidden but still the focus target', () => {
  const loading = html.match(/<div id="kjr-auth-loading"[\s\S]*?\n    <\/div>/)[0];
  assert.match(loading, /<div id="kjr-auth-scene" aria-hidden="true">/);
  const img = loading.match(/<img class="kjr-auth-scene-fallback"[^>]*>/)[0];
  assert.match(img, /src="Assets\/whale-icon\.png"/);
  assert.match(img, /alt=""/);
  assert.match(img, /decoding="async"/);
  // the heading's own tag, not its id: the id also sits in the wrapper's aria-labelledby, which comes before everything inside it
  assert.ok(loading.indexOf('<div id="kjr-auth-scene"') > 0 && loading.indexOf('<div id="kjr-auth-scene"') < loading.indexOf('<h2 id="kjr-auth-loading-title"'), 'the scene sits above the heading');
  const title = loading.match(/<h2 id="kjr-auth-loading-title"[^>]*>([^<]*)<\/h2>/);
  assert.match(title[0], /class="sr-only"/);
  assert.match(title[0], /tabindex="-1"/);
  assert.match(title[0], /\bdata-auth-focus\b/);
  assert.equal(title[1], 'Checking your session…');
  assert.doesNotMatch(loading, /hig-spinner/, 'the spinner is gone from the loading state');
  assert.match(loading, /role="status" aria-labelledby="kjr-auth-loading-title"/);
});

test('gate scene: every gate state id is still there, in the markup and in the harness list', () => {
  const ids = ['kjr-auth-loading', 'kjr-auth-form', 'kjr-auth-sent', 'kjr-auth-error', 'kjr-auth-expired', 'kjr-auth-recover-form',
    'kjr-auth-recover-sent', 'kjr-auth-recover-error', 'kjr-auth-recovery-form', 'kjr-auth-recovery-expired', 'kjr-auth-recovery-error'];
  for (const id of ids) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.equal((html.match(/data-auth-state="/g) || []).length, ids.length);
});

test('gate scene: the box is 200px, rounded and on tokens, the canvas fades in 260ms, the static whale pulses 2.4s and stops under reduced motion', () => {
  const rule = (sel) => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.#]/g, '\\$&') + '\\{([^}]*)\\}')); assert.ok(m, sel); return m[1]; };
  const box = rule('#kjr-auth-scene');
  assert.match(box, /height:200px/);
  assert.match(box, /width:100%/);
  assert.match(box, /border-radius:var\(--radius\)/);
  assert.match(box, /background:var\(--bg3\)/);
  assert.match(box, /border:1px solid var\(--border\)/);
  const block = css.slice(css.indexOf('/* ── Sign-in gate whale drift (v3.81)'), css.indexOf("/* ── The rail's long-press labels"));
  assert.ok(block.length > 500, 'the block is found');
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b/, 'no literal colours, tokens only');
  assert.match(rule('#kjr-auth-scene canvas'), /transition:opacity \.26s/);
  assert.match(rule('#kjr-auth-scene canvas'), /opacity:0/);
  assert.match(rule('#kjr-auth-scene canvas.kjr-in'), /opacity:1/);
  assert.match(rule('.kjr-auth-scene-fallback'), /animation:kjrGatePulse 2\.4s ease-in-out infinite/);
  assert.match(block, /@keyframes kjrGatePulse\{0%,100%\{opacity:\.55\}50%\{opacity:1\}\}/);
  const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(reduced, /\.kjr-auth-scene-fallback\{animation:none/);
  assert.match(reduced, /#kjr-auth-scene canvas\{transition:none\}/);
  assert.ok(css.indexOf('.sr-only{') < css.indexOf('.kjr-auth-scene-fallback{'), 'the sr-only rule the title uses is defined');
  assert.doesNotMatch(css, /\.kjr-auth-state \.hig-spinner/, 'the gate spinner rule went with the spinner');
  // the v3.78 rule that keeps a ring off the gate headings still applies to the (now hidden) title
  assert.match(css, /#kjr-auth-gate \[tabindex="-1"\]:focus,#kjr-auth-gate \[tabindex="-1"\]:focus-visible\{outline:none\}/);
});

test('gate scene: the loading state still moves focus to its title', async () => {
  const app = await sceneApp();
  const target = app.document.getElementById(LOADING).querySelector('[data-auth-focus]');
  let focused = 0;
  target.focus = () => { focused++; };
  // app.js showed the loading state itself while it loaded, and that show left a focus timer of its own pending. Let it run first, so
  // the count below is the focus move of this one show and nothing else.
  app.timers.flush((t) => t.delay === 0);
  focused = 0;
  app.ctx._kjrShowAuthState(LOADING);
  assert.equal(focused, 0, 'the focus move waits for a tick, it is not part of the call');
  app.timers.flush((t) => t.delay === 0);
  assert.equal(focused, 1, 'one show moves focus once, to the loading state\'s [data-auth-focus] element');
});

// ── hooks: one call each, boot untouched ────────────────────────────────────────────────────────────────────────────────

test('gate scene: app.js hooks the scene with one call in _kjrShowAuthState and one in _kjrSetAuthGate, and kjrAuthBoot is unchanged', () => {
  const body = (name) => {
    const start = appSrc.indexOf('function ' + name + '(');
    const end = appSrc.indexOf('\n}\n', start);
    assert.ok(start > 0 && end > start, name);
    return appSrc.slice(start, end);
  };
  assert.equal((body('_kjrShowAuthState').match(/kjrGateSceneState\(id\)/g) || []).length, 1);
  assert.equal((body('_kjrSetAuthGate').match(/kjrGateSceneStop\(\)/g) || []).length, 1);
  assert.match(body('_kjrSetAuthGate'), /if \(!active && typeof kjrGateSceneStop === 'function'\) kjrGateSceneStop\(\);/);
  assert.match(body('_kjrShowAuthState'), /if \(typeof kjrGateSceneState === 'function'\) kjrGateSceneState\(id\);/);
  assert.doesNotMatch(body('kjrAuthBoot'), /kjrGateScene|__gateSceneDebug/, 'the session check does not know about the scene');
  assert.equal((appSrc.match(/kjrGateScene/g) || []).length, 4, 'two typeof guards, two calls, nothing else in app.js');
});

// ── start guards ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('gate scene: the loading state arms one 250ms timer and nothing is imported before it fires', async () => {
  const app = await sceneApp();
  app.ctx._kjrShowAuthState(LOADING);
  assert.equal(startTimers(app).length, 1);
  assert.equal(info(app).phase, 'pending');
  assert.equal(app.importCalls, 0, 'no import yet');
  assert.equal(app.canvases.length, 0, 'not even the WebGL probe yet');
  app.ctx._kjrShowAuthState(LOADING); // shown again: still one timer
  assert.equal(startTimers(app).length, 1);
  app.timers.invoke(startTimers(app)[0].id);
  assert.equal(app.importCalls, 1);
});

test('gate scene: reduced motion skips the start, no probe and no import, and the static whale stays', async () => {
  const app = await sceneApp({ reducedMotion: true });
  await showLoadingAndStart(app);
  assert.equal(app.importCalls, 0);
  assert.equal(app.canvases.length, 0);
  assert.equal(info(app).reason, 'reduced-motion');
  assert.equal(info(app).phase, 'idle');
  assert.equal(app.box.children.length, 0);
});

test('gate scene: no WebGL skips the start before anything is imported', async () => {
  const app = await sceneApp({ webgl: false });
  await showLoadingAndStart(app);
  assert.equal(app.importCalls, 0);
  assert.deepEqual(app.canvases.map((c) => c.contexts), [['webgl2', 'webgl']], 'one probe canvas, asked for webgl2 then webgl');
  assert.equal(info(app).reason, 'no-webgl');
  assert.equal(app.box.children.length, 0);
});

test('gate scene: the WebGL probe lets go of its own context at once, and a probe that cannot is harmless', async () => {
  // The probe asks a throwaway canvas for a real context. Left alone it would outlive the loading state until the garbage collector
  // came by, so it is handed back (WEBGL_lose_context) before anything else happens. Only the renderer's context may be left open.
  for (const mode of ['releases', 'no extension', 'extension throws']) {
    const app = await sceneApp();
    let released = 0;
    const lose = mode === 'releases' ? { loseContext() { released++; } }
      : mode === 'extension throws' ? { loseContext() { throw new Error('will not let go'); } } : null;
    const gl = { getExtension: (n) => (n === 'WEBGL_lose_context' ? lose : null) };
    const makeCanvas = app.document.createElement;
    app.document.createElement = (tag) => {
      const c = makeCanvas(tag);
      if (tag === 'canvas') { const getContext = c.getContext; c.getContext = (type) => (type === 'webgl2' ? gl : getContext(type)); }
      return c;
    };
    await showLoadingAndStart(app);
    assert.equal(info(app).phase, 'running', mode + ': the probe passes either way and the scene builds');
    assert.deepEqual(app.consoleWarnings, [], mode + ': a probe that will not let go is not worth a warning');
    assert.equal(released, mode === 'releases' ? 1 : 0, mode);
  }
});

test('gate scene: a state that leaves loading inside 250ms never starts', async () => {
  const app = await sceneApp();
  app.ctx._kjrShowAuthState(LOADING);
  app.ctx._kjrShowAuthState(FORM);
  assert.equal(startTimers(app).length, 0, 'the timer was cleared');
  assert.equal(app.importCalls, 0);
  // and if the timer body ran anyway (a direct start), the loading state is not showing, so it still does not start
  app.ctx.kjrGateSceneStart();
  assert.equal(app.importCalls, 0);
  assert.equal(info(app).reason, 'left-loading');
  assert.equal(app.canvases.length, 0);
});

test('gate scene: a start with no scene box in the page is skipped quietly', async () => {
  const app = await sceneApp();
  app.document._byId.delete('kjr-auth-scene');
  app.document.getElementById = (id) => (id === 'kjr-auth-scene' ? null : app.document._byId.get(id) || makeEl('div', { id }));
  app.ctx._kjrShowAuthState(LOADING);
  app.ctx.kjrGateSceneStart();
  assert.equal(info(app).reason, 'no-box');
  assert.equal(app.importCalls, 0);
});

test('gate scene: a page without a gate never arms anything', async () => {
  const app = await loadApp({ seed: null, authenticated: false });
  assert.equal(app.timers.list().filter((t) => t.delay === 250).length, 0, 'features.js load arms nothing without a real gate');
  assert.equal(plain(app.sandbox.__gateSceneDebug.info()).phase, 'idle');
});

// ── the run: build, first frame, stop ───────────────────────────────────────────────────────────────────────────────────

test('gate scene: a start builds the scene, the canvas fades in after the first frame and the static whale fades out', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  const [renderer] = app.fake.made.renderers;
  assert.equal(app.fake.made.renderers.length, 1);
  assert.equal(info(app).phase, 'running');
  assert.deepEqual(app.imageSrcs, ['./Assets/whale-icon.png']);
  assert.equal(app.box.children.length, 1, 'the canvas is in the box');
  assert.strictEqual(app.box.children[0], renderer.domElement);
  assert.equal(renderer.domElement.classList.contains('kjr-in'), false, 'no fade-in before a frame has rendered');
  assert.equal(app.box.classList.contains('kjr-scene-live'), false);
  assert.deepEqual(plain(renderer.params), { alpha: true, antialias: false, powerPreference: 'low-power' }, 'a transparent canvas, no antialiasing, the low-power GPU');
  assert.deepEqual(renderer.sizes, [[356, 198, false]], 'sized to the box, the stylesheet sizes the canvas');
  frame(app, 1000);
  assert.equal(renderer.renders, 1);
  assert.equal(renderer.domElement.classList.contains('kjr-in'), true, 'the canvas fades in once the first frame has rendered');
  assert.equal(app.box.classList.contains('kjr-scene-live'), true, 'and the static whale fades out under it');
  frame(app, 1016);
  assert.equal(renderer.renders, 2, 'it keeps looping');
  const i = info(app);
  assert.equal(i.frames, 2);
  assert.equal(typeof i.firstFrameMs, 'number');
  assert.ok(i.firstFrameMs >= 0);
  assert.equal(i.reason, '');
});

test('gate scene: the debug timings belong to the run they describe, a new loading state starts them again', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  const first = info(app);
  for (const k of ['startMs', 'importedMs', 'builtMs', 'firstFrameMs']) assert.equal(typeof first[k], 'number', k);
  assert.ok(first.startMs <= first.importedMs && first.importedMs <= first.builtMs && first.builtMs <= first.firstFrameMs, 'in order: start, import, build, first frame');
  app.ctx._kjrShowAuthState(FORM); // that run is over
  app.ctx._kjrShowAuthState(LOADING); // a new one is armed and has done nothing yet, so none of the old figures may be reported for it
  const next = info(app);
  assert.equal(next.phase, 'pending');
  for (const k of ['startMs', 'importedMs', 'builtMs', 'firstFrameMs']) assert.equal(next[k], null, k);
});

test('gate scene: pixel ratio is capped at 2, the glow follows the --accent token, and the scene graph is the glow, the motes and the whale', async () => {
  const app = await sceneApp();
  app.sandbox.devicePixelRatio = 3;
  app.sandbox.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--accent' ? ' #112233 ' : '') });
  await showLoadingAndStart(app);
  const [renderer] = app.fake.made.renderers;
  assert.equal(renderer.pixelRatio, 2);
  frame(app, 1000);
  const kids = renderer.lastScene.children;
  assert.equal(kids.length, 3);
  assert.deepEqual(kids.map((k) => k.renderOrder), [0, 1, 2], 'glow, motes, whale back to front');
  assert.equal(kids[0].material.opts.color, 0x112233);
  assert.equal(kids[0].material.opts.blending, 2, 'additive on the dark theme');
  assert.equal(kids[1].material.opts.vertexColors, true);
  assert.equal(kids[1].geometry.attributes.position.array.length, 40 * 3, 'forty motes');
  assert.equal(kids[1].geometry.attributes.color.array.length, 40 * 3);
  assert.equal(kids[1].frustumCulled, false);
  assert.equal(kids[2].geometry.w, 1);
  assert.equal(kids[2].material.opts.map.image.naturalWidth, 512, 'the whale texture is the loaded image');
  assert.equal(kids[2].material.opts.map.colorSpace, 'srgb');
  assert.equal(kids[2].material.opts.map.needsUpdate, true);
  for (const k of kids) { assert.equal(k.material.opts.depthTest, false); assert.equal(k.material.opts.depthWrite, false); }
});

test('gate scene: the light theme draws with normal blending and the deeper pastels', async () => {
  const app = await sceneApp();
  app.document.documentElement.classList.add('light');
  await showLoadingAndStart(app);
  frame(app, 1000);
  const kids = app.fake.made.renderers[0].lastScene.children;
  assert.equal(kids[0].material.opts.blending, 1);
  assert.equal(kids[1].material.opts.blending, 1);
  assert.equal(kids[0].material.opts.color, 0x5B4BD1, 'the light accent when the token cannot be read');
});

test('gate scene: _kjrShowAuthState to any other state disposes everything, loses the context, removes the canvas and both listeners', async () => {
  for (const next of [FORM, 'kjr-auth-error', 'kjr-auth-expired', 'kjr-auth-recovery-form']) {
    const app = await sceneApp();
    assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0, 'no scene listeners before a start');
    await showLoadingAndStart(app);
    frame(app, 1000);
    assert.equal(live(app.log.win, 'resize'), 1, 'one resize listener on the window');
    assert.equal(live(app.log.doc, 'visibilitychange'), 1, 'one visibilitychange listener on the document');
    const { made } = app.fake;
    assert.equal(made.geometries.length, 2);
    assert.equal(made.materials.length, 3);
    assert.equal(made.textures.length, 2);
    app.ctx._kjrShowAuthState(next);
    for (const kind of ['geometries', 'materials', 'textures', 'renderers']) {
      assert.ok(made[kind].length > 0, kind);
      assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), next + ': every ' + kind + ' disposed once');
    }
    assert.equal(made.renderers[0].contextLosses, 1, next + ': forceContextLoss ran');
    assert.equal(app.box.children.length, 0, next + ': the canvas is out of the box');
    assert.equal(made.renderers[0].domElement.parentNode, null);
    assert.equal(app.box.classList.contains('kjr-scene-live'), false, 'the static whale is the picture again');
    assert.equal(live(app.log.win, 'resize'), 0, next + ': resize listener removed');
    assert.equal(live(app.log.doc, 'visibilitychange'), 0, next + ': visibilitychange listener removed');
    assert.equal(state(app).raf, 0, 'no frame queued');
    assert.equal(app.rafState.calls.size, 0, 'and none left in the browser');
    assert.equal(info(app).phase, 'idle');
    assert.equal(info(app).contextLosses, 1);
    assert.deepEqual(info(app).disposed, { geometries: 2, materials: 3, textures: 2, renderers: 1 });
    assert.equal(info(app).canvas, false);
    // no timers left over from the run
    assert.equal(fadeTimers(app).length, 0);
  }
});

test('gate scene: _kjrSetAuthGate(false), the app showing, does the same', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  const { made } = app.fake;
  app.ctx._kjrSetAuthGate(false);
  for (const kind of ['geometries', 'materials', 'textures', 'renderers']) assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), kind);
  assert.equal(made.renderers[0].contextLosses, 1);
  assert.equal(app.box.children.length, 0);
  assert.equal(live(app.log.win, 'resize'), 0);
  assert.equal(live(app.log.doc, 'visibilitychange'), 0);
  assert.equal(info(app).phase, 'idle');
  // the gate coming up again with no scene running is harmless, and a stop with nothing running is a no-op
  app.ctx._kjrSetAuthGate(true);
  app.ctx._kjrSetAuthGate(false);
  assert.equal(made.renderers[0].contextLosses, 1);
});

test('gate scene: a stop while the box is still on screen fades the canvas out for 260ms, then disposes', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  const { made } = app.fake;
  const canvas = made.renderers[0].domElement;
  assert.equal(canvas.classList.contains('kjr-in'), true);
  app.ctx.kjrGateSceneStop(); // the loading state is still showing, so there is a fade to wait for
  assert.equal(info(app).phase, 'stopping');
  assert.equal(canvas.classList.contains('kjr-in'), false, 'the fade-out starts');
  assert.equal(made.renderers[0].disposeCalls, 0, 'nothing is freed until the fade is done');
  assert.equal(fadeTimers(app).length, 1, 'one 260ms timer');
  frame(app, 1016); // it keeps drawing while it fades
  assert.equal(made.renderers[0].renders, 2);
  app.timers.invoke(fadeTimers(app)[0].id);
  for (const kind of ['geometries', 'materials', 'textures', 'renderers']) assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), kind);
  assert.equal(made.renderers[0].contextLosses, 1);
  assert.equal(app.box.children.length, 0);
  assert.equal(live(app.log.win, 'resize'), 0);
  assert.equal(live(app.log.doc, 'visibilitychange'), 0);
  assert.equal(info(app).phase, 'idle');
});

test('gate scene: the loading state shown again while a fade-out runs finishes that run, then arms a fresh one', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  app.ctx.kjrGateSceneStop();
  assert.equal(info(app).phase, 'stopping');
  app.ctx._kjrShowAuthState(LOADING);
  assert.equal(app.fake.made.renderers[0].disposeCalls, 1, 'the old run is finished on the spot');
  assert.equal(info(app).phase, 'pending');
  assert.equal(startTimers(app).length, 1);
  assert.equal(fadeTimers(app).length, 0);
});

test('gate scene: the second start while one runs is a no-op, one renderer and one pair of listeners', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  app.ctx.kjrGateSceneStart();
  app.ctx.kjrGateSceneStart();
  app.ctx._kjrShowAuthState(LOADING);
  await app.settle(8);
  assert.equal(app.fake.made.renderers.length, 1);
  assert.equal(app.importCalls, 1);
  assert.equal(info(app).starts, 1);
  assert.equal(live(app.log.win, 'resize'), 1);
  assert.equal(live(app.log.doc, 'visibilitychange'), 1);
  assert.equal(app.box.children.length, 1);
  // and a start while the import is still in flight is a no-op too
  const slow = await sceneApp({ importer: () => new Promise(() => {}) });
  await showLoadingAndStart(slow);
  slow.ctx.kjrGateSceneStart();
  slow.ctx.kjrGateSceneStart();
  assert.equal(slow.importCalls, 1);
  assert.equal(info(slow).phase, 'loading');
});

test('gate scene: the scene adds no window pointer or key listener and none at all besides resize and visibilitychange', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  app.ctx._kjrShowAuthState(FORM);
  const winTypes = [...new Set(app.log.win.map((e) => e.type))];
  const docTypes = [...new Set(app.log.doc.map((e) => e.type))];
  assert.deepEqual(winTypes, ['resize']);
  assert.deepEqual(docTypes, ['visibilitychange']);
  for (const t of ['pointerdown', 'keydown', 'pointermove', 'pointerup', 'click', 'touchstart']) assert.ok(!winTypes.includes(t) && !docTypes.includes(t), t);
  // and the scene never touches the toast or the sign-in form
  assert.doesNotMatch(featSrc.slice(featSrc.indexOf('===== Sign-in gate whale drift'), featSrc.indexOf('// ═════════════ Polish and leftovers (v3.74)')), /\btoast\b|kjr-auth-form|kjr-auth-email|kjr-auth-password/);
});

// ── every failure falls back to the static whale ────────────────────────────────────────────────────────────────────────

test('gate scene: an import that rejects leaves the static whale, no canvas, no throw, no warning', async () => {
  const app = await sceneApp({ importer: () => Promise.reject(new Error('offline')) });
  await showLoadingAndStart(app);
  assert.equal(app.importCalls, 1);
  assert.equal(info(app).reason, 'import-failed');
  assert.equal(info(app).phase, 'idle');
  assert.equal(app.box.children.length, 0);
  assert.equal(app.box.classList.contains('kjr-scene-live'), false);
  assert.equal(app.fake.made.renderers.length, 0, 'no renderer, so no WebGL context from the scene');
  assert.deepEqual(app.consoleWarnings, [], 'an import failure is expected offline and is not a warning');
  assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0);
  assert.equal(app.timers.list().filter((t) => t.delay === 4000).length, 0, 'the 4s ceiling timer is cleared');
});

test('gate scene: an import that throws on the spot is handled the same way', async () => {
  const app = await sceneApp({ importer: () => { throw new Error('no dynamic import here'); } });
  await showLoadingAndStart(app);
  assert.equal(info(app).reason, 'import-failed');
  assert.equal(app.box.children.length, 0);
});

test('gate scene: an import that never resolves is given up on after 4s and leaves the static whale', async () => {
  const app = await sceneApp({ importer: () => new Promise(() => {}) });
  await showLoadingAndStart(app);
  assert.equal(info(app).phase, 'loading');
  const ceiling = app.timers.list().filter((t) => t.delay === 4000);
  assert.equal(ceiling.length, 1, 'the 4s ceiling');
  app.timers.invoke(ceiling[0].id);
  await app.settle(6);
  assert.equal(info(app).reason, 'import-timeout');
  assert.equal(info(app).phase, 'idle');
  assert.equal(app.box.children.length, 0);
  assert.equal(app.fake.made.renderers.length, 0);
  assert.deepEqual(app.consoleWarnings, []);
});

test('gate scene: a library that arrives after the 4s ceiling is ignored', async () => {
  let release;
  const app = await sceneApp({ importer: () => new Promise((resolve) => { release = resolve; }) });
  await showLoadingAndStart(app);
  app.timers.invoke(app.timers.list().filter((t) => t.delay === 4000)[0].id);
  await app.settle(4);
  release(app.fake.THREE);
  await app.settle(8);
  assert.equal(app.fake.made.renderers.length, 0, 'too late, nothing is built');
  assert.equal(info(app).reason, 'import-timeout');
});

test('gate scene: leaving the loading state while the import is in flight builds nothing when it lands', async () => {
  let release;
  const app = await sceneApp({ importer: () => new Promise((resolve) => { release = resolve; }) });
  await showLoadingAndStart(app);
  assert.equal(info(app).phase, 'loading');
  app.ctx._kjrShowAuthState(FORM);
  assert.equal(info(app).phase, 'idle');
  release(app.fake.THREE);
  await app.settle(8);
  assert.equal(app.fake.made.renderers.length, 0, 'no renderer, so no WebGL context');
  assert.equal(app.box.children.length, 0);
  assert.equal(app.imageSrcs.length, 0, 'the whale image is not even requested');
  assert.equal(app.timers.list().filter((t) => t.delay === 4000).length, 0, 'the ceiling timer is cleared too');
});

test('gate scene: leaving the loading state while the whale image loads builds nothing when it lands', async () => {
  const app = await sceneApp({ image: 'hang' });
  await showLoadingAndStart(app);
  assert.equal(app.imageSrcs.length, 1);
  app.ctx._kjrSetAuthGate(false);
  app.hungImage.onload();
  await app.settle(6);
  assert.equal(app.fake.made.renderers.length, 0);
  assert.equal(app.box.children.length, 0);
});

test('gate scene: a whale image that fails to load leaves the static whale and creates no renderer', async () => {
  const app = await sceneApp({ image: 'fail' });
  await showLoadingAndStart(app);
  assert.equal(info(app).reason, 'image-failed');
  assert.equal(app.fake.made.renderers.length, 0);
  assert.equal(app.box.children.length, 0);
});

test('gate scene: a box with no size (hidden, not laid out) builds nothing', async () => {
  const app = await sceneApp({ width: 0, height: 0 });
  await showLoadingAndStart(app);
  assert.equal(info(app).reason, 'no-size');
  assert.equal(info(app).phase, 'idle');
  assert.equal(app.fake.made.renderers.length, 0, 'no renderer, so no WebGL context');
  assert.equal(app.box.children.length, 0);
  assert.deepEqual(app.consoleWarnings, [], 'an unmeasured box is an expected state, not a warning');
  assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0);
  assert.equal(app.rafState.calls.size, 0);
});

test('gate scene: an exception inside the build warns, frees whatever was made, loses the context and falls back', async () => {
  // Each throw point is one constructor in build order, with what the scene had made by then. A constructor that throws hands nothing
  // back (the fake records nothing for it), so the counts are of what the scene was holding and had to free.
  const points = {
    WebGLRenderer: { renderers: 0, textures: 0, materials: 0, geometries: 0 },
    CanvasTexture: { renderers: 1, textures: 0, materials: 0, geometries: 0 },
    Texture: { renderers: 1, textures: 1, materials: 0, geometries: 0 },
    SpriteMaterial: { renderers: 1, textures: 2, materials: 0, geometries: 0 },
    BufferGeometry: { renderers: 1, textures: 2, materials: 1, geometries: 0 },
    PointsMaterial: { renderers: 1, textures: 2, materials: 1, geometries: 1 },
    PlaneGeometry: { renderers: 1, textures: 2, materials: 2, geometries: 1 },
    MeshBasicMaterial: { renderers: 1, textures: 2, materials: 2, geometries: 2 },
  };
  for (const throwIn of Object.keys(points)) {
    const app = await sceneApp({ throwIn });
    await showLoadingAndStart(app);
    const { made } = app.fake;
    for (const kind of Object.keys(points[throwIn])) assert.equal(made[kind].length, points[throwIn][kind], throwIn + ': ' + kind + ' made before the throw');
    assert.equal(info(app).reason, 'error', throwIn);
    assert.equal(info(app).phase, 'idle', throwIn);
    assert.equal(app.consoleWarnings.length, 1, throwIn);
    assert.match(app.consoleWarnings[0], /^\[gate-scene\] stopped:/);
    assert.equal(app.warnArgs[0][1].message, 'fake ' + throwIn + ' failed', 'the warning carries the error that stopped it');
    assert.equal(app.box.children.length, 0, throwIn);
    assert.equal(app.box.classList.contains('kjr-scene-live'), false);
    assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0, throwIn + ': no listener was installed');
    assert.equal(app.rafState.calls.size, 0);
    assert.equal(fadeTimers(app).length, 0, throwIn);
    for (const r of made.renderers) { assert.equal(r.disposeCalls, 1, throwIn); assert.equal(r.contextLosses, 1, throwIn + ': a renderer that was made is lost'); }
    for (const kind of ['geometries', 'materials', 'textures']) assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), throwIn + ' ' + kind);
  }
});

test('gate scene: a throw at the last step of the build, with every part made, frees all of it too', async () => {
  const app = await sceneApp();
  app.box.appendChild = () => { throw new Error('the box refuses the canvas'); };
  await showLoadingAndStart(app);
  const { made } = app.fake;
  assert.equal(info(app).reason, 'error');
  assert.equal(info(app).phase, 'idle');
  assert.equal(app.warnArgs.length, 1);
  assert.equal(app.warnArgs[0][1].message, 'the box refuses the canvas');
  assert.deepEqual([made.renderers.length, made.geometries.length, made.materials.length, made.textures.length], [1, 2, 3, 2], 'the whole scene had been made');
  for (const kind of ['renderers', 'geometries', 'materials', 'textures']) assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), kind);
  assert.equal(made.renderers[0].contextLosses, 1, 'the context is lost although the canvas never got in');
  assert.equal(made.renderers[0].domElement.parentNode, null);
  assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0);
  assert.equal(app.rafState.calls.size, 0);
});

test('gate scene: a throw inside a frame warns, stops, disposes and falls back, and later frames never run', async () => {
  const app = await sceneApp({ renderThrowsOn: 2 });
  await showLoadingAndStart(app);
  frame(app, 1000);
  assert.equal(info(app).phase, 'running');
  frame(app, 1016); // the second render throws
  assert.equal(info(app).phase, 'idle');
  assert.equal(info(app).reason, 'error');
  assert.equal(app.consoleWarnings.length, 1);
  assert.match(app.consoleWarnings[0], /^\[gate-scene\] stopped:/);
  assert.equal(app.warnArgs[0][0], '[gate-scene] stopped:');
  assert.equal(app.warnArgs[0][1].message, 'fake render failed', 'the warning carries the error that stopped it');
  const { made } = app.fake;
  assert.equal(made.renderers[0].contextLosses, 1);
  for (const kind of ['geometries', 'materials', 'textures']) assert.deepEqual(made[kind].map((x) => x.disposeCalls), made[kind].map(() => 1), kind);
  assert.equal(app.box.children.length, 0);
  assert.equal(app.box.classList.contains('kjr-scene-live'), false, 'the static whale is back');
  assert.equal(app.rafState.calls.size, 0, 'no frame is left queued');
  assert.equal(live(app.log.win, 'resize') + live(app.log.doc, 'visibilitychange'), 0);
});

test('gate scene: the hooks never throw into the gate, whatever the scene does', async () => {
  const app = await sceneApp();
  app.sandbox.setTimeout = () => { throw new Error('timers are broken'); };
  assert.doesNotThrow(() => app.ctx.kjrGateSceneState(LOADING));
  assert.equal(app.consoleWarnings.length, 1);
  const app2 = await sceneApp();
  app2.sandbox.cancelAnimationFrame = () => { throw new Error('raf is broken'); };
  await showLoadingAndStart(app2);
  frame(app2, 1000);
  assert.doesNotThrow(() => app2.ctx._kjrShowAuthState(FORM));
  assert.doesNotThrow(() => app2.ctx._kjrSetAuthGate(false));
});

// ── tab visibility and resize ───────────────────────────────────────────────────────────────────────────────────────────

test('gate scene: a hidden tab queues no frames, a visible one resumes where the whale was', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  frame(app, 1000);
  frame(app, 1100);
  const t1 = state(app).time;
  assert.ok(t1 > 0.09 && t1 < 0.11, 'seconds advance by the frame delta');
  const onVis = app.log.doc.find((e) => e.type === 'visibilitychange' && e.op === 'add').fn;
  app.document.hidden = true;
  onVis();
  assert.equal(state(app).raf, 0, 'no frame queued while hidden');
  assert.equal(app.rafState.calls.size, 0);
  assert.equal(info(app).phase, 'running', 'a hidden tab does not stop the scene, it pauses it');
  app.document.hidden = false;
  onVis();
  assert.ok(state(app).raf, 'a frame is queued again');
  frame(app, 9000); // a long gap while hidden
  assert.equal(state(app).time, t1, 'the first frame back has no delta, the whale carries on from where it was');
  frame(app, 9016);
  assert.ok(state(app).time > t1 && state(app).time < t1 + 0.02);
  // a frame delta is capped, a stall cannot throw the whale across the box
  frame(app, 20000);
  assert.ok(state(app).time < t1 + 0.02 + 0.101);
});

test('gate scene: a scene built in a hidden tab waits for the tab, then draws', async () => {
  const app = await sceneApp();
  app.document.hidden = true;
  await showLoadingAndStart(app);
  assert.equal(info(app).phase, 'running');
  assert.equal(state(app).raf, 0, 'no frame while hidden');
  app.document.hidden = false;
  app.log.doc.find((e) => e.type === 'visibilitychange' && e.op === 'add').fn();
  frame(app, 1000);
  assert.equal(app.fake.made.renderers[0].renders, 1);
});

test('gate scene: a window resize re-measures the box, resizes the renderer and the camera, and refits the whale', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  const [renderer] = app.fake.made.renderers;
  const R = state(app).res;
  assert.deepEqual([R.camera.left, R.camera.right, R.camera.top, R.camera.bottom], [-178, 178, 99, -99]);
  assert.ok(Math.abs(R.whale.scale.x - 178.2) < 0.01 && Math.abs(R.whale.scale.y - 178.2) < 0.01, 'width 60% of 356 is 213.6, capped to 90% of the 198 height, square');
  const onResize = app.log.win.find((e) => e.type === 'resize' && e.op === 'add').fn;
  app.box.clientWidth = 232; app.box.clientHeight = 198; // a 320px phone
  onResize();
  assert.deepEqual(renderer.sizes.at(-1), [232, 198, false]);
  assert.deepEqual([R.camera.left, R.camera.right], [-116, 116]);
  assert.equal(R.camera.projectionUpdates, 1);
  assert.ok(Math.abs(R.whale.scale.x - 139.2) < 0.01, '60% of 232, height is not the limit');
  app.box.clientWidth = 0; // collapsed: ignored, never a zero-size renderer
  onResize();
  assert.deepEqual(renderer.sizes.at(-1), [232, 198, false]);
});

// ── the animation ───────────────────────────────────────────────────────────────────────────────────────────────────────

// the vendored three.js with its WebGLRenderer swapped for the app's own fake one, so the renderers, their renders and their context
// losses are counted on app.fake like in every other test (a node process has no WebGL)
async function realApp(o) {
  const REAL = await realThree();
  return sceneApp(Object.assign({}, o, { three: (fake) => Object.assign({}, REAL, { WebGLRenderer: fake.WebGLRenderer }) }));
}

test('gate scene: against the real three.js constructors the build, the frames and the disposal all work (only the renderer is faked)', async () => {
  const app = await realApp();
  await showLoadingAndStart(app);
  assert.equal(info(app).phase, 'running', 'built with the real Scene, OrthographicCamera, Sprite, Points, Mesh and materials');
  const R = state(app).res;
  assert.equal(R.items.geometries.length, 2);
  assert.equal(R.items.materials.length, 3);
  assert.equal(R.items.textures.length, 2);
  let disposed = 0;
  for (const kind of ['geometries', 'materials', 'textures']) R.items[kind].forEach((o) => o.addEventListener('dispose', () => { disposed++; }));
  for (let i = 0; i < 20; i++) frame(app, 1000 + i * 16);
  assert.equal(app.fake.made.renderers[0].renders, 20);
  assert.equal(R.scene.children.length, 3);
  app.ctx._kjrShowAuthState(FORM);
  assert.equal(disposed, 7, 'every real geometry, material and texture fired dispose');
  assert.equal(app.fake.made.renderers[0].contextLosses, 1);
});

test('gate scene: the whale bobs 6px on a 3.2s sine, tilts 2 degrees, and the glow breathes inside 0 to 1', async () => {
  const app = await realApp();
  await showLoadingAndStart(app);
  const R = state(app).res;
  const animate = (t) => app.ctx.kjrGateSceneAnimate(R, t, 0);
  animate(0);
  assert.equal(R.whale.position.y, 0, 'it starts at rest, over the static whale');
  assert.equal(R.whale.rotation.z, 0);
  animate(0.8);
  assert.ok(Math.abs(R.whale.position.y - 6) < 1e-9, 'a quarter period up is +6px');
  assert.ok(Math.abs(R.whale.rotation.z - 2 * Math.PI / 180) < 1e-9, 'tilted 2 degrees, nose up as it rises');
  animate(2.4);
  assert.ok(Math.abs(R.whale.position.y + 6) < 1e-9, 'three quarters is -6px');
  assert.ok(Math.abs(R.whale.rotation.z + 2 * Math.PI / 180) < 1e-9);
  animate(3.2);
  assert.ok(Math.abs(R.whale.position.y) < 1e-9, 'back to rest after one 3.2s period');
  let lo = Infinity, hi = -Infinity, glowLo = Infinity, glowHi = -Infinity;
  for (let t = 0; t <= 9.6; t += 0.05) {
    animate(t);
    lo = Math.min(lo, R.whale.position.y); hi = Math.max(hi, R.whale.position.y);
    glowLo = Math.min(glowLo, R.glowMat.opacity); glowHi = Math.max(glowHi, R.glowMat.opacity);
    assert.ok(Math.abs(R.whale.rotation.z) <= 2 * Math.PI / 180 + 1e-9);
  }
  assert.ok(hi <= 6 + 1e-9 && lo >= -6 - 1e-9 && hi > 5.9 && lo < -5.9, 'it travels the whole 6px each way and no further');
  assert.ok(glowLo >= 0.37 && glowHi <= 0.63 && glowHi - glowLo > 0.2, 'a gentle breath: ' + glowLo + ' to ' + glowHi);
  assert.ok(R.glow.scale.x > 0 && R.glow.scale.x <= R.H * 1.05 * 1.03, 'the glow never outgrows the box');
});

test('gate scene: forty motes drift upward, sway a little, and wrap from the top back to the bottom inside the box margins', async () => {
  const app = await realApp();
  await showLoadingAndStart(app);
  const R = state(app).res;
  const span = R.H + 2 * 8;
  const yOf = (i) => R.positions[i * 3 + 1];
  assert.equal(R.motes.n, 40);
  assert.equal(R.positions.length, 120);
  // one step: every mote that did not wrap has moved up, none moved down or sideways by more than its sway allows
  const before = Array.from({ length: 40 }, (_, i) => yOf(i));
  app.ctx.kjrGateSceneAnimate(R, 1, 0.1);
  let up = 0;
  for (let i = 0; i < 40; i++) if (yOf(i) > before[i]) up++;
  assert.ok(up >= 36, 'nearly all of them rose (' + up + ')');
  // each one drifts at 9 to 26px a second and sways 1.5 to 5px either side of its own column
  for (let i = 0; i < 40; i++) {
    assert.ok(R.motes.speed[i] >= 9 && R.motes.speed[i] <= 26, 'a slow drift, ' + R.motes.speed[i]);
    assert.ok(R.motes.amp[i] >= 1.5 && R.motes.amp[i] <= 5, 'a small sway, ' + R.motes.amp[i]);
  }
  // many steps: nothing leaves the margins, the sway stays inside its amplitude, and the bottom is refilled after a wrap
  let swayed = 0;
  for (let step = 0; step < 600; step++) {
    app.ctx.kjrGateSceneAnimate(R, step * 0.1, 0.1);
    for (let i = 0; i < 40; i++) {
      assert.ok(yOf(i) >= -span / 2 - 1e-6 && yOf(i) <= span / 2 + 1e-6, 'inside the vertical margin');
      const sway = R.positions[i * 3] - (R.motes.nx[i] - 0.5) * R.W;
      assert.ok(Math.abs(sway) <= R.motes.amp[i] + 1e-4, 'the sway stays inside its amplitude');
      if (Math.abs(sway) > 0.5) swayed++;
    }
  }
  assert.ok(swayed > 600, 'they do move sideways (' + swayed + ' mote-steps over half a pixel off their column)');
  // wrap: a mote just under the top goes off it and comes back in at the bottom
  R.motes.ny[0] = 0.999;
  R.motes.speed[0] = 20;
  app.ctx.kjrGateSceneAnimate(R, 1, 0.1);
  assert.ok(R.motes.ny[0] < 0.2, 'wrapped to the bottom (' + R.motes.ny[0] + ')');
  // the buffer is flagged for upload on every step. needsUpdate is a write-only setter on a real BufferAttribute (reading it gives
  // undefined), what it does is raise the attribute's version, so the version is what shows an upload was asked for
  const version = R.moteAttr.version;
  app.ctx.kjrGateSceneAnimate(R, 1.1, 0.1);
  app.ctx.kjrGateSceneAnimate(R, 1.2, 0.1);
  assert.equal(R.moteAttr.version, version + 2, 'one upload per step');
  // colours: the accent and the five pastels, six tones across the forty, none of them black
  const REAL = await realThree();
  const rgb = R.items.geometries[0].getAttribute('color').array;
  const tones = new Set();
  for (let i = 0; i < 40; i++) {
    const c = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    assert.ok(Math.max(...c) > 0.3, 'mote ' + i + ' is not black');
    tones.add(c.map((v) => v.toFixed(4)).join(','));
  }
  assert.equal(tones.size, 6, 'the accent plus the five pastels');
  const accent = new REAL.Color(0x9F8CFF);
  assert.ok(tones.has([accent.r, accent.g, accent.b].map((v) => Math.fround(v).toFixed(4)).join(',')), 'and the accent (the dark token) is one of them');
});

test('gate scene: the whale keeps its aspect and the 60% by 90% fit, for a wide image and a tall one', async () => {
  const app = await sceneApp();
  await showLoadingAndStart(app);
  const R = state(app).res;
  R.aspect = 2; // twice as wide as tall
  app.ctx.kjrGateSceneFit(R);
  assert.ok(Math.abs(R.whale.scale.x - 213.6) < 0.01 && Math.abs(R.whale.scale.y - 106.8) < 0.01, 'width 60% of the box, height from the aspect');
  R.aspect = 0.5; // tall
  app.ctx.kjrGateSceneFit(R);
  assert.ok(Math.abs(R.whale.scale.y - 178.2) < 0.01 && Math.abs(R.whale.scale.x - 89.1) < 0.01, 'capped at 90% of the height, width from the aspect');
  assert.ok(R.glowSize <= R.H * 1.05 + 1e-9);
});

// ── the intro is not touched ────────────────────────────────────────────────────────────────────────────────────────────

test('gate scene: the launch intro block, its markup and its timers are as they were', async () => {
  const start = featSrc.indexOf('/* ===== Launch intro (v3.25) =====');
  const end = featSrc.indexOf('/* ===== Sign-in gate whale drift (v3.81) =====');
  assert.ok(start > 0 && end > start, 'the scene block follows the intro block');
  const intro = featSrc.slice(start, end);
  assert.doesNotMatch(intro, /kjrGateScene|__gateSceneDebug|kjr-auth-scene/, 'the intro knows nothing about the scene');
  assert.match(intro, /window\.addEventListener\('pointerdown', kjrIntroSkip, \{ passive: true \}\);/);
  assert.match(intro, /window\.addEventListener\('keydown', kjrIntroSkip\);/);
  assert.match(intro, /var BOOTSTRAP_CEILING_MS = 5000;/);
  assert.match(intro, /var ABSOLUTE_BACKSTOP_MS = 31000;/);
  assert.match(intro, /var KILLSWITCH_FADE_MS = 1200;/);
  assert.match(intro, /var DISSOLVE_MS = 260;/);
  assert.match(intro, /THREE = await import\('\.\/Assets\/lib\/three\.module\.js\?v=3\.31'\);/);
  for (const frag of ['<div id="intro" style="position:fixed;inset:0;z-index:100000;', '<div id="intro-stage"></div>', '<div id="intro-word"><img id="intro-word-icon" src="Assets/whale-icon.png" alt="Kujira Collectibles" /></div>', '<div id="intro-skip">tap to skip</div>']) assert.ok(html.includes(frag), frag);
  const app = await loadApp({ seed: null, authenticated: false, authGate: true });
  const delays = app.timers.list().map((t) => t.delay);
  for (const d of [1200, 5000, 31000]) assert.ok(delays.includes(d), 'the intro still arms its ' + d + 'ms timer');
  assert.equal(delays.filter((d) => d === 250).length, 0, 'and the scene arms nothing at load when the loading state is not showing');
});

test('gate scene: the seam is one import() of the URL the intro uses, which sw.js precaches', () => {
  const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8');
  assert.match(featSrc, /function kjrGateSceneImport\(\) \{ return import\('\.\/Assets\/lib\/three\.module\.js\?v=3\.31'\); \}/);
  assert.equal((featSrc.match(/import\('\.\/Assets\/lib\/three\.module\.js\?v=3\.31'\)/g) || []).length, 2, 'the intro and the scene, no other');
  assert.ok(sw.includes("'./Assets/lib/three.module.js?v=3.31'"));
  assert.ok(sw.includes("'./Assets/lib/three.core.min.js'"));
  assert.ok(sw.includes("'./Assets/whale-icon.png'"));
});

test('gate scene: a loading state already showing when features.js loads is picked up at load', async () => {
  // app.js shows the loading state before features.js has run, so the hook was not there to see it and the load-time check arms the
  // timer itself. With no stored session app.js leaves the loading state in the same tick (for the sign-in form), so nothing is armed
  const quick = await loadApp({ seed: null, authenticated: false, authGate: true });
  assert.equal(quick.document.getElementById(LOADING).hidden, true);
  assert.equal(quick.timers.list().filter((t) => t.delay === 250).length, 0);
  assert.equal(plain(quick.sandbox.__gateSceneDebug.info()).phase, 'idle');
  assert.match(featSrc, /try \{ if \(kjrGateSceneLoadingVisible\(\)\) kjrGateSceneState\('kjr-auth-loading'\); \} catch/);
  // with a stored session the session check is still waiting on its request when features.js loads (here the request never answers),
  // so the loading state is on screen at that moment and the start is armed by the load-time check
  const held = await loadApp({
    seed: null, authenticated: false, authGate: true,
    localStorage: { _kjrOwnerSessionV1: { access_token: 'test-owner-token', refresh_token: 'test-refresh-token', expires_at: 4102444800 } },
    fetch: () => new Promise(() => {}),
  });
  assert.equal(held.document.getElementById(LOADING).hidden, false, 'the loading state is still showing');
  assert.equal(held.timers.list().filter((t) => t.delay === 250).length, 1, 'the scene start is armed');
  assert.equal(plain(held.sandbox.__gateSceneDebug.info()).phase, 'pending');
  held.ctx._kjrShowAuthState(FORM); // the session check ends, and the armed start goes with it
  assert.equal(held.timers.list().filter((t) => t.delay === 250).length, 0);
  assert.equal(plain(held.sandbox.__gateSceneDebug.info()).phase, 'idle');
});
