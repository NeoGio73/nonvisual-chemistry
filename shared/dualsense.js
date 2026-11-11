/*
 * dualsense.js — PlayStation DualSense driver for Non-Visual Chemistry.
 * MIT License. Extracted from Feel the Barrier (all-courses edition, 2026-10-30) and extended
 * with sticks, buttons, tap patterns and named haptic presets.
 *
 * Two routes to the controller:
 *   1. WebHID (Chrome and Edge): full input, rumble and adaptive-trigger resistance,
 *      over USB (output report 0x02) or Bluetooth (output report 0x31, with CRC32).
 *   2. Gamepad API (most browsers): sticks, buttons and triggers, plus coarse rumble.
 *      No trigger resistance on this route.
 *
 * Loaded as a classic script (no modules) so the pages also work when opened straight from disk.
 * Exposes one global object: window.DualSense.
 *
 * Usage:
 *   DualSense.on('button', (name, down) => { ... });   // name: 'cross', 'l1', 'up', ...
 *   DualSense.on('input',  (state) => { ... });         // every input report
 *   DualSense.on('status', (status) => { ... });        // 'none' | 'usb' | 'bt' | 'gamepad' | ...
 *   DualSense.on('log',    (message) => { ... });
 *   DualSense.connect();                                 // must run inside a click or key press
 *   DualSense.tap(4);                                    // four short pulses
 *   DualSense.setTrigger('r2', [0,1,2,3,4,5,6,7,8,8]);   // resistance level 0–8 for each of 10 zones
 */
(function () {
  'use strict';

  const SONY = 0x054c;
  const FILTERS = [{ vendorId: SONY, productId: 0x0ce6 }, { vendorId: SONY, productId: 0x0df2 }];
  const ZONES = 10;               // adaptive-trigger resistance zones across the trigger travel
  const RUMBLE_INTERVAL_MS = 40;  // continuous rumble updates: at most 25 per second
  const KEEPALIVE_MS = 2000;      // re-send the trigger effect every 2 s so it never lapses

  // Tap timing from the handoff, section 5: strong motor 180–220 of 255, 60–80 ms on, 90–150 ms off.
  const TAP_DEFAULTS = { onMs: 70, offMs: 120, strong: 200, weak: 90 };

  // Named haptic presets. Every number here is listed in docs/mappings.md.
  const PRESETS = {
    tap:       { kind: 'taps', count: 1 },
    connected: { kind: 'taps', count: 2, onMs: 60, offMs: 90, strong: 180, weak: 60 },
    edge:      { kind: 'buzz', ms: 150, strong: 120, weak: 200 },   // reached the end of an axis
    flutter:   { kind: 'flutter', ms: 400 },                        // "multiplet": fast, irregular
    error:     { kind: 'buzz', ms: 300, strong: 230, weak: 230 }
  };

  /* ---------------- State ---------------- */
  const state = {
    connected: false,
    transport: null,          // 'usb' | 'bt' | 'gamepad' | null
    lx: 0, ly: 0, rx: 0, ry: 0, // sticks, -1 … +1 (up and left are negative)
    l2: 0, r2: 0,             // triggers, 0 … 1
    buttons: {}               // name → true while held
  };
  const BUTTON_NAMES = ['cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2',
    'create', 'options', 'l3', 'r3', 'ps', 'touchpad', 'mute', 'up', 'down', 'left', 'right'];
  BUTTON_NAMES.forEach(n => { state.buttons[n] = false; });

  const LABELS = {
    cross: 'Cross', circle: 'Circle', square: 'Square', triangle: 'Triangle',
    l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', create: 'Create', options: 'Options',
    l3: 'Left stick press', r3: 'Right stick press', ps: 'PS button', touchpad: 'Touchpad press',
    mute: 'Mute button', up: 'D-pad up', down: 'D-pad down', left: 'D-pad left', right: 'D-pad right'
  };

  const hid = { dev: null, seq: 0, queue: Promise.resolve(), lastInput: 0 };
  let status = 'none';
  let reducedHaptics = false;
  const triggers = { r2: null, l2: null };     // current zone strengths (arrays of 10) or null
  let rumbleWanted = [0, 0], rumbleSent = [0, 0];
  let tapToken = 0;                             // cancels a running pattern when a new one starts
  let tapBusyUntil = 0;

  /* ---------------- Events ---------------- */
  const listeners = { button: [], input: [], status: [], log: [] };
  function emit(type, a, b) { listeners[type].forEach(fn => { try { fn(a, b); } catch (e) { console.error(e); } }); }
  function log(msg) { emit('log', msg); }
  function setStatus(s) { if (s !== status) { status = s; emit('status', s); } }

  /* ---------------- Output report building (unchanged from Feel the Barrier) ---------------- */
  // Adaptive-trigger effect bytes: 0x21 = feedback with a strength per zone; 0x05 = effect off.
  function packFeedback(strengths) {
    const b = new Uint8Array(11);
    if (!strengths || !strengths.some(s => s > 0)) { b[0] = 0x05; return b; }
    let active = 0, force = 0;
    for (let i = 0; i < ZONES; i++) {
      const s = Math.max(0, Math.min(8, Math.round(strengths[i] || 0)));
      if (s > 0) { active |= 1 << i; force += ((s - 1) & 7) * Math.pow(8, i); }
    }
    b[0] = 0x21;
    b[1] = active & 0xff;
    b[2] = (active >> 8) & 0xff;
    for (let k = 0; k < 4; k++) b[3 + k] = Math.floor(force / Math.pow(256, k)) & 0xff;
    return b;
  }
  const TRIGGER_OFF = packFeedback(null);

  // The 47-byte block shared by the USB (0x02) and Bluetooth (0x31) output reports.
  // opts.rumble = [byte 2, byte 3]: byte 2 drives the right (lighter, faster) motor,
  //   byte 3 the left (heavier) motor. Feel the Barrier calls these [strong, weak]; the values
  //   it sends are equal or close, so the labels never mattered there. Here they do, so the
  //   helper rumbleBytes() below puts the heavy pulse on byte 3.
  // opts.r2 / opts.l2 = 11-byte trigger effects (byte 10 = right trigger, byte 21 = left trigger).
  function buildCommon(opts) {
    const c = new Uint8Array(47);
    if (opts.rumble) { c[0] |= 0x03; c[38] |= 0x04; c[2] = opts.rumble[0]; c[3] = opts.rumble[1]; }
    if (opts.r2) { c[0] |= 0x04; c.set(opts.r2, 10); }
    if (opts.l2) { c[0] |= 0x08; c.set(opts.l2, 21); }
    if (opts.lightbar) { c[1] |= 0x04; c[44] = opts.lightbar[0]; c[45] = opts.lightbar[1]; c[46] = opts.lightbar[2]; }
    return c;
  }
  function rumbleBytes(strong, weak) {
    const k = reducedHaptics ? 0.5 : 1;
    return [clampByte(weak * k), clampByte(strong * k)];
  }
  function clampByte(v) { return Math.max(0, Math.min(255, Math.round(v))); }

  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function btReport(common, seq) {
    const d = new Uint8Array(77);
    d[0] = (seq & 0x0f) << 4;
    d[1] = 0x10;
    d.set(common, 2);
    const pre = new Uint8Array(75);
    pre[0] = 0xa2; pre[1] = 0x31; pre.set(d.subarray(0, 73), 2);
    const crc = crc32(pre);
    d[73] = crc & 0xff; d[74] = (crc >>> 8) & 0xff; d[75] = (crc >>> 16) & 0xff; d[76] = (crc >>> 24) & 0xff;
    return d;
  }

  function hidSend(common) {
    if (!hid.dev) return Promise.resolve();
    const dev = hid.dev, transport = state.transport;
    hid.queue = hid.queue.then(async () => {
      try {
        if (transport === 'bt') await dev.sendReport(0x31, btReport(common, hid.seq++));
        else await dev.sendReport(0x02, common);
      } catch (e) {
        log('Send failed: ' + (e && e.message ? e.message : e));
      }
    });
    return hid.queue;
  }

  /* ---------------- Input reports ---------------- */
  const stick = v => Math.max(-1, Math.min(1, (v - 128) / 127.5));
  const HAT = [['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left'], []];

  // Byte layout of the data after the report ID:
  //   USB 0x01 and Bluetooth 0x31 (0x31 shifted by one byte):
  //     0–3 sticks LX LY RX RY, 4–5 triggers L2 R2, 6 counter,
  //     7 = D-pad (low 4 bits) + square, cross, circle, triangle (bits 4–7),
  //     8 = L1 R1 L2 R2 Create Options L3 R3 (bits 0–7), 9 = PS, touchpad, mute (bits 0–2).
  //   Bluetooth 0x01 (short report sent before the full format is switched on):
  //     0–3 sticks, 4–6 the three button bytes, 7–8 triggers.
  function onInputReport(e) {
    const d = e.data;
    let o, b0, b1, b2, l2, r2;
    if (e.reportId === 0x01 && state.transport === 'usb' && d.byteLength > 9) {
      o = 0; l2 = d.getUint8(4); r2 = d.getUint8(5); b0 = d.getUint8(7); b1 = d.getUint8(8); b2 = d.getUint8(9);
    } else if (e.reportId === 0x31 && d.byteLength > 10) {
      o = 1; l2 = d.getUint8(5); r2 = d.getUint8(6); b0 = d.getUint8(8); b1 = d.getUint8(9); b2 = d.getUint8(10);
    } else if (e.reportId === 0x01 && state.transport === 'bt' && d.byteLength > 8) {
      o = 0; b0 = d.getUint8(4); b1 = d.getUint8(5); b2 = d.getUint8(6); l2 = d.getUint8(7); r2 = d.getUint8(8);
    } else return;
    hid.lastInput = performance.now();
    state.lx = stick(d.getUint8(o)); state.ly = stick(d.getUint8(o + 1));
    state.rx = stick(d.getUint8(o + 2)); state.ry = stick(d.getUint8(o + 3));
    state.l2 = l2 / 255; state.r2 = r2 / 255;
    const now = {
      square: !!(b0 & 0x10), cross: !!(b0 & 0x20), circle: !!(b0 & 0x40), triangle: !!(b0 & 0x80),
      l1: !!(b1 & 0x01), r1: !!(b1 & 0x02), l2: !!(b1 & 0x04), r2: !!(b1 & 0x08),
      create: !!(b1 & 0x10), options: !!(b1 & 0x20), l3: !!(b1 & 0x40), r3: !!(b1 & 0x80),
      ps: !!(b2 & 0x01), touchpad: !!(b2 & 0x02), mute: !!(b2 & 0x04),
      up: false, down: false, left: false, right: false
    };
    (HAT[b0 & 0x0f] || []).forEach(n => { now[n] = true; });
    applyButtons(now);
    emit('input', state);
  }

  function applyButtons(now) {
    BUTTON_NAMES.forEach(n => {
      if (now[n] !== state.buttons[n]) { state.buttons[n] = now[n]; emit('button', n, now[n]); }
    });
  }

  /* ---------------- Connecting ---------------- */
  async function openDevice(dev, quiet) {
    try { if (!dev.opened) await dev.open(); }
    catch (e) { log('Could not open the controller: ' + (e && e.message ? e.message : e)); setStatus('error'); return false; }
    if (hid.dev && hid.dev !== dev) { try { hid.dev.removeEventListener('inputreport', onInputReport); } catch (e) { /* ignore */ } }
    hid.dev = dev;
    state.transport = dev.collections.some(c => (c.outputReports || []).some(r => r.reportId === 0x31)) ? 'bt' : 'usb';
    state.connected = true;
    dev.addEventListener('inputreport', onInputReport);
    if (state.transport === 'bt') {
      // Reading this feature report switches the controller to its full Bluetooth report format
      try { await dev.receiveFeatureReport(0x05); } catch (e) { log('Bluetooth setup note: ' + (e && e.message ? e.message : e)); }
    }
    setStatus(state.transport);
    log((quiet ? 'Reconnected: ' : 'Connected: ') + (dev.productName || 'DualSense') + (state.transport === 'usb' ? ' (USB cable)' : ' (Bluetooth)'));
    await hidSend(buildCommon({ lightbar: [37, 70, 196] }));
    resendTriggers();
    return true;
  }

  async function connect() {
    if (!('hid' in navigator)) {
      setStatus('unsupported');
      log('This browser cannot reach the controller directly. Use Chrome or Edge for trigger resistance.');
      return false;
    }
    let devices;
    try { devices = await navigator.hid.requestDevice({ filters: FILTERS }); }
    catch (e) {
      setStatus(e && e.name === 'SecurityError' ? 'blocked' : 'error');
      log('Connect failed: ' + (e && e.message ? e.message : e));
      return false;
    }
    if (!devices || !devices.length) { log('No controller was chosen.'); return false; }
    return openDevice(devices[0], false);
  }

  if ('hid' in navigator) {
    try {
      navigator.hid.addEventListener('disconnect', e => {
        if (e.device === hid.dev) {
          hid.dev = null; state.connected = false; state.transport = null;
          setStatus('none'); log('Controller disconnected.');
        }
      });
      navigator.hid.addEventListener('connect', e => {
        if (!hid.dev && FILTERS.some(f => f.productId === e.device.productId)) openDevice(e.device, true);
      });
      // A controller this page was allowed to use before reconnects without a prompt
      navigator.hid.getDevices().then(list => {
        const dev = list.find(d => d.vendorId === SONY && FILTERS.some(f => f.productId === d.productId));
        if (dev) openDevice(dev, true);
      }).catch(() => { /* not allowed in this frame */ });
    } catch (e) { /* WebHID blocked in this frame */ }
  }

  /* ---------------- Trigger resistance ---------------- */
  // which: 'r2', 'l2' or 'both'. strengths: 10 numbers 0–8 (0 = loose), or null for off.
  function setTrigger(which, strengths) {
    const s = strengths ? strengths.slice(0, ZONES).map(v => reducedHaptics ? Math.ceil((v || 0) / 2) : (v || 0)) : null;
    if (which === 'r2' || which === 'both') triggers.r2 = s;
    if (which === 'l2' || which === 'both') triggers.l2 = s;
    resendTriggers();
  }
  function resendTriggers() {
    if (!hid.dev) return;
    hidSend(buildCommon({
      r2: triggers.r2 ? packFeedback(triggers.r2) : TRIGGER_OFF,
      l2: triggers.l2 ? packFeedback(triggers.l2) : TRIGGER_OFF
    }));
  }
  setInterval(() => {
    if (hid.dev && (triggers.r2 || triggers.l2) && document.visibilityState === 'visible') resendTriggers();
  }, KEEPALIVE_MS);

  /* ---------------- Rumble ---------------- */
  // Continuous rumble (0–255 each). Sent at most 25 times per second. Taps take priority.
  function setRumble(strong, weak) {
    rumbleWanted = [strong, weak === undefined ? strong : weak];
  }
  setInterval(() => {
    if (performance.now() < tapBusyUntil) return;
    const want = rumbleBytes(rumbleWanted[0], rumbleWanted[1]);
    if (!hid.dev) {
      // Gamepad route: each effect lasts 120 ms, so keep re-sending while rumble is wanted
      if (want[0] || want[1]) padRumble(want[1] / 255, want[0] / 255, 120);
      rumbleSent = want;
      return;
    }
    if (want[0] === rumbleSent[0] && want[1] === rumbleSent[1]) return;
    rumbleSent = want;
    hidSend(buildCommon({ rumble: want }));
  }, RUMBLE_INTERVAL_MS);

  function sendPulse(strong, weak, ms) {
    if (hid.dev) hidSend(buildCommon({ rumble: rumbleBytes(strong, weak) }));
    else padRumble(strong / 255 * (reducedHaptics ? 0.5 : 1), weak / 255 * (reducedHaptics ? 0.5 : 1), ms);
  }
  function sendRest() {
    if (hid.dev) hidSend(buildCommon({ rumble: [0, 0] }));
    rumbleSent = [0, 0];
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Play a sequence of [onMs, offMs, strong, weak] pulses. A newer call cancels an older one.
  async function playPulses(pulses) {
    const token = ++tapToken;
    const total = pulses.reduce((t, p) => t + p[0] + p[1], 0);
    tapBusyUntil = performance.now() + total + 20;
    for (const p of pulses) {
      if (token !== tapToken) return false;
      sendPulse(p[2], p[3], p[0]);
      await wait(p[0]);
      if (token !== tapToken) return false;
      sendRest();
      await wait(p[1]);
    }
    if (token === tapToken) rumbleSent = [-1, -1]; // let continuous rumble resume on its next tick
    return true;
  }

  // n short pulses. opts: { onMs, offMs, strong, weak }.
  function tap(count, opts) {
    const o = Object.assign({}, TAP_DEFAULTS, opts || {});
    const pulses = [];
    for (let i = 0; i < count; i++) pulses.push([o.onMs, o.offMs, o.strong, o.weak]);
    return playPulses(pulses);
  }
  // Fast, irregular pulses: the "multiplet" feel. Fixed pseudo-random sequence so it feels the same each time.
  function flutter(ms) {
    const seq = [35, 50, 30, 45, 40, 55, 30, 40, 50, 35];
    const pulses = [];
    let t = 0, i = 0;
    while (t < (ms || 400)) {
      const on = seq[i % seq.length], off = seq[(i + 3) % seq.length];
      pulses.push([on, off, 170, 150]);
      t += on + off; i++;
    }
    return playPulses(pulses);
  }
  function buzz(ms, strong, weak) { return playPulses([[ms, 0, strong, weak]]); }

  function preset(name) {
    const p = PRESETS[name];
    if (!p) { log('Unknown haptic preset: ' + name); return Promise.resolve(false); }
    if (p.kind === 'taps') return tap(p.count, p);
    if (p.kind === 'flutter') return flutter(p.ms);
    return buzz(p.ms, p.strong, p.weak);
  }

  function stopHaptics() {
    tapToken++;
    tapBusyUntil = 0;
    rumbleWanted = [0, 0];
    sendRest();
  }

  // Everything off: used when the page is hidden or closed.
  function release() {
    tapToken++;
    rumbleWanted = [0, 0]; rumbleSent = [0, 0];
    if (hid.dev) hidSend(buildCommon({ r2: TRIGGER_OFF, l2: TRIGGER_OFF, rumble: [0, 0] }));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release();
    else resendTriggers();
  });
  window.addEventListener('pagehide', release);

  /* ---------------- Gamepad API fallback ---------------- */
  // Standard mapping: buttons 0–17 and axes 0–3.
  const PAD_BUTTONS = ['cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'create', 'options',
    'l3', 'r3', 'up', 'down', 'left', 'right', 'ps', 'touchpad'];
  let lastPadRumble = 0;
  function firstGamepad() {
    let gps = [];
    try { gps = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return null; }
    for (const gp of gps) if (gp) return gp;
    return null;
  }
  function padRumble(strong, weak, ms) {
    const gp = firstGamepad();
    if (!gp || !gp.vibrationActuator || !gp.vibrationActuator.playEffect) return;
    const now = performance.now();
    if (ms > 100 && now - lastPadRumble < 90) return;
    lastPadRumble = now;
    try {
      gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  let gamepadId = '';
  function pollGamepad() {
    const gp = firstGamepad();
    if (!gp) {
      if (!hid.dev && status === 'gamepad') { state.connected = false; state.transport = null; setStatus('none'); }
    } else {
      if (gp.id !== gamepadId) { gamepadId = gp.id; log('Gamepad detected: ' + gp.id); }
      if (!hid.dev && status !== 'gamepad') { state.connected = true; state.transport = 'gamepad'; setStatus('gamepad'); }
      // A direct (WebHID) connection supplies input itself; use this route only without one
      if (performance.now() - hid.lastInput > 250) {
        const ax = i => (typeof gp.axes[i] === 'number' ? gp.axes[i] : 0);
        state.lx = ax(0); state.ly = ax(1); state.rx = ax(2); state.ry = ax(3);
        const val = i => (gp.buttons[i] ? gp.buttons[i].value : 0);
        state.l2 = val(6); state.r2 = val(7);
        const now = {};
        BUTTON_NAMES.forEach(n => { now[n] = false; });
        PAD_BUTTONS.forEach((n, i) => { if (gp.buttons[i] && gp.buttons[i].pressed) now[n] = true; });
        applyButtons(now);
        emit('input', state);
      }
    }
    requestAnimationFrame(pollGamepad);
  }
  requestAnimationFrame(pollGamepad);

  /* ---------------- Public interface ---------------- */
  window.DualSense = {
    ZONES, PRESETS, TAP_DEFAULTS, BUTTON_NAMES, LABELS,
    state,
    get status() { return status; },
    get hasResistance() { return !!hid.dev; },
    get reducedHaptics() { return reducedHaptics; },
    set reducedHaptics(v) { reducedHaptics = !!v; },
    webHidAvailable: 'hid' in navigator,
    on(type, fn) { if (listeners[type]) listeners[type].push(fn); },
    connect, setTrigger, setRumble, tap, flutter, buzz, preset, stopHaptics, release,
    // Low-level helpers, kept for modules migrated from Feel the Barrier
    packFeedback, buildCommon, hidSend
  };
})();
