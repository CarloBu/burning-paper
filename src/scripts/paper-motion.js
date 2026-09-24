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

  return { fold: () => turn(false), unfold: () => turn(true), lift, reset };
}

