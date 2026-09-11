'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must remain defined');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(name + ' has no balanced function body');
}

function makeElement(id) {
  const attrs = new Set();
  const listeners = new Map();
  const classes = new Set();
  return {
    id: id || '',
    hidden: false,
    innerHTML: '',
    classList: {
      add(...values) { values.forEach(value => classes.add(value)); },
      remove(...values) { values.forEach(value => classes.delete(value)); },
      contains(value) { return classes.has(value); },
    },
    setAttribute(name) { attrs.add(name); },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    _listeners: listeners,
  };
}

function makeDocument(children) {
  const body = {
    children,
    appendChild(child) { children.push(child); return child; },
  };
  const rootClasses = new Set(['auth-gated']);
  const documentElement = {
    classList: {
      contains(value) { return rootClasses.has(value); },
      toggle(value, active) {
        if (active) rootClasses.add(value);
        else rootClasses.delete(value);
      },
    },
  };
  return {
    body,
    documentElement,
    createElement() { return makeElement(); },
    getElementById(id) { return children.find(child => child.id === id) || null; },
  };
}

function serviceWorkerBootstrap(source) {
  const start = source.indexOf('(function() {', source.indexOf('// Register the service worker'));
  const end = source.indexOf('\n(function(){', start);
  assert.ok(start >= 0 && end > start, 'features.js must keep the service-worker bootstrap first');
  return source.slice(start, end).trim();
}

test('sw-auth: auth gate leaves only the signed-out update pill interactive', () => {
  const appSource = read('app.js');
  const cssSource = read('styles.css');
  const gate = makeElement('kjr-auth-gate');
  const pill = makeElement('kjr-update-pill');
  const privatePanel = makeElement('inventory-page');
  const document = makeDocument([gate, pill, privatePanel]);
  const setAuthGate = vm.runInNewContext('(' + extractFunction(appSource, '_kjrSetAuthGate') + ')', { document });

  setAuthGate(true);
  assert.equal(gate.hidden, false, 'the auth gate remains visible while signed out');
  assert.equal(pill.hasAttribute('inert'), false, 'the update control remains interactive');
  assert.equal(privatePanel.hasAttribute('inert'), true, 'private app content remains inert');

  setAuthGate(false);
  assert.equal(gate.hidden, true, 'the auth gate closes after authentication');
  assert.equal(pill.hasAttribute('inert'), false);
  assert.equal(privatePanel.hasAttribute('inert'), false);

  assert.match(cssSource, /html\.auth-gated body > :not\(#kjr-auth-gate\):not\(#kjr-update-pill\)\{visibility:hidden\}/);
  assert.match(cssSource, /#kjr-update-pill\{[^}]*z-index:149/);
  assert.match(cssSource, /html\.auth-gated #kjr-update-pill\{z-index:200001\}/);
});

test('sw-auth: signed-out waiting-worker action is a native clickable control', async () => {
  const featuresSource = read('features.js');
  const gate = makeElement('kjr-auth-gate');
  const document = makeDocument([gate]);
  const workerMessages = [];
  const worker = { postMessage(message) { workerMessages.push(message); } };
  const registration = {
    waiting: worker,
    installing: null,
    addEventListener() {},
  };
  let loadHandler = null;
  const sandbox = {
    document,
    navigator: {
      serviceWorker: {
        controller: {},
        register: async () => registration,
        addEventListener() {},
      },
    },
    window: {
      addEventListener(type, listener) {
        if (type === 'load') loadHandler = listener;
      },
    },
    location: { reload() {} },
    console,
  };

  vm.runInNewContext(serviceWorkerBootstrap(featuresSource), sandbox, { filename: 'features.js' });
  assert.equal(typeof loadHandler, 'function');
  await loadHandler();

  const pill = document.getElementById('kjr-update-pill');
  assert.ok(pill, 'waiting worker creates the update pill');
  assert.equal(pill.hasAttribute('inert'), false);
  assert.equal(pill.classList.contains('show'), true);
  assert.match(pill.innerHTML, /<button id="kjr-update-pill-action"[^>]*type="button"[^>]*>Reload now<\/button>/);

  const action = { id: 'kjr-update-pill-action', disabled: false, textContent: 'Reload now' };
  const click = pill._listeners.get('click')[0];
  click({ target: action });
  assert.deepEqual(workerMessages.map(message => message.type), ['SKIP_WAITING']);
  assert.equal(action.disabled, true);
  assert.equal(action.textContent, 'Updating…');
});
