// Точка входа: связывает камеру, распознавание рук и все экраны сайта.

import '@fontsource-variable/noto-sans/wdth.css';
import '@fontsource-variable/onest/index.css';
import './styles/main.css';

import { applyI18n, getLang, onLangChange, setLang, t } from './i18n/i18n.js';
import { Camera, CameraError, checkCameraSupport } from './camera/camera.js';
import { HandTracker } from './hands/handTracker.js';
import { DetectionLoop } from './hands/detectionLoop.js';
import { clearCanvas, drawHands } from './hands/drawing.js';
import { hideStageMessage, showStageMessage } from './ui/stageMessage.js';
import { Recorder } from './dataset/recorder.js';
import { GestureClassifier } from './model/classifier.js';
import { TrainView } from './ui/trainView.js';
import { TranslateView } from './ui/translateView.js';
import { ModelView } from './ui/modelView.js';
import { LiveRecognizer } from './recognizer/recognizer.js';
import { SeqRunner, isSeqEnabled, setSeqEnabled } from './model/seqRunner.js';
import { ReplyView } from './ui/replyView.js';
import { PracticeView } from './ui/practiceView.js';
import { AdminView } from './ui/adminView.js';
import { AvatarView } from './ui/avatarView.js';
import { ProfileView } from './ui/profileView.js';
import { SpeechView } from './ui/speechView.js';
import { SupportView } from './ui/supportView.js';
import { initPasswordToggles } from './ui/passwordField.js';
import { initNetworkBadge } from './ui/network.js';
import { initRouter } from './ui/router.js';
import { api } from './api/api.js';

const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const stage = $('stage');

const camera = new Camera(video);
const tracker = new HandTracker();

// Состояние для «Технических данных»
const state = {
  model: 'loading', // loading | ready | error
  modelPercent: null,
  camera: 'off', // off | starting | on
  hands: [],
};

// Пропорции кадра нужны для нормализации точек (x и y в MediaPipe в разных единицах)
const getAspect = () => video.videoWidth / video.videoHeight || 4 / 3;
const isCameraOn = () => state.camera === 'on';

const recorder = new Recorder(getAspect);
const classifier = new GestureClassifier();
// Новая нейросеть (эксперимент): грузится в фоне, включается переключателем в «Технических данных»
const seq = new SeqRunner();
const recognizer = new LiveRecognizer({ classifier, getAspect, seq: { seq, enabled: isSeqEnabled } });
const translateView = new TranslateView({ classifier, recognizer, isCameraOn });
// Только в режиме разработки: доступ из консоли браузера для проверок (tests, скриншоты)
if (import.meta.env.DEV) window.__translateView = translateView;
const modelView = new ModelView({ classifier });
const adminView = new AdminView();
const avatarView = new AvatarView();
const profileView = new ProfileView();
const speechView = new SpeechView();
const supportView = new SupportView();
let lastRoute = null;
initPasswordToggles();
new ReplyView();
const onModelChange = () => {
  translateView.update();
  modelView.update();
};
const trainView = new TrainView({
  recorder,
  classifier,
  recognizer,
  isCameraOn,
  startCamera: () => startCamera(),
  onModelChange,
});
const practiceView = new PracticeView({ classifier, recognizer, isCameraOn, startCamera: () => startCamera() });

// ---------- Язык ----------

function updateLangButtons() {
  document.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === getLang()));
  });
}

document.querySelectorAll('[data-lang]').forEach((btn) => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});
onLangChange(() => {
  updateLangButtons();
  renderStatus();
  renderStats();
});

// ---------- Модель рук: начинаем грузить сразу, пока человек читает приветствие ----------

const trackerReady = tracker
  .init((percent) => {
    state.modelPercent = percent;
    renderStatus();
  })
  .then(() => {
    state.model = 'ready';
    renderStatus();
  })
  .catch((err) => {
    console.error('[hands] Модель не загрузилась:', err);
    state.model = 'error';
    renderStatus();
    throw err;
  });
trackerReady.catch(() => {}); // ошибку покажем, когда пользователь включит камеру

// ---------- Цикл распознавания ----------

const loop = new DetectionLoop({
  video,
  tracker,
  onHands(hands) {
    state.hands = hands;
    recorder.feed(hands);
    recognizer.push(hands);
    if ($('chkPoints').checked) {
      drawHands(ctx, hands, {
        mirrored: stage.classList.contains('mirrored'),
        labels: { left: t('hands.left'), right: t('hands.right') },
      });
    } else {
      clearCanvas(ctx);
    }
  },
});

// ---------- Камера ----------

/** Сообщает экранам, что камера включилась/выключилась. */
function setCameraState(next) {
  state.camera = next;
  if (next !== 'on') recognizer.reset(); // старые кадры не должны попасть в новый жест
  $('stageToolbar').hidden = next !== 'on';
  renderStatus();
  renderStats();
  trainView.onCameraChange();
  translateView.update();
}

function fitCanvas() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  stage.style.setProperty('--ar', (video.videoWidth / video.videoHeight).toFixed(4));
  stage.classList.toggle('mirrored', camera.isFrontFacing);
}

async function startCamera(opts) {
  if (state.camera !== 'off') return;
  hideStageMessage();
  setCameraState('starting');

  try {
    await camera.start(opts);
  } catch (err) {
    setCameraState('off');
    showCameraError(err instanceof CameraError ? err.code : 'unknown', err);
    return;
  }
  fitCanvas();

  if (state.model !== 'ready') {
    showStageMessage({ icon: 'loading', title: 'status.model', text: 'status.modelLoadingNoPct' });
    try {
      await trackerReady;
    } catch {
      camera.stop();
      setCameraState('off');
      showStageMessage({
        icon: 'error',
        error: true,
        title: 'err.model.title',
        text: 'err.model.text',
        actions: [{ label: 'action.reload', primary: true, onClick: () => location.reload() }],
      });
      return;
    }
    hideStageMessage();
  }

  setCameraState('on');
  loop.start();
  $('btnSwitch').hidden = (await Camera.listCameras()).length < 2;
}

function stopCamera() {
  recorder.cancel();
  loop.stop();
  camera.stop();
  clearCanvas(ctx);
  state.hands = [];
  setCameraState('off');
  showWelcome();
}

camera.onEnded = () => {
  recorder.cancel();
  loop.stop();
  clearCanvas(ctx);
  state.hands = [];
  setCameraState('off');
  showCameraError('ended');
};

function showCameraError(code, err) {
  const fatal = code === 'insecure' || code === 'unsupported';
  showStageMessage({
    icon: code === 'insecure' ? 'lock' : 'error',
    error: true,
    title: `err.${code}.title`,
    text: `err.${code}.text`,
    params: { detail: err?.cause?.message || err?.message || '' },
    actions: fatal ? [] : [{ label: 'action.retry', primary: true, onClick: () => startCamera() }],
  });
}

function showWelcome() {
  showStageMessage({
    icon: 'hand',
    title: 'welcome.title',
    text: 'welcome.text',
    actions: [{ label: 'camera.start', primary: true, onClick: () => startCamera() }],
  });
}

$('btnStop').addEventListener('click', stopCamera);

$('btnSwitch').addEventListener('click', async () => {
  loop.stop();
  try {
    await camera.switchToNext();
    fitCanvas();
    loop.start();
  } catch (err) {
    stopCamera();
    showCameraError(err instanceof CameraError ? err.code : 'unknown', err);
  }
});

$('chkPoints').addEventListener('change', () => clearCanvas(ctx));

// ---------- Технические данные ----------

function renderSeq() {
  const el = $('stSeq');
  if (!isSeqEnabled()) el.textContent = t('seq.off');
  else if (seq.error) el.textContent = t('seq.error');
  else if (!seq.ready) el.textContent = t('seq.loading');
  else el.textContent = t('seq.ready', { ms: seq.lastMs ? seq.lastMs.toFixed(1) : '—', acc: Math.round((seq.meta?.metrics?.testAccuracy ?? 0) * 100) });
}

$('chkSeq').checked = isSeqEnabled();
$('chkSeq').addEventListener('change', (e) => {
  setSeqEnabled(e.target.checked);
  recognizer.reset();
  renderSeq();
});
seq.load().then(renderSeq);

function setState(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = kind ? `state-${kind}` : '';
}

function renderStatus() {
  if (state.model === 'ready') setState('stModel', t('status.modelReady'), 'ok');
  else if (state.model === 'error') setState('stModel', t('status.modelError'), 'error');
  else if (state.modelPercent != null && state.modelPercent < 100)
    setState('stModel', t('status.modelLoading', { percent: state.modelPercent }));
  else setState('stModel', t(state.modelPercent === 100 ? 'status.modelPreparing' : 'status.modelLoadingNoPct'));

  const cameraText = { off: 'status.cameraOff', starting: 'status.cameraStarting', on: 'status.cameraOn' };
  setState('stCamera', t(cameraText[state.camera]), state.camera === 'on' ? 'ok' : '');
  renderSeq();
  const where = tracker.inWorker ? `, ${t('status.inWorker')}` : '';
  $('stDelegate').textContent = tracker.delegate ? t(`status.delegate${tracker.delegate}`) + where : '—';
}

function renderStats() {
  renderSeq(); // время расчёта новой нейросети меняется — показываем свежее
  const s = loop.stats;
  const running = isCameraOn();
  $('stVideoFps').textContent = running ? Math.round(s.videoFps) : 0;
  $('stDetectFps').textContent = running ? Math.round(s.detectFps) : 0;
  $('stDetectMs').textContent = running ? Math.round(s.detectMs) : 0;
  $('stSkip').textContent = s.skip === 1 ? t('stats.everyFrame') : t('stats.everyNth', { n: s.skip });
  $('fpsBadge').textContent = `${Math.round(s.detectFps)} FPS`;

  const sides = (running ? state.hands : []).map((h) => t(h.side === 'left' ? 'hands.left' : 'hands.right'));
  $('stHands').textContent = sides.length ? sides.join(', ') : t('hands.none');
}

// Статистику обновляем 4 раза в секунду — чаще не нужно и только тратит силы
setInterval(renderStats, 250);

// ---------- Старт ----------

applyI18n();
updateLangButtons();
// Экраны, где нужна камера. На остальных распознавание рук на паузе (сама камера не выключается,
// чтобы не спрашивать разрешение снова): иначе нейросети рук и позы 30 раз в секунду работали бы
// в фоне — и «Талаффуз», 3D-аватар, профиль заметно тормозили бы.
const CAMERA_ROUTES = new Set(['translate', 'train', 'practice']);

initRouter((route) => {
  if (state.camera === 'on') {
    if (CAMERA_ROUTES.has(route)) {
      if (!loop.running) recognizer.reset(); // кадры до паузы не должны попасть в новый жест
      loop.start();
    } else {
      loop.stop();
      clearCanvas(ctx);
    }
  }
  trainView.setActive(route === 'train');
  translateView.setActive(route === 'translate');
  modelView.setActive(route === 'model');
  practiceView.setActive(route === 'practice');
  adminView.setActive(route === 'admin');
  avatarView.setActive(route === 'avatar');
  profileView.setActive(route === 'profile');
  speechView.setActive(route === 'speech');
  // В поддержке полезно знать, с какой вкладки пришёл человек
  if (route === 'support' && lastRoute !== 'support') supportView.fromPage = lastRoute;
  supportView.setActive(route === 'support');
  lastRoute = route;
});
renderStatus();
renderStats();
initNetworkBadge();

trainView
  .init()
  // Если администратор опубликовал на сервере новую модель — скачиваем её
  .then(() => classifier.updateFromServer(() => api('/models/latest', { timeout: 8000 })))
  .then((updated) => updated && onModelChange())
  .catch((err) => console.error('[model] Не удалось загрузить модель:', err));

const problem = checkCameraSupport();
if (problem) showCameraError(problem);
else showWelcome();

// ---------- Режим показа (для проектора на защите) ----------

function setPresent(on) {
  document.body.classList.toggle('present', on);
  const btn = $('btnPresent');
  btn.setAttribute('aria-pressed', String(on));
  btn.dataset.i18nTitle = btn.dataset.i18nAriaLabel = on ? 'present.off' : 'present.on';
  btn.title = t(btn.dataset.i18nTitle);
  if (on && location.hash !== '#/' && location.hash !== '') location.hash = '#/';
}
$('btnPresent').addEventListener('click', () => setPresent(!document.body.classList.contains('present')));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('present') && $('bigText').hidden) setPresent(false);
});

// ---------- Работа без интернета ----------

// Service Worker только в собранной версии: в режиме разработки он мешал бы обновлениям
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
    console.warn('[sw] Не удалось включить работу без интернета:', err);
  });
}
