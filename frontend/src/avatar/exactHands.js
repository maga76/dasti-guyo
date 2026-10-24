// Точные кисти для аватара.
//
// Модель — «generic-hand» из стандарта WebXR (@webxr-input-profiles/assets, Amazon, лицензия MIT):
// её делали для отслеживания рук в VR-шлемах. У неё 25 суставов, и все они — отдельные кости
// без вложенности, поэтому каждый сустав можно поставить ровно в точку записи. Никаких
// углов и пределов: форма кисти на экране совпадает с записью MediaPipe 1:1.
//
// Соответствие точек MediaPipe (21) суставам WebXR (25):
//   0 — wrist; 1…4 — большой палец (metacarpal, proximal, distal, tip);
//   у остальных пальцев MediaPipe нет основания пястной кости — ставим его на ту же долю
//   пути «запястье → основание пальца», что и у самой модели.
// Поворот каждого сустава: исходный (из модели) плюс наименьший поворот, переводящий
// кость в новое направление — в системе координат ладони. Так ногти и складки кожи
// поворачиваются вместе с пальцем, а не «перекручиваются».

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { download } from '../net/download.js';

const VERSION = '1.0.20';
const FINGER_JOINTS = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
const FINGERS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

// Все суставы по порядку от запястья: родитель, отрезок записи [от, до], задающий направление
// «родитель → сустав», и следующий сустав (для поворота кости).
// Длина каждого отрезка — от самой модели кисти: у видео ошибается именно длина (кисть видна
// под углом, часть пальцев за краем кадра), а направление надёжное. Так поза — с записи,
// а пропорции — человеческие.
const JOINTS = [
  { name: 'wrist' },
  { name: 'thumb-metacarpal', parent: 'wrist', seg: [0, 1], next: 'thumb-phalanx-proximal' },
  { name: 'thumb-phalanx-proximal', parent: 'thumb-metacarpal', seg: [1, 2], next: 'thumb-phalanx-distal' },
  { name: 'thumb-phalanx-distal', parent: 'thumb-phalanx-proximal', seg: [2, 3], next: 'thumb-tip' },
  { name: 'thumb-tip', parent: 'thumb-phalanx-distal', seg: [3, 4] },
];
for (const [finger, [mcp, pip, dip, tip]] of Object.entries(FINGERS)) {
  const n = (j) => `${finger}-finger-${j}`;
  JOINTS.push(
    // Основание пястной кости лежит на линии «запястье → основание пальца»
    { name: n('metacarpal'), parent: 'wrist', seg: [0, mcp], next: n('phalanx-proximal') },
    { name: n('phalanx-proximal'), parent: n('metacarpal'), seg: [0, mcp], next: n('phalanx-intermediate') },
    { name: n('phalanx-intermediate'), parent: n('phalanx-proximal'), seg: [mcp, pip], next: n('phalanx-distal') },
    { name: n('phalanx-distal'), parent: n('phalanx-intermediate'), seg: [pip, dip], next: n('tip') },
    { name: n('tip'), parent: n('phalanx-distal'), seg: [dip, tip] },
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Базис ладони: «вперёд» — к основанию среднего пальца, «вбок» — от мизинца к указательному. */
function palmBasis(wrist, middle, index, pinky, out) {
  const f = _v.subVectors(middle, wrist).normalize();
  const side = _w.subVectors(index, pinky);
  const n = new THREE.Vector3().crossVectors(f, side).normalize();
  const s = new THREE.Vector3().crossVectors(n, f).normalize();
  return out.makeBasis(f.clone(), s, n);
}

class ExactHand {
  /** @param {THREE.Object3D} scene модель кисти WebXR */
  constructor(scene) {
    this.root = scene;
    scene.updateMatrixWorld(true);
    this.bones = new Map();
    scene.traverse((o) => {
      if (o.isBone) this.bones.set(o.name, o);
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        this.mesh = o;
      }
    });
    const pos = (name) => this.bones.get(name).getWorldPosition(new THREE.Vector3());
    // Исходная поза модели в системе координат её ладони
    const rest = palmBasis(pos('wrist'), pos('middle-finger-phalanx-proximal'), pos('index-finger-phalanx-proximal'), pos('pinky-finger-phalanx-proximal'), new THREE.Matrix4());
    const restInv = new THREE.Quaternion().setFromRotationMatrix(rest).invert();
    this.palmRest = pos('wrist').distanceTo(pos('middle-finger-phalanx-proximal'));
    this.rest = new Map();
    for (const j of JOINTS) {
      const bone = this.bones.get(j.name);
      const q = restInv.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      const dir = j.next ? pos(j.next).sub(pos(j.name)).normalize().applyQuaternion(restInv) : null;
      const len = j.parent ? pos(j.name).distanceTo(pos(j.parent)) : 0;
      this.rest.set(j.name, { q, dir, len });
    }
    this.targets = new Map(JOINTS.map((j) => [j.name, new THREE.Vector3()]));
    this.parents = new Map(JOINTS.map((j) => [j.name, j.parent ?? j.name]));
  }

  parentOf(name) {
    return this.parents.get(name);
  }

  /**
   * Поставить суставы по точкам записи.
   * @param {THREE.Vector3[]} p 21 точка MediaPipe (мировые координаты; важны направления)
   * @param {THREE.Vector3} wrist где должно быть запястье (у руки аватара)
   * @param {number} palmLen длина ладони аватара — под неё масштабируется модель кисти
   */
  pose(p, wrist, palmLen) {
    const k = palmLen / this.palmRest;
    for (const j of JOINTS) {
      const target = this.targets.get(j.name);
      if (!j.parent) {
        target.copy(wrist);
        continue;
      }
      const [a, b] = j.seg;
      const dir = _v.subVectors(p[b], p[a]);
      const len = dir.length();
      // Точки слились (сбой распознавания) — сустав остаётся продолжением родителя
      if (len < 1e-9) dir.copy(this.targets.get(j.parent)).sub(this.targets.get(this.parentOf(j.parent))).normalize();
      else dir.divideScalar(len);
      target.copy(this.targets.get(j.parent)).addScaledVector(dir, this.rest.get(j.name).len * k);
    }
    const T = this.targets;
    const basis = palmBasis(T.get('wrist'), T.get('middle-finger-phalanx-proximal'), T.get('index-finger-phalanx-proximal'), T.get('pinky-finger-phalanx-proximal'), _m);
    const palm = new THREE.Quaternion().setFromRotationMatrix(basis);
    const palmInv = palm.clone().invert();

    let prevQ = null;
    for (const j of JOINTS) {
      const bone = this.bones.get(j.name);
      const rest = this.rest.get(j.name);
      bone.position.copy(T.get(j.name));
      if (rest.dir) {
        // Направление кости сейчас — в системе ладони; поворот «как было → как надо»
        const now = _w.subVectors(T.get(j.next), T.get(j.name));
        if (now.lengthSq() > 1e-12) {
          now.normalize().applyQuaternion(palmInv);
          _swing.setFromUnitVectors(rest.dir, now);
          prevQ = palm.clone().multiply(_swing).multiply(rest.q);
        }
      } else if (j.name === 'wrist') {
        prevQ = palm.clone().multiply(rest.q);
      }
      // У кончика своего направления нет — как у последней фаланги
      if (prevQ) bone.quaternion.copy(prevQ);
    }
    this.root.visible = true;
  }

  hide() {
    this.root.visible = false;
  }
}

/** Загрузить обе кисти (CDN npm → копия на нашем сервере). */
export async function loadExactHands(skinColor) {
  const loader = new GLTFLoader();
  const load = async (side) => {
    const file = `${side}.glb`;
    const buffer = await download([
      `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@${VERSION}/dist/profiles/generic-hand/${file}`,
      `${import.meta.env.BASE_URL}hands/${file}`,
    ]);
    const gltf = await loader.parseAsync(buffer, '');
    const hand = new ExactHand(gltf.scene);
    hand.mesh.material = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.62, metalness: 0 });
    hand.hide();
    return hand;
  };
  const [Left, Right] = await Promise.all([load('left'), load('right')]);
  return { Left, Right };
}
