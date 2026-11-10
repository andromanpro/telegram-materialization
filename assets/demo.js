const root = document.querySelector('.tg-invite');
const stage = root.querySelector('.tg-invite-stage');
const canvas = root.querySelector('canvas');
const poster = root.querySelector('img');
const buttons = [...document.querySelectorAll('[data-scene]')];
const playButton = document.querySelector('#play');
const slider = document.querySelector('#timeline');
const clock = document.querySelector('#clock');
const phase = document.querySelector('#phase');
const language = document.documentElement.lang;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const variants = ['fabricator', 'printer', 'fragments'];
const query = new URLSearchParams(location.search);
const text = language === 'ru' ? {
  preparing:'Подготовка сцены',build:'Материализация',hold:'Готово',fold:'Складывание бумаги',departure:'Полёт',reset:'Возврат',
  play:'Воспроизвести',pause:'Пауза',fallback:'Доступно статичное изображение. Для анимации нужен WebGL.'
} : {
  preparing:'Preparing the scene',build:'Materialization',hold:'Ready',fold:'Folding the paper',departure:'Flight',reset:'Reset',
  play:'Play',pause:'Pause',fallback:'Static preview available. Animation requires WebGL.'
};
let variant = variants.includes(query.get('scene')) ? query.get('scene') : variants[Math.floor(Math.random()*variants.length)];
let scene;
let modulePromise;
let frame;
let elapsed = 0;
let lastTime = null;
let wanted = !reducedMotion.matches;
let visible = true;
let prepared = false;
let revision = 0;
let pending = Promise.resolve();
if(query.has('record')) document.body.classList.add('recording');

function timing() {
  const build = variant === 'fabricator' ? 7 : 5.6;
  const departure = scene.departureDuration / 1000;
  return { build, hold: .3, departure, reset: .65, total: build + .3 + departure + .65 };
}

function draw() {
  if (!prepared) return;
  const times = timing();
  const cycle = Math.floor(elapsed / times.total);
  const time = elapsed % times.total;
  let label;
  let pose;
  if (time < times.build) {
    label = 'build';
    pose = { progress: time / times.build, departure: 0 };
  } else if (time < times.build + times.hold) {
    label = 'hold';
    pose = { progress: 1, departure: 0 };
  } else if (time < times.build + times.hold + times.departure) {
    const departure = (time - times.build - times.hold) / times.departure;
    label = variant === 'printer' && departure < .2 ? 'fold' : 'departure';
    pose = { progress: 1, departure };
  } else {
    label = 'reset';
    pose = { progress: 0, departure: 0, reset: (time - times.build - times.hold - times.departure) / times.reset };
  }
  scene.render(pose.progress, { departure: pose.departure, reset: pose.reset, cycle });
  if (phase.textContent !== text[label]) phase.textContent = text[label];
  root.dataset.phase = label;
  root.dataset.state = 'ready';
  slider.max = times.total;
  slider.value = time;
  clock.textContent = time.toFixed(1) + ' / ' + times.total.toFixed(1) + ' s';
}

function stopClock() {
  cancelAnimationFrame(frame);
  frame = null;
  lastTime = null;
}

function playback() {
  stopClock();
  playButton.textContent = wanted ? text.pause : text.play;
  if (!prepared || !wanted || !visible || document.hidden) return;
  function animate(time) {
    if (lastTime !== null) elapsed += Math.min(40, Math.max(0, time - lastTime)) / 1000;
    lastTime = time;
    draw();
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
}

async function select(next, autoplay = wanted) {
  if (!variants.includes(next)) throw new Error('Unknown scene');
  const token = ++revision;
  wanted = autoplay;
  prepared = false;
  stopClock();
  root.dataset.state = 'preparing';
  canvas.dataset.visible = 'false';
  phase.textContent = text.preparing;
  poster.src = '../assets/posters/' + next + '-' + language + '.webp';
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scene === next)));
  const url = new URL(location.href);
  url.searchParams.set('scene', next);
  history.replaceState(null, '', url);
  document.querySelectorAll('[data-language]').forEach(link => {
    link.href = '../' + link.dataset.language + '/?scene=' + next;
  });
  pending = pending.catch(() => {}).then(async () => {
    if (token !== revision) return;
    if (!modulePromise) modulePromise = import('./js/telegram-scenes.js');
    const module = await modulePromise;
    await document.fonts.ready;
    if (token !== revision) return;
    if (scene) {
      scene.setVariant(next, language);
    } else {
      canvas.className = 'tg-invite-flight';
      document.body.append(canvas);
      scene = module.createTelegramScene(canvas, next, language, { anchor: stage, overlay: true });
    }
    await scene.prepare();
    if (token !== revision) return;
    variant = next;
    elapsed = 0;
    prepared = true;
    canvas.dataset.visible = 'true';
    draw();
    playback();
    document.querySelector('#scene-title').textContent = buttons.find(button => button.dataset.scene === next).textContent;
  }).catch(error => {
    if (token !== revision) return;
    scene?.dispose();
    scene = null;
    prepared = false;
    root.dataset.state = 'static';
    phase.textContent = text.fallback;
    playButton.disabled = true;
    console.error(error);
  });
  return pending;
}

buttons.forEach(button=>button.addEventListener('click',()=>select(button.dataset.scene)));
playButton.addEventListener('click',()=>{wanted=!wanted;playback();});
slider.addEventListener('input',()=>{wanted=false;stopClock();elapsed=Number(slider.value);draw();playback();});
document.addEventListener('visibilitychange',playback);
const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;playback();},{threshold:.15});observer.observe(stage);
const resize=new ResizeObserver(()=>{if(prepared){scene.resize();draw();}});resize.observe(stage);
reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches){wanted=false;playback();}});
addEventListener('pagehide',()=>{stopClock();observer.disconnect();resize.disconnect();scene?.dispose();});
window.demo = {
  select,
  pause() { wanted = false; playback(); },
  play() { wanted = true; playback(); },
  seek(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Time must be finite and non-negative');
    wanted = false;
    stopClock();
    elapsed = seconds;
    draw();
    playback();
  },
  get ready() { return pending; },
  get duration() { return prepared ? timing().total : 0; },
  get variant() { return variant; },
  get prepared() { return prepared; },
};
select(variant);
