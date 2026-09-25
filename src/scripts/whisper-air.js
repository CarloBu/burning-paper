// Use the same cubic-bezier curve for canvas motion and the text animation.
function bezier(x1, y1, x2, y2) {
  const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  return {
    css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
    at(progress) {
      if (progress <= 0 || progress >= 1) return Math.max(0, Math.min(1, progress));
      let low = 0;
      let high = 1;
      for (let step = 0; step < 14; step++) {
        const t = (low + high) / 2;
        if (cubic(t, x1, x2) < progress) low = t;
        else high = t;
      }
      return cubic((low + high) / 2, y1, y2);
    },
  };
}

const gatherTiming = { duration: 1300, easing: bezier(0.45, 0, 0.15, 1) };
const revealTiming = { duration: 900, easing: bezier(0.2, 0, 0.2, 1) };
const releaseTiming = { duration: 1100, delay: 120, fadeAfter: 0.2, easing: bezier(0.55, 0, 0.15, 1) };

// Decorative only: this renderer never reads the message or its fields.
export function createWhisperAir(stage) {
  const canvas = stage.querySelector('canvas');
  const context = canvas.getContext('2d');
  if (!context) return { gather: async () => {}, reveal: async () => {}, release: async () => {}, pulse() {}, reset() {}, dispose() {} };

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let frame = 0;
  let previous = 0;
  let time = 0;
  let suspended = false;
  const open = { bind: 0, squeeze: 1, spread: 1, opacity: 1, drift: 0, part: 0, speed: 1, strength: 0.46 };
  const held = { ...open, bind: 1, spread: 0.9, speed: 0.55, strength: 0.85 };
  let shape = { ...open };
  let transition = null;
  let textAnimation = null;
  let stretch = 0;
  let stretchVelocity = 0;

  function sample() {
    if (!transition) return shape;
    const progress = Math.max(0, Math.min(1, (performance.now() - transition.start) / transition.duration));
    return Object.fromEntries(Object.keys(open).map(key => {
      const offset = key === 'opacity' ? transition.fadeAfter : 0;
      const eased = transition.easing.at((progress - offset) / (1 - offset));
      return [key, transition.from[key] + (transition.to[key] - transition.from[key]) * eased];
    }));
  }

  function settle() {
    if (!transition) return;
    const pending = transition;
    transition = null;
    clearTimeout(pending.timer);
    shape = pending.to;
    textAnimation?.cancel();
    textAnimation = null;
    pending.resolve();
  }

  function play(target, timing, field, keyframes) {
    const from = sample();
    settle();
    if (motion.matches || document.hidden || suspended) {
      shape = target;
      sync();
      return Promise.resolve();
    }
    const { duration, delay = 0, fadeAfter = 0, easing } = timing;
    return new Promise(resolve => {
      transition = { from, to: target, start: performance.now() + delay, duration, fadeAfter, easing, resolve };
      transition.timer = setTimeout(() => { settle(); sync(); }, duration + delay);
      if (field) textAnimation = field.animate(keyframes, { duration, delay, easing: easing.css, fill: 'both' });
      sync();
    });
  }

  function reset(state = 'open') {
    settle();
    stretch = 0;
    stretchVelocity = 0;
    shape = state === 'gone' ? { ...open, opacity: 0 } : state === 'held' ? { ...held } : { ...open };
    sync();
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const current = sample();
    if (!current.opacity) return;
    const spread = current.spread * (1 + stretch * current.bind * 0.3);
    const ink = context.createLinearGradient(width * (0.5 - spread / 2), 0,
      width * (0.5 + spread / 2), 0);
    ink.addColorStop(0, 'rgba(201, 217, 236, 0)');
    ink.addColorStop(0.22, 'rgba(201, 217, 236, 0.28)');
    ink.addColorStop(0.55, 'rgba(235, 242, 250, 0.58)');
    ink.addColorStop(0.82, 'rgba(201, 217, 236, 0.24)');
    ink.addColorStop(1, 'rgba(201, 217, 236, 0)');
    context.strokeStyle = ink;

    // Each filament bends independently as several travelling currents meet.
    for (let ribbon = 0; ribbon < 42; ribbon++) {
      const v = ribbon / 41;
      const edge = Math.sin(Math.PI * v);
      const pulse = 0.6 + 0.4 * Math.sin(time * 0.65 + v * 15);
      context.globalAlpha = current.strength * edge * pulse * current.opacity;
      context.lineWidth = 0.45 + 0.65 * pulse;
      context.beginPath();
      for (let point = 0; point <= 80; point++) {
        const u = point / 80;
        const envelope = Math.sin(Math.PI * u);
        const swell = Math.sin(u * 6.3 - time * 0.7 + v * 4.8);
        const curl = Math.sin(u * 11 + time * 0.48 - v * 7.2);
        const ripple = Math.sin(u * 19 - time * 0.9 + v * 12);
        const flow = 0.08 + v * 0.84 + envelope * edge * (
          swell * 0.095 + curl * 0.045 + ripple * 0.012
        );
        // The ends gather around a curved, breathing bundle. Strands arrive
        // at different times instead of shrinking the entire field uniformly.
        const lag = 0.2 * (0.5 + 0.5 * Math.sin(v * 8)) + 0.15 * (1 - envelope);
        const binding = Math.max(0, Math.min(1, current.bind * 1.35 - lag));
        const tension = envelope * (
          (v - 0.5) * 0.25 * envelope ** 0.7
          + 0.06 * Math.sin(u * Math.PI * 2 + v * 1.4 - time * 0.35)
          + 0.022 * Math.sin(u * Math.PI * 4 - v * 3 + time * 0.55)
        );
        const settling = Math.sin(Math.PI * binding) * Math.sin(v * 9 + binding * 8) * envelope * 0.025;
        const gathered = tension * (1 + stretch) + settling;
        const offset = (flow - 0.5) * (1 - binding) + gathered * binding;
        const breath = 1 + 0.06 * Math.sin(time * 1.1);
        const y = height * (0.5 + offset * current.squeeze * breath
          + (2 * v - 1) * current.part * envelope * 0.1);
        const x = width * (0.5 + (u - 0.5) * spread + current.drift * envelope);
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  function animate(now) {
    frame = requestAnimationFrame(animate);
    if (now - previous < 1000 / 30) return;
    const elapsed = Math.min((now - previous) / 1000, 0.05);
    // A damped spring keeps repeated copy clicks continuous, with one soft rebound.
    const decay = Math.exp(-6 * elapsed);
    const cosine = Math.cos(9 * elapsed);
    const sine = Math.sin(9 * elapsed);
    const nextStretch = decay * (stretch * cosine + (stretchVelocity + 6 * stretch) / 9 * sine);
    stretchVelocity = decay * (stretchVelocity * cosine - (6 * stretchVelocity + 117 * stretch) / 9 * sine);
    stretch = nextStretch;
    const speed = sample().speed;
    time += elapsed * speed;
    previous = now;
    draw();
  }

  function sync() {
    cancelAnimationFrame(frame);
    if (stage.hidden || document.hidden || suspended || !width || !height) return;
    draw();
    previous = performance.now();
    if (!motion.matches && (shape.opacity || transition)) frame = requestAnimationFrame(animate);
  }

  const resize = new ResizeObserver(() => {
    width = stage.clientWidth;
    height = stage.clientHeight;
    if (!width || !height) return;
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    sync();
  });
  const state = new MutationObserver(sync);
  state.observe(stage, { attributes: true, attributeFilter: ['hidden', 'data-view', 'data-busy'] });
  resize.observe(stage);
  document.addEventListener('visibilitychange', sync);
  const motionChanged = () => {
    if (motion.matches) { settle(); stretch = 0; stretchVelocity = 0; }
    sync();
  };
  motion.addEventListener('change', motionChanged);
  const pause = () => { suspended = true; sync(); };
  const resume = () => { suspended = false; sync(); };
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);

  function dispose() {
    settle();
    cancelAnimationFrame(frame);
    resize.disconnect();
    state.disconnect();
    document.removeEventListener('visibilitychange', sync);
    motion.removeEventListener('change', motionChanged);
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
  }

  return {
    gather: field => play({ ...held }, gatherTiming, field, [
      { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' },
      { opacity: 0, transform: 'translateY(35px) scale(.6, .1)', filter: 'blur(18px)' },
    ]),
    reveal: field => {
      reset('held');
      return play({ ...open }, revealTiming, field, [
        { opacity: 0, transform: 'translateY(8px)', filter: 'blur(4px)' },
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
      ]);
    },
    release: () => play({ ...open, squeeze: 1.6, spread: 1.5, opacity: 0, drift: 0.35, part: 0.5, speed: 1.8 }, releaseTiming),
    pulse() {
      if (motion.matches || stage.hidden || document.hidden || suspended || transition || !shape.bind) return;
      stretchVelocity = Math.min(stretchVelocity + 3, 5);
      sync();
    },
    reset,
    dispose,
  };
}
