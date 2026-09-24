export function createPaperMotion(stage) {
  const rig = stage.querySelector('.paper-rig');
  const surface = stage.querySelector('.paper-surface');
  const flap = stage.querySelector('.paper-flap');
  const mirror = stage.querySelector('.paper-mirror');
  const canvas = stage.querySelector('canvas');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let animations = [];
  let frame = 0;
  let revision = 0;
  let finishEffect;

  function clearMirror() {
    for (const field of mirror.querySelectorAll('textarea')) field.value = '';
    mirror.replaceChildren();
  }

  function reset(state = 'open') {
    revision++;
    for (const animation of animations) animation.cancel();
    animations = [];
    cancelAnimationFrame(frame);
    finishEffect?.();
    finishEffect = null;
    clearMirror();
    stage.removeAttribute('data-creased');
    surface.style.clipPath = '';
    flap.querySelector('.flap-back').style.clipPath = '';
    surface.inert = state !== 'open';
    const context = canvas.getContext('2d');
    if (context) {
      context.resetTransform();
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    stage.dataset.state = state;
  }

  // The lower face needs the same ink while it turns. This inert copy is
  // wiped when the fold finishes, is cancelled, or the page is left.
  function mirrorPaper() {
    clearMirror();
    const original = surface.querySelector('.paper-content');
    const copy = original.cloneNode(true);
    for (const element of copy.querySelectorAll('[id], [name], [for]')) {
      element.removeAttribute('id');
      element.removeAttribute('name');
      element.removeAttribute('for');
    }
    mirror.append(copy);
    const sources = original.querySelectorAll('textarea');
    copy.querySelectorAll('textarea').forEach((field, index) => {
      field.value = sources[index].value;
      field.scrollTop = sources[index].scrollTop;
    });
  }

  async function turn(open) {
    const finalState = open ? 'open' : 'folded';
    if (reducedMotion.matches) {
      reset(finalState);
      return;
    }
    stage.toggleAttribute('data-creased', open);
    const current = revision;
    mirrorPaper();
    surface.inert = true;
    stage.dataset.state = 'folding';
    const timing = { duration: 1250, easing: 'cubic-bezier(.3,.02,.18,1)', fill: 'both' };
    animations = [
      flap.animate([
        { transform: `rotateX(${open ? 180 : 0}deg)` },
        { transform: `rotateX(${open ? 0 : 180}deg)` },
      ], timing),
      rig.animate([
        { transform: `translateY(${open ? 25 : 0}%)` },
        { transform: `translateY(${open ? 0 : 25}%)` },
      ], timing),
      surface.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(.79)', offset: .42 }, { filter: 'brightness(1)' }], timing),
      flap.querySelector('.flap-front').animate([{ filter: 'brightness(1)' }, { filter: 'brightness(.73)' }, { filter: 'brightness(1)' }], timing),
    ];
    if (open) {
      // Settle both hinge highlights before swapping the flap for the flat sheet.
      const fadeTiming = { duration: timing.duration, easing: 'linear', fill: 'both' };
      animations.push(
        flap.querySelector('.flap-front').animate([
          { boxShadow: 'inset 0 1px #fff8' },
          { boxShadow: 'inset 0 1px #fff8', offset: .5 },
          { boxShadow: 'inset 0 1px #fff0', offset: .9 },
          { boxShadow: 'inset 0 1px #fff0' },
        ], fadeTiming),
        surface.animate([
          { opacity: 1 },
          { opacity: 1, offset: .5 },
          { opacity: 0, offset: .9 },
          { opacity: 0 },
        ], { ...fadeTiming, pseudoElement: '::after' }),
      );
    }
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    if (revision !== current) return;
    stage.dataset.state = finalState;
    stage.removeAttribute('data-creased');
    surface.inert = !open;
    for (const animation of animations) animation.cancel();
    animations = [];
    clearMirror();
  }

  async function dissolve(kind) {
    const ash = kind === 'ash';
    const creased = stage.hasAttribute('data-creased');
    reset(ash ? 'folded' : 'open');
    stage.toggleAttribute('data-creased', creased);
    surface.inert = true;
    const ctx = canvas.getContext('2d');
    if (!ctx || reducedMotion.matches) { reset('gone'); return; }
    if (!ash) stage.dataset.state = 'burning';
    const { width, height } = stage.getBoundingClientRect();
    const noteHeight = ash ? height / 2 : height;
    const top = ash ? height / 4 : 0;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const driftSpace = ash ? 480 : 64;
    const canvasWidth = width + 64 + driftSpace;
    canvas.style.setProperty('--drift-space', `${driftSpace}px`);
    canvas.width = Math.ceil(canvasWidth * dpr);
    canvas.height = Math.ceil((height + 128) * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 64 * dpr, 64 * dpr);
    const samples = 80;
    const grain = Array.from({ length: samples + 1 }, () => Math.random() * 5);
    const particles = [];
    const anticipation = 140;
    const duration = ash ? 500 : 2200;
    const tail = 1500;
    const started = performance.now();
    let previous = started;
    let emission = 0;
    await new Promise((resolve) => {
      finishEffect = resolve;
      function draw(now) {
        const elapsed = now - started;
        const t = Math.max(0, Math.min((elapsed - anticipation) / duration, 1));
        // Gather momentum, sweep through the sheet, then settle.
        const progress = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
        const dt = Math.min((now - previous) / 1000, .05);
        previous = now;
        const edge = [];
        for (let i = 0; i <= samples; i++) {
          const u = i / samples;
          const roughness = Math.sin(u * 23 + progress * 4) * 8 + Math.sin(u * 67 - progress * 6) * 3 + grain[i];
          edge.push(ash
            ? [-30 + progress * (width + 65) + roughness, u * noteHeight]
            : [u * width, height + 65 - progress * (height + 150) + (u - .5) * 55 + roughness]);
        }
        if (ash) {
          // Clip both faces of the folded note at the same advancing edge.
          // Its real paper and wax seal remain visible until they disintegrate.
          const cut = `polygon(100% 0, 100% ${noteHeight}px, ${edge.slice().reverse().map(([x, y]) => `${Math.max(0, Math.min(width, x))}px ${y}px`).join(',')})`;
          surface.style.clipPath = cut;
          flap.querySelector('.flap-back').style.clipPath = cut;
        } else {
          surface.style.clipPath = `polygon(0 0, 100% 0, ${edge.slice().reverse().map(([x, y]) => `${x}px ${Math.max(0, Math.min(height, y))}px`).join(',')})`;
        }
        ctx.clearRect(-64, -64, canvasWidth, height + 128);
        const visibleEdge = edge.filter(([x, y]) => ash ? x > 0 && x < width : y > 0 && y < height);
        if (visibleEdge.length > 1) {
          ctx.beginPath();
          visibleEdge.forEach(([x, y], i) => i ? ctx.lineTo(x, y + top) : ctx.moveTo(x, y + top));
          if (ash) {
            ctx.strokeStyle = '#a39c8e';
            ctx.lineWidth = 1;
            ctx.stroke();
          } else {
            // Canvas only renders the edge and particles, never secret text.
            visibleEdge.slice().reverse().forEach(([x, y], i) => ctx.lineTo(x, y - 9 - grain[i]));
            ctx.closePath();
            ctx.fillStyle = '#2c1a0e';
            ctx.fill();
            ctx.beginPath();
            visibleEdge.forEach(([x, y], i) => i ? ctx.lineTo(x, y - 1) : ctx.moveTo(x, y - 1));
            ctx.shadowColor = '#ff6a15';
            ctx.shadowBlur = 18;
            ctx.strokeStyle = '#e77c30';
            ctx.lineWidth = 2.3;
            ctx.stroke();
            ctx.shadowBlur = 5;
            ctx.strokeStyle = '#ffc779';
            ctx.lineWidth = .7;
            ctx.stroke();
            ctx.shadowBlur = 0;
          }
          emission += dt * (ash ? 2600 : 180);
          while (emission >= 1) {
            emission--;
            const [x, y] = visibleEdge[Math.floor(Math.random() * visibleEdge.length)];
            particles.push({
              x, y: y + top,
              vx: ash ? 450 + Math.random() * 450 : (Math.random() - .5) * 30,
              vy: ash ? -10 - Math.random() * 50 : -18 - Math.random() * 44,
              life: ash ? 1.1 + Math.random() * .4 : 1 + Math.random() * .5,
              age: 0, size: ash ? .7 + Math.random() * 3.3 : .6 + Math.random() * 1.8,
              shade: 95 + Math.floor(Math.random() * 130),
              angle: Math.random() * Math.PI * 2,
              spin: (Math.random() - .5) * 12,
            });
          }
        }
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.age += dt;
          if (p.age >= p.life) { particles.splice(i, 1); continue; }
          const drag = Math.exp(-(ash ? 3.6 : 1.8) * dt);
          p.vx = (ash ? 18 : 0) + (p.vx - (ash ? 18 : 0)) * drag;
          p.vy = -6 + (p.vy + 6) * drag;
          p.spin *= drag;
          if (ash) p.vy += Math.sin(p.age * 16 + p.angle) * 35 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          const remaining = 1 - p.age / p.life;
          const fade = remaining * remaining * (3 - 2 * remaining);
          if (ash) {
            p.angle += p.spin * dt;
            const size = p.size * (.3 + remaining * .7);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillStyle = `rgba(${p.shade}, ${p.shade - 4}, ${p.shade - 12}, ${fade * .85})`;
            ctx.beginPath();
            ctx.moveTo(-size, -size * .4);
            ctx.lineTo(size * .7, -size * .7);
            ctx.lineTo(size * .4, size);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          } else {
            const opacity = fade * .7;
            ctx.fillStyle = `rgba(240, ${Math.round(115 + opacity * 90)}, 65, ${opacity})`;
            ctx.fillRect(p.x, p.y, p.size, p.size * .55);
          }
        }
        if (progress === 1) stage.dataset.state = 'gone';
        if (elapsed < anticipation + duration + tail) frame = requestAnimationFrame(draw);
        else { ctx.clearRect(-64, -64, canvasWidth, height + 128); finishEffect = null; resolve(); }
      }
      frame = requestAnimationFrame(draw);
    });
  }

  function lift() {
    if (reducedMotion.matches || stage.dataset.state !== 'folded') return;
    for (const animation of animations) animation.cancel();
    const animation = rig.animate([
      { transform: 'translateY(25%) translateY(0) rotateZ(0)' },
      { transform: 'translateY(25%) translateY(-6px) rotateZ(-.7deg)', offset: .4 },
      { transform: 'translateY(25%) translateY(1px) rotateZ(.1deg)', offset: .8 },
      { transform: 'translateY(25%) translateY(0) rotateZ(0)' },
    ], { duration: 300, easing: 'ease-in-out' });
    animations = [animation];
    void animation.finished.then(() => {
      animations = animations.filter((item) => item !== animation);
    }, () => {});
  }

  return { fold: () => turn(false), unfold: () => turn(true), burn: () => dissolve('burn'), ash: () => dissolve('ash'), lift, reset };
}

