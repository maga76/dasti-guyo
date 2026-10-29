// Ядро распознавания рук: MediaPipe HandLandmarker (21 точка на руке) + отсев ложных рук.
// Работает и в фоновом потоке (handWorker.js — обычный путь), и на странице (запасной путь,
// если браузер не умеет фоновые потоки с OffscreenCanvas). Само ничего не скачивает:
// WASM и модели приносит HandTracker.
//
// Ложные руки (голова, лицо в профиль, узор на флаге) отсеиваются позой тела (PoseLandmarker lite):
// настоящая кисть всегда у запястья человека, и одно запястье — одна кисть. Проверяются и новые,
// и уже ведомые руки. Пока человека не видно — проверка по позе не делается.

import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { config } from '../config.js';

// Поза пересчитывается не чаще, чем раз в столько (руки — каждый кадр)
const POSE_REFRESH_MS = 100;
// Рука в новом кадре — та же, если её центр сдвинулся меньше чем на столько размеров ладони
const MATCH_SIZES = 2.5;
// Ведомая рука пропала — столько кадров показываем её последнее положение, а не обрываем
const HOLD_FRAMES = 2;
// Ведомая рука столько проверок позы подряд не у запястья человека — это не рука (голова, узор)
const BODY_MISSES = 3;
// Пока поза тела не загрузилась, новая рука должна продержаться дольше
const STABLE_WITHOUT_POSE = 6;

/**
 * @typedef {{x:number, y:number, z:number}} Point
 * @typedef {{side:'left'|'right', score:number, landmarks:Point[], world:Point[]}} Hand
 */

// Точки позы у левой и правой кисти: запястье, мизинец, указательный, большой
const POSE_WRISTS = [
  [15, 17, 19, 21],
  [16, 18, 20, 22],
];

/**
 * Какие кисти подтверждены телом: каждое запястье человека подтверждает не больше ОДНОЙ кисти —
 * ближайшую. Иначе при жесте у лица голова «рядом с запястьем» тоже считалась бы рукой.
 * @param {{x:number,y:number}[][]} hands точки кистей
 * @param {{x:number,y:number}[]} pose 33 точки позы
 * @param {number} aspect
 * @returns {boolean[]} для каждой кисти — подтверждена ли
 */
export function bodyHands(hands, pose, aspect) {
  const d = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const pairs = [];
  hands.forEach((hand, h) => {
    const size = Math.max(d(hand[0], hand[9]), d(hand[5], hand[17]), 0.03);
    const center = { x: (hand[0].x + hand[9].x) / 2, y: (hand[0].y + hand[9].y) / 2 };
    POSE_WRISTS.forEach((points, w) => {
      const dist = Math.min(...points.map((i) => Math.min(d(hand[0], pose[i]), d(center, pose[i]))));
      if (dist < config.mediapipe.bodyHandDistance * size) pairs.push({ h, w, dist });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);
  const ok = hands.map(() => false);
  const usedWrists = new Set();
  for (const { h, w } of pairs) {
    if (ok[h] || usedWrists.has(w)) continue;
    ok[h] = true;
    usedWrists.add(w);
  }
  return ok;
}

/**
 * Пропорции похожи на кисть? У ложных срабатываний (лицо, волосы, узор одежды) точки часто
 * сбиваются в комок или растягиваются: пальцы короче половины ладони или длиннее двух с половиной.
 * @param {{x:number, y:number}[]} p 21 точка (x, y — доли ширины и высоты кадра)
 * @param {number} aspect ширина / высота кадра
 */
// Пределы проверены на 30 865 руках из записей Slovo: отбрасывается 0.06% настоящих рук
export function looksLikeHand(p, aspect) {
  const d = (a, b) => Math.hypot((p[a].x - p[b].x) * aspect, p[a].y - p[b].y);
  const palm = d(0, 9);
  // Крошечная «рука» — шум. Кисть, направленная пальцами в камеру, в кадре короткая,
  // поэтому размер — наибольшее из длины и ширины ладони
  if (Math.max(palm, d(5, 17), d(0, 5), d(0, 17)) < 0.01) return false;
  const chain = (ids) => ids.slice(1).reduce((sum, id, i) => sum + d(ids[i], id), 0);
  // Пальцы не длиннее двух с половиной ладоней (ладонь — наибольшее из длины и ширины)
  const ref = Math.max(palm, d(5, 17));
  for (const ids of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    if (chain(ids) > 2.5 * ref) return false;
  }
  // Ладонь не вдвое шире своей длины
  return d(5, 17) < 2 * Math.max(palm, d(0, 5), d(0, 17));
}

export class HandCore {
  constructor() {
    /** @type {HandLandmarker|null} */
    this.landmarker = null;
    /** @type {PoseLandmarker|null} */
    this.pose = null;
    /** @type {'GPU'|'CPU'|null} */
    this.delegate = null;
    /** @type {{hand: Hand, streak: number, missed: number, accepted: boolean, bodyMisses: number}[]} ведомые руки */
    this.tracks = [];
  }

  /** Создаёт распознаватель: сначала GPU (быстрее), если не получилось — CPU. */
  async create(fileset, modelBuffer) {
    try {
      this.landmarker = await createLandmarker(fileset, modelBuffer, 'GPU');
      warmUp(this.landmarker); // некоторые видеокарты падают только на первом кадре
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[hands] GPU недоступен, переключаюсь на CPU:', err);
      this.landmarker?.close();
      this.landmarker = await createLandmarker(fileset, modelBuffer, 'CPU');
      warmUp(this.landmarker);
      this.delegate = 'CPU';
    }
    return this.delegate;
  }

  async createPose(fileset, poseBuffer) {
    this.pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(poseBuffer), delegate: this.delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  }

  /** Поза человека на этом кадре (или не старше POSE_REFRESH_MS) или null. */
  bodyPose(image, timestamp) {
    if (!this.pose) return null;
    if (timestamp - (this.lastPoseAt ?? -Infinity) >= POSE_REFRESH_MS) {
      try {
        const result = this.pose.detectForVideo(image, timestamp);
        this.lastPose = result.landmarks?.[0] ?? null;
      } catch {
        this.lastPose = null;
      }
      this.lastPoseAt = timestamp;
      this.poseVersion = (this.poseVersion ?? 0) + 1;
    }
    return this.lastPose;
  }

  /**
   * Находит руки на кадре.
   * @param {HTMLVideoElement|ImageBitmap} image
   * @param {number} timestamp монотонно растущее время, мс
   * @param {number} aspect ширина / высота кадра
   * @returns {Hand[]}
   */
  detect(image, timestamp, aspect) {
    const result = this.landmarker.detectForVideo(image, timestamp);
    const mp = config.mediapipe;
    // В разных версиях библиотеки поле называется по-разному
    const handedness = result.handedness ?? result.handednesses ?? [];
    const hands = result.landmarks
      .map((landmarks, i) => {
        const category = handedness[i]?.[0];
        let side = category?.categoryName === 'Left' ? 'left' : 'right';
        if (mp.swapHandedness) side = side === 'left' ? 'right' : 'left';
        return {
          side,
          score: category?.score ?? 0,
          landmarks,
          world: result.worldLandmarks?.[i] ?? [],
        };
      })
      .filter((hand) => hand.score >= mp.minHandScore && looksLikeHand(hand.landmarks, aspect));
    // Позу считаем, только если есть новая рука, которую надо проверить: ведомым рукам она не нужна
    return this.track(hands, aspect, () => this.bodyPose(image, timestamp));
  }

  /**
   * Ведение рук от кадра к кадру — чтобы рука не «обрывалась»:
   *   - найденная рука узнаётся по положению (а не по «левая/правая» — MediaPipe иногда путает их
   *     на один кадр) и сохраняет свою сторону;
   *   - НОВАЯ рука засчитывается, только если видна stableFrames кадров подряд и (когда виден
   *     человек) находится у его запястья — так отсекаются лицо и узоры. Уже ведомую руку эти
   *     проверки не выкидывают: при быстром жесте поза отстаёт, а рука смазывается;
   *   - пропала на 1–2 кадра — показываем последнее положение (HOLD_FRAMES).
   * @param {Hand[]} hands руки этого кадра
   * @param {number} aspect
   * @param {() => object[]|null} getBody поза человека (считается по требованию)
   */
  track(hands, aspect, getBody) {
    const mp = config.mediapipe;
    const center = (lm) => ({ x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 });
    const size = (lm) => Math.max(Math.hypot((lm[0].x - lm[9].x) * aspect, lm[0].y - lm[9].y), 0.04);
    const dist = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

    // Сопоставить руки кадра с ведомыми: ближайшие пары по центру ладони
    const pairs = [];
    hands.forEach((hand, h) => {
      const c = center(hand.landmarks);
      this.tracks.forEach((track, t) => {
        const d = dist(c, center(track.hand.landmarks));
        if (d < MATCH_SIZES * Math.max(size(hand.landmarks), size(track.hand.landmarks))) pairs.push({ h, t, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedHands = new Set();
    const usedTracks = new Set();
    for (const { h, t } of pairs) {
      if (usedHands.has(h) || usedTracks.has(t)) continue;
      usedHands.add(h);
      usedTracks.add(t);
      const track = this.tracks[t];
      // Ведомая рука сохраняет сторону, новая — берёт ответ MediaPipe
      track.hand = { ...hands[h], side: track.accepted ? track.hand.side : hands[h].side };
      track.streak += 1;
      track.missed = 0;
    }
    // Пропавшие руки: держим немного, потом забываем
    this.tracks = this.tracks.filter((track, t) => usedTracks.has(t) || ++track.missed <= (track.accepted ? HOLD_FRAMES : 0));
    hands.forEach((hand, h) => {
      if (!usedHands.has(h)) this.tracks.push({ hand, streak: 1, missed: 0, accepted: false, bodyMisses: 0 });
    });

    // Проверка по позе тела: новые руки (продержавшиеся stableFrames кадров) и — постоянно —
    // уже ведомые, чтобы голова или узор, однажды принятые за руку, не оставались ею.
    // Каждое запястье подтверждает только одну кисть (bodyHands)
    const stable = this.pose ? mp.stableFrames : STABLE_WITHOUT_POSE;
    const check = this.tracks.filter((t) => t.missed === 0 && (t.accepted || t.streak >= stable));
    if (check.length) {
      const body = getBody();
      // Промах ведомой руке засчитываем только по свежей позе: старая при быстром жесте отстаёт
      const fresh = this.poseVersion !== this.checkedPoseVersion;
      this.checkedPoseVersion = this.poseVersion;
      const ok = body ? bodyHands(check.map((t) => t.hand.landmarks), body, aspect) : check.map(() => true);
      check.forEach((track, i) => {
        if (ok[i]) {
          track.accepted = true;
          track.bodyMisses = 0;
        } else if (track.accepted && fresh && ++track.bodyMisses >= BODY_MISSES) {
          track.accepted = false; // так долго не у запястья — это не рука
          track.streak = 0;
        }
      });
    }

    // Не больше двух рук и не две «левые»: вторая получает другую сторону
    const shown = this.tracks.filter((t) => t.accepted).slice(0, 2);
    if (shown.length === 2 && shown[0].hand.side === shown[1].hand.side) {
      shown[1].hand = { ...shown[1].hand, side: shown[0].hand.side === 'left' ? 'right' : 'left' };
    }
    return shown.map((t) => t.hand);
  }

  /** Новая серия кадров (камера включилась снова) — прежние руки забываем. */
  reset() {
    this.tracks = [];
  }

  close() {
    this.landmarker?.close();
    this.pose?.close();
    this.landmarker = null;
    this.pose = null;
  }
}

function createLandmarker(fileset, modelBuffer, delegate) {
  const mp = config.mediapipe;
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBuffer, delegate },
    runningMode: 'VIDEO',
    numHands: mp.numHands,
    minHandDetectionConfidence: mp.minDetectionConfidence,
    minHandPresenceConfidence: mp.minPresenceConfidence,
    minTrackingConfidence: mp.minTrackingConfidence,
  });
}

/** Пробный прогон на пустой картинке: проверяет, что выбранный делегат реально работает. */
function warmUp(landmarker) {
  const canvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  canvas.getContext('2d').fillRect(0, 0, 64, 64);
  landmarker.detectForVideo(canvas, performance.now());
}
