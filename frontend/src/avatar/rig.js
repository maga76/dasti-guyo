// Перенос движения рук (точки MediaPipe) на скелет 3D-аватара.
//
// Для каждой руки:
//   1. Запястье ставится в нужную точку двухзвенной обратной кинематикой (плечо → локоть → кисть):
//      локоть сам находит положение, «глядя» вниз и немного наружу, как у живого человека.
//   2. Кисть поворачивается так, чтобы ладонь совпала с ладонью на записи
//      (направление «запястье → средний палец» и «мизинец → указательный»).
//   3. Каждая фаланга пальца направляется вдоль отрезка между соседними точками MediaPipe.
// Скелет — как у Mixamo / Ready Player Me: LeftArm, LeftForeArm, LeftHand, LeftHandIndex1…
//
// Координаты: аватар смотрит на +Z (на зрителя), его правая рука — со стороны −X.

import * as THREE from 'three';

const FINGERS = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20],
};

// Пределы суставов, радианы: палец не гнётся назад и не сгибается сильнее, чем у человека
const LIMITS = {
  mcp: [-0.15, 1.6],
  pip: [0, 1.9],
  dip: [0, 1.4],
  spread: [-0.3, 0.3],
  thumbMcp: [0, 1.0],
  thumbIp: [0, 1.3],
};

// Знак нормали ладони (cross(вперёд, мизинец→указательный)) так, чтобы она смотрела внутрь ладони.
// У левой и правой руки он противоположный (зеркальные руки). Проверено по скелетам всех аватаров:
// в покое большой палец и чуть согнутые кончики пальцев лежат со стороны ладони — именно по этой нормали.
export const PALM_SIGN = { Right: -1, Left: 1 };

// Доля поворота кисти вокруг оси предплечья, которую делает само предплечье
const TWIST_SHARE = 0.6;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

const worldPos = (obj, out = new THREE.Vector3()) => obj.getWorldPosition(out);

/** Повернуть кость так, чтобы её мировой поворот стал равен q. */
function setWorldQuaternion(bone, q) {
  bone.parent.getWorldQuaternion(_q1);
  bone.quaternion.copy(_q1.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

/** Повернуть кость так, чтобы направление «кость → child» смотрело на точку target. */
function aim(bone, child, target) {
  bone.updateMatrixWorld(true);
  const origin = worldPos(bone, _v1);
  const from = worldPos(child, _v2).sub(origin).normalize();
  const to = _v3.copy(target).sub(origin);
  if (to.lengthSq() < 1e-10) return;
  to.normalize();
  _q2.setFromUnitVectors(from, to);
  bone.getWorldQuaternion(_q1);
  setWorldQuaternion(bone, _q2.multiply(_q1));
}

/** Направление кости к следующему суставу пальца (или к первому дочернему суставу), мировое. */
function boneDir(bone) {
  bone.updateMatrixWorld(true);
  const child = bone.userData.next ?? bone.children.find((c) => c.isBone);
  return worldPos(child, new THREE.Vector3()).sub(worldPos(bone, new THREE.Vector3())).normalize();
}

/** Повернуть кость вокруг мировой оси на угол (с дочерними суставами). */
function rotateWorld(bone, axis, angle) {
  if (!angle) return;
  _q2.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_q1);
  setWorldQuaternion(bone, _q2.clone().multiply(_q1));
}

/** Ортонормированный базис (вперёд, вбок, нормаль) → матрица поворота. */
function basis(forward, side, out) {
  const f = forward.clone().normalize();
  const n = new THREE.Vector3().crossVectors(f, side).normalize();
  const s = new THREE.Vector3().crossVectors(n, f).normalize();
  return out.makeBasis(f, s, n);
}

export class AvatarRig {
  /** @param {THREE.Object3D} model загруженная модель с костями */
  constructor(model) {
    this.model = model;
    this.bones = {};
    model.traverse((o) => {
      // Кончики пальцев (…Index4) у аватаров Rocketbox — не кости скелета, а пустые точки
      if (o.isBone || /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)4$/.test(o.name)) this.bones[o.name] = o;
    });
    model.updateMatrixWorld(true);

    // Исходные (покоящиеся) повороты — каждый кадр решаем заново от них
    this.rest = new Map();
    for (const bone of Object.values(this.bones)) this.rest.set(bone, bone.quaternion.clone());

    this.smoothing = 0.35; // 0..1: меньше — плавнее, больше — точнее
    this.sides = {};
    for (const side of ['Left', 'Right']) {
      const b = (name) => this.bones[`${side}${name}`];
      const arm = b('Arm');
      const fore = b('ForeArm');
      const hand = b('Hand');
      this.sides[side] = {
        arm,
        fore,
        hand,
        upperLen: worldPos(arm).distanceTo(worldPos(fore)),
        foreLen: worldPos(fore).distanceTo(worldPos(hand)),
        palmLen: worldPos(hand).distanceTo(worldPos(b('HandMiddle1'))),
        fingers: Object.fromEntries(
          Object.keys(FINGERS).map((f) => {
            const chain = [1, 2, 3, 4].map((i) => b(`Hand${f}${i}`));
            chain.slice(0, 3).forEach((bone, i) => (bone.userData.next = chain[i + 1]));
            return [f, chain];
          }),
        ),
        // Плавность: предыдущие решённые повороты костей
        smooth: new Map(),
      };
    }

    // Опорные точки тела: плечи и «центр кадра записи» — чуть ниже плеч
    // (на видео Slovo, снятых телефоном, в центре кадра обычно верх груди)
    const shoulderL = worldPos(this.sides.Left.arm);
    const shoulderR = worldPos(this.sides.Right.arm);
    this.chest = shoulderL.clone().add(shoulderR).multiplyScalar(0.5);
    this.chest.y -= 0.05;
    this.shoulderWidth = shoulderL.distanceTo(shoulderR);
  }

  /** Вернуть руки в исходное положение (перед решением нового кадра). */
  resetArms() {
    for (const side of Object.values(this.sides)) {
      for (const bone of [side.arm, side.fore, side.hand, ...Object.values(side.fingers).flat()]) {
        bone.quaternion.copy(this.rest.get(bone));
      }
    }
    this.model.updateMatrixWorld(true);
  }

  /**
   * Поставить руку по точкам.
   * @param {'Left'|'Right'} sideName
   * @param {THREE.Vector3[]|null} points 21 точка в мировых координатах (null — рука опущена)
   */
  solveHand(sideName, points) {
    const side = this.sides[sideName];
    const target = points ? points[0] : this.restWristTarget(sideName);
    this.solveArm(side, sideName, target);
    if (points) {
      this.orientHand(side, points);
      this.solveFingers(side, sideName, points);
    } else {
      this.relaxHand(side);
    }
    this.applySmoothing(side);
  }

  /** Где кисть в спокойной позе: рука опущена вдоль тела, чуть согнута в локте. */
  restWristTarget(sideName) {
    const side = this.sides[sideName];
    const shoulder = worldPos(side.arm);
    const sign = sideName === 'Right' ? -1 : 1;
    const reach = (side.upperLen + side.foreLen) * 0.96;
    return new THREE.Vector3(shoulder.x + sign * 0.07, shoulder.y - reach, shoulder.z + 0.07);
  }

  /** Двухзвенная обратная кинематика: плечо → локоть → запястье. */
  solveArm(side, sideName, target) {
    const shoulder = worldPos(side.arm);
    const { upperLen: a, foreLen: b } = side;
    const toTarget = target.clone().sub(shoulder);
    // Не дальше длины руки и не «внутрь плеча»
    const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    const dir = toTarget.normalize();
    const wrist = shoulder.clone().addScaledVector(dir, d);

    // Локоть смотрит вниз, немного наружу и назад
    const outward = sideName === 'Right' ? -1 : 1;
    const pole = new THREE.Vector3(outward * 0.45, -1, -0.35).normalize();
    const along = (a * a - b * b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(a * a - along * along, 0));
    const bend = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const elbow = shoulder.clone().addScaledVector(dir, along).addScaledVector(bend, h);

    aim(side.arm, side.fore, elbow);
    aim(side.fore, side.hand, wrist);
  }

  /** Повернуть кисть, чтобы ладонь совпала с записью. */
  orientHand(side, p) {
    side.hand.updateMatrixWorld(true);
    const f = side.fingers;
    const handPos = worldPos(side.hand);
    const restForward = worldPos(f.Middle[0]).sub(handPos);
    const restSide = worldPos(f.Index[0]).sub(worldPos(f.Pinky[0]));
    const targetForward = p[9].clone().sub(p[0]);
    const targetSide = p[5].clone().sub(p[17]);
    if (targetForward.lengthSq() < 1e-8 || targetSide.lengthSq() < 1e-8) return;

    basis(restForward, restSide, _m1);
    basis(targetForward, targetSide, _m2);
    const delta = new THREE.Quaternion().setFromRotationMatrix(_m2.multiply(_m1.transpose()));
    side.hand.getWorldQuaternion(_q2);
    const target = delta.multiply(_q2);
    this.shareTwist(side, target);
    setWorldQuaternion(side.hand, target);
  }

  /**
   * Поворот кисти вокруг оси предплечья у человека делают кости предплечья, а не запястье.
   * Если крутить только кисть, кожа на запястье «перекручивается фантиком».
   * Поэтому часть поворота (TWIST_SHARE) отдаём предплечью — его вращение вокруг своей оси
   * не сдвигает запястье.
   */
  shareTwist(side, handWorld) {
    const fore = side.fore;
    const axis = boneDir(fore);
    const foreWorld = fore.getWorldQuaternion(new THREE.Quaternion());
    // Поворот кисти относительно предплечья сверх исходной позы — в системе предплечья
    const local = foreWorld.clone().invert().multiply(handWorld);
    const rel = local.multiply(this.rest.get(side.hand).clone().invert());
    const axisLocal = axis.clone().applyQuaternion(foreWorld.clone().invert());
    const proj = new THREE.Vector3(rel.x, rel.y, rel.z).dot(axisLocal);
    let twist = 2 * Math.atan2(proj, rel.w);
    if (twist > Math.PI) twist -= 2 * Math.PI;
    if (twist < -Math.PI) twist += 2 * Math.PI;
    rotateWorld(fore, axis, twist * TWIST_SHARE);
  }

  /** Направление «внутрь ладони» (куда сгибаются пальцы) для кисти аватара, в мировых координатах. */
  palmInward(side, sideName) {
    side.hand.updateMatrixWorld(true);
    const f = side.fingers;
    const forward = worldPos(f.Middle[0]).sub(worldPos(side.hand));
    const across = worldPos(f.Index[0]).sub(worldPos(f.Pinky[0]));
    return new THREE.Vector3().crossVectors(forward, across).normalize().multiplyScalar(PALM_SIGN[sideName]);
  }

  /**
   * Пальцы по углам сгиба. Направление каждой фаланги с видео шумное (особенно глубина),
   * а угол между соседними отрезками — устойчивый. Поэтому для каждого сустава берём угол
   * сгиба и сгибаем палец аватара только к ладони, в пределах, как у живой руки.
   */
  solveFingers(side, sideName, p) {
    const inward = this.palmInward(side, sideName);
    // Ладонь на записи: та же формула, что и для аватара (руки одной стороны)
    const tForward = p[9].clone().sub(p[0]);
    const tAcross = p[5].clone().sub(p[17]);
    const tInward = new THREE.Vector3().crossVectors(tForward, tAcross).normalize().multiplyScalar(PALM_SIGN[sideName]);
    const across = worldPos(side.fingers.Index[0]).sub(worldPos(side.fingers.Pinky[0])).normalize();

    for (const name of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const [m, pip, dip, tip] = FINGERS[name];
      const meta = p[m].clone().sub(p[0]).normalize();
      const s1 = p[pip].clone().sub(p[m]).normalize();
      const s2 = p[dip].clone().sub(p[pip]).normalize();
      const s3 = p[tip].clone().sub(p[dip]).normalize();

      const curl = this.debugCurl;
      // Сильный «сгиб назад» живой палец не делает — это ошибка глубины, когда кисть видна с ребра
      // (палец сложен почти вдвое, но знак угла перепутан). Считаем такой сгиб сгибом в ладонь.
      let rawMcp = Math.atan2(s1.dot(tInward), s1.dot(meta));
      if (rawMcp < -0.6) rawMcp = -rawMcp;
      const flexMcp = curl ?? clamp(rawMcp, LIMITS.mcp);
      const flexPip = curl ?? clamp(Math.acos(clamp(s1.dot(s2), [-1, 1])), LIMITS.pip);
      // Средний и концевой суставы у человека сгибаются вместе (~2:3) — это гасит шум
      const rawDip = clamp(Math.acos(clamp(s2.dot(s3), [-1, 1])), LIMITS.dip);
      const flexDip = curl ?? 0.5 * rawDip + 0.5 * 0.67 * flexPip;
      // Развод пальцев в плоскости ладони — относительно направления пястной кости
      // (естественный «веер» пальцев у модели уже есть, его не удваиваем)
      const inPalm = (v) => v.clone().addScaledVector(tInward, -v.dot(tInward)).normalize();
      const acrossN = tAcross.clone().normalize();
      const spread =
        curl != null ? 0 : clamp(Math.asin(clamp(inPalm(s1).dot(acrossN), [-1, 1])) - Math.asin(clamp(inPalm(meta).dot(acrossN), [-1, 1])), LIMITS.spread);

      const [b1, b2, b3] = side.fingers[name];
      // Развод: поворот вокруг нормали ладони
      rotateWorld(b1, inward, spread * Math.sign(new THREE.Vector3().crossVectors(inward, boneDir(b1)).dot(across) || 1));
      // Сгиб: три сустава — петли с общей осью, поперечной пальцу
      const axis = new THREE.Vector3().crossVectors(boneDir(b1), inward).normalize();
      rotateWorld(b1, axis, flexMcp);
      rotateWorld(b2, axis, flexPip);
      rotateWorld(b3, axis, flexDip);
    }
    this.solveThumb(side, p);
  }

  /**
   * Большой палец: каждая фаланга — вдоль своего отрезка на записи. Он толстый и виден
   * отдельно от остальных пальцев, поэтому его точки надёжные. Сгиб ограничен, как у человека.
   */
  solveThumb(side, p) {
    const [t1, t2, t3, t4] = side.fingers.Thumb;
    if (this.debugCurl != null) {
      const palmCenter = worldPos(side.fingers.Middle[0]).add(worldPos(side.hand)).multiplyScalar(0.5);
      for (const bone of [t2, t3]) {
        const d = boneDir(bone);
        const toPalm = palmCenter.clone().sub(worldPos(bone));
        toPalm.addScaledVector(d, -toPalm.dot(d)).normalize();
        rotateWorld(bone, new THREE.Vector3().crossVectors(d, toPalm).normalize(), this.debugCurl);
      }
      return;
    }
    const seg = (i) => p[i + 1].clone().sub(p[i]).normalize();
    const a = seg(1);
    aim(t1, t2, worldPos(t1).add(a));
    // Каждый следующий отрезок отклоняем от предыдущего не больше предела сустава
    let prev = a;
    for (const [bone, child, i, limit] of [
      [t2, t3, 2, LIMITS.thumbMcp[1]],
      [t3, t4, 3, LIMITS.thumbIp[1]],
    ]) {
      let dir = seg(i);
      const angle = Math.acos(clamp(prev.dot(dir), [-1, 1]));
      if (angle > limit) dir = prev.clone().lerp(dir, limit / angle).normalize();
      aim(bone, child, worldPos(bone).add(dir));
      prev = dir;
    }
  }

  /** Спокойная кисть: пальцы слегка согнуты. */
  relaxHand(side) {
    for (const bones of Object.values(side.fingers)) {
      for (let j = 0; j < 3; j++) bones[j].quaternion.copy(this.rest.get(bones[j]));
    }
  }

  /** Сглаживание во времени: убирает дрожание записи и делает переходы между жестами плавными. */
  applySmoothing(side) {
    const all = [side.arm, side.fore, side.hand, ...Object.values(side.fingers).flat()];
    for (const bone of all) {
      const solved = bone.quaternion.clone();
      const prev = side.smooth.get(bone);
      if (prev) solved.copy(prev.slerp(solved, this.smoothing));
      side.smooth.set(bone, solved.clone());
      bone.quaternion.copy(solved);
    }
    this.model.updateMatrixWorld(true);
  }
}
