// 3D-сцена с аватаром-переводчиком (Three.js).
//
// Модели — см. AVATARS ниже. Свет — студийный: тёплый основной, холодный заполняющий и золотой контровой.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AvatarRig } from './rig.js';
import { SignPlayer } from './signPlayer.js';
import { assetUrls, download } from '../net/download.js';

// Аватары. male / female — Microsoft Rocketbox (MIT): реалистичные люди с полным скелетом кистей
// (у каждого пальца три сустава), сконвертированы инструментом tools/rocketbox.html.
// Прежний «классический» аватар Ready Player Me убран из выбора (по просьбе); у кого он был
// сохранён, avatarView.js сам переключает на первого из списка.
export const AVATARS = {
  male: { file: 'male.glb' },
  female: { file: 'female.glb' },
};
export const DEFAULT_AVATAR = 'male';
// Ось, вокруг которой открывается рот (поперёк лица; аватар смотрит на +Z)
const JAW_AXIS = new THREE.Vector3(1, 0, 0);

export class AvatarStage {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.active = false;
    this.ready = false;
    this.timer = new THREE.Timer();
    this.mouth = { open: 0, target: 0, timer: 0 };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    this.scene = scene;

    scene.add(new THREE.HemisphereLight('#dfe7ff', '#2a2235', 0.55));
    const key = new THREE.DirectionalLight('#fff1dc', 2.4);
    key.position.set(1.4, 2.6, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    Object.assign(key.shadow.camera, { left: -1, right: 1, top: 2.2, bottom: 0, near: 0.5, far: 8 });
    scene.add(key);
    const fill = new THREE.DirectionalLight('#9bb7ff', 0.7);
    fill.position.set(-2.2, 1.6, 1.4);
    scene.add(fill);
    const rim = new THREE.DirectionalLight('#f2b233', 2.2);
    rim.position.set(-1.2, 2.2, -2.4);
    scene.add(rim);
    const rim2 = new THREE.DirectionalLight('#7aa7ff', 1.2);
    rim2.position.set(1.6, 1.8, -2.2);
    scene.add(rim2);

    this.camera = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Загрузить модель (или сменить её). onProgress(0..1). */
  async load(onProgress, avatarId = DEFAULT_AVATAR) {
    const avatar = AVATARS[avatarId] ?? AVATARS[DEFAULT_AVATAR];
    const buffer = await download(assetUrls(`avatar/${avatar.file}`), {
      onProgress: (p) => p != null && onProgress?.(p / 100),
    });
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const model = gltf.scene;
    const faces = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      if (avatar.hide?.includes(o.name)) o.visible = false;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // руки двигаются — не прятать «вылетевшие» за рамку части
      const tint = avatar.tint?.[o.name];
      if (tint) {
        o.material = o.material.clone();
        o.material.color.set(tint);
      }
      if (o.morphTargetDictionary) faces.push(o);
    });
    // Смена аватара: прежняя модель уходит со сцены, проигрывание начинается заново
    if (this.model) {
      this.player?.stop();
      this.scene.remove(this.model);
    }
    this.avatarId = avatarId in AVATARS ? avatarId : DEFAULT_AVATAR;
    this.faces = faces;
    this.scene.add(model);
    this.model = model;
    this.rig = new AvatarRig(model);
    this.player = new SignPlayer(this.rig);
    this.spine = this.rig.bones.Spine2;
    this.head = this.rig.bones.Head;
    this.jaw = this.rig.bones.Jaw;
    this.spineRest = this.spine?.quaternion.clone();
    this.headRest = this.head?.quaternion.clone();
    this.jawRest = this.jaw?.quaternion.clone();
    this.frameCamera();
    this.ready = true;
    this.renderFrame(0);
  }

  /** Кадр «по пояс»: видно лицо и всё пространство жестов. */
  frameCamera() {
    const chest = this.rig.chest;
    this.lookAt = new THREE.Vector3(chest.x, chest.y + 0.06, chest.z);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.lookAt) {
      // Должно поместиться: по высоте ~0.85 м (макушка … пояс) плюс место под субтитры,
      // по ширине ~0.9 м (пространство жестов). Чем ближе камера, тем крупнее руки.
      // На узком экране субтитрам нужно больше места.
      const captionRoom = this.camera.aspect < 0.9 ? 0.28 : 0.12;
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const distH = (0.85 + captionRoom) / 2 / Math.tan(fov / 2);
      const distW = 0.9 / 2 / Math.tan(fov / 2) / this.camera.aspect;
      const dist = Math.max(distH, distW);
      // Камера смотрит ниже груди — аватар поднимается, внизу остаётся место для текста
      const target = this.lookAt.clone();
      target.y -= captionRoom / 2;
      this.camera.position.set(target.x, target.y + 0.08, target.z + dist);
      this.camera.lookAt(target);
    }
    this.camera.updateProjectionMatrix();
    if (this.ready && !this.active) this.renderFrame(0);
  }

  setActive(active) {
    this.active = active;
    if (active && !this.loop) {
      this.timer.update();
      const tick = (now) => {
        if (!this.active) {
          this.loop = null;
          return;
        }
        this.loop = requestAnimationFrame(tick);
        this.timer.update(now);
        this.renderFrame(Math.min(this.timer.getDelta(), 0.05));
      };
      this.loop = requestAnimationFrame(tick);
    }
  }

  setSpeed(speed) {
    if (this.player) this.player.speed = speed;
  }

  /** Показать последовательность жестов. */
  play(items, handlers) {
    this.player?.play(items, handlers);
  }

  stop() {
    this.player?.stop();
  }

  renderFrame(dt) {
    if (!this.ready) return;
    const t = this.timer.getElapsed();
    const pose = this.player.update(dt);

    // Дыхание и лёгкие движения головы — чтобы аватар не выглядел манекеном
    if (this.spine) {
      this.spine.quaternion.copy(this.spineRest);
      this.spine.rotateX(Math.sin(t * 1.6) * 0.012);
    }
    if (this.head) {
      this.head.quaternion.copy(this.headRest);
      this.head.rotateY(Math.sin(t * 0.37) * 0.04);
      this.head.rotateX(Math.sin(t * 0.53) * 0.02 + (pose.signing ? 0.03 : 0));
    }

    this.rig.resetArms();
    this.rig.solveHand('Right', pose.Right);
    this.rig.solveHand('Left', pose.Left);
    this.onPose?.(pose); // для схемы рук рядом с аватаром
    this.animateFace(dt, pose.signing);
    this.renderer.render(this.scene, this.camera);
  }

  /** Лёгкая улыбка; во время жестов губы двигаются, как у переводчика, проговаривающего слова. */
  animateFace(dt, signing) {
    const m = this.mouth;
    m.timer -= dt;
    if (m.timer <= 0) {
      m.target = signing ? Math.random() * 0.35 : 0;
      m.timer = 0.09 + Math.random() * 0.12;
    }
    m.open += (m.target - m.open) * Math.min(1, dt * 14);
    // У аватаров Rocketbox нет мимики-«морфов», зато есть кость челюсти: приоткрываем рот ею
    if (this.jaw) {
      const parent = this.jaw.parent.getWorldQuaternion(new THREE.Quaternion());
      const open = new THREE.Quaternion().setFromAxisAngle(JAW_AXIS, m.open * 0.22);
      this.jaw.quaternion.copy(parent.clone().invert().multiply(open).multiply(parent).multiply(this.jawRest));
    }
    for (const mesh of this.faces ?? []) {
      const dict = mesh.morphTargetDictionary;
      if (dict.mouthOpen !== undefined) mesh.morphTargetInfluences[dict.mouthOpen] = m.open;
      if (dict.mouthSmile !== undefined) mesh.morphTargetInfluences[dict.mouthSmile] = signing ? 0.15 : 0.32;
    }
  }
}
