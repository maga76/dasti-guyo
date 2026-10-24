// Конвертер аватаров Microsoft Rocketbox (FBX, лицензия MIT) → GLB для сайта.
//
// Что делает:
//   - сантиметры → метры, аватар смотрит на +Z (как в rig.js);
//   - кости 3ds Max Biped (Bip01_R_Finger21 …) переименовываются в имена Mixamo / Ready Player Me
//     (RightHandMiddle2 …) — rig.js работает с ними без изменений;
//   - на концах пальцев добавляются кости-«кончики» (в Biped их нет, а rig.js по ним
//     определяет направление последней фаланги);
//   - текстуры уменьшаются до 1024 px и сохраняются в JPEG (кроме волос/ресниц — PNG с прозрачностью).
//
// Исходники кладутся в public/_rb/<Имя>/ (FBX + TGA из репозитория Microsoft-Rocketbox),
// затем открыть /tools/rocketbox.html?name=Male_Adult_08 — GLB скачается.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const FINGERS = { 0: 'Thumb', 1: 'Index', 2: 'Middle', 3: 'Ring', 4: 'Pinky' };
const TEXTURE_SIZE = 1024;

/** Имя кости Biped → имя Mixamo (или null — оставить как есть). */
function mixamoName(name) {
  const side = name.match(/^Bip01_([LR])_/);
  if (side) {
    const s = side[1] === 'L' ? 'Left' : 'Right';
    const rest = name.slice(side[0].length);
    const finger = rest.match(/^Finger(\d)(\d?)$/);
    if (finger) return `${s}Hand${FINGERS[finger[1]]}${finger[2] ? Number(finger[2]) + 1 : 1}`;
    const map = { Clavicle: 'Shoulder', UpperArm: 'Arm', Forearm: 'ForeArm', Hand: 'Hand', Thigh: 'UpLeg', Calf: 'Leg', Foot: 'Foot', Toe0: 'ToeBase' };
    return map[rest] ? `${s}${map[rest]}` : null;
  }
  const map = { Bip01_Pelvis: 'Hips', Bip01_Spine: 'Spine', Bip01_Spine1: 'Spine1', Bip01_Spine2: 'Spine2', Bip01_Neck: 'Neck', Bip01_Head: 'Head', Bip01_MJaw: 'Jaw' };
  return map[name] ?? null;
}

async function loadTexture(url, srgb) {
  const tex = await new TGALoader().loadAsync(url);
  // Уменьшаем через canvas: экспортёр всё равно перекодирует картинку
  const src = tex.image;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEXTURE_SIZE;
  const full = document.createElement('canvas');
  full.width = src.width;
  full.height = src.height;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(src.data.buffer), src.width, src.height), 0, 0);
  const ctx = canvas.getContext('2d');
  // TGA хранится снизу вверх — TGALoader уже переворачивает данные, flipY у текстуры glTF = false
  ctx.drawImage(full, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const out = new THREE.CanvasTexture(canvas);
  out.flipY = tex.flipY;
  out.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return out;
}

export async function convert(name) {
  const base = `/_rb/${name}/`;
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  const model = await new FBXLoader(manager).setPath(base).loadAsync(`${name}.fbx`);
  const log = [];

  // Кости: переименовать и добавить кончики пальцев
  const bones = [];
  model.traverse((o) => o.isBone && bones.push(o));
  for (const bone of bones) {
    const renamed = mixamoName(bone.name);
    if (renamed) bone.name = renamed;
  }
  for (const bone of bones) {
    const m = bone.name.match(/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)3$/);
    if (!m) continue;
    // Кончик — продолжение последней фаланги на 80% её длины
    // bone.position — смещение этой фаланги от предыдущей (в системе предыдущей); переводим его
    // в систему этой кости — получаем то же направление «дальше по пальцу»
    const tip = new THREE.Bone();
    tip.name = `${m[1]}Hand${m[2]}4`;
    tip.position.copy(bone.position).applyQuaternion(bone.quaternion.clone().invert()).multiplyScalar(0.8);
    bone.add(tip);
  }

  // Материалы: PBR вместо Phong, текстуры уменьшенные
  const textureFiles = {};
  const meshes = [];
  model.traverse((o) => o.isMesh && meshes.push(o));
  for (const mesh of meshes) {
    const mats = [].concat(mesh.material);
    const fixed = [];
    for (const mat of mats) {
      const prefix = mat.name; // m014_body, m014_head, m014_opacity
      const tex = async (kind, srgb) => {
        const key = `${prefix}_${kind}`;
        textureFiles[key] ??= loadTexture(`${base}${key}.tga`, srgb).catch(() => null);
        return textureFiles[key];
      };
      const opacity = /opacity/.test(prefix);
      const std = new THREE.MeshStandardMaterial({
        name: prefix,
        map: await tex('color', true),
        normalMap: opacity ? null : await tex('normal', false),
        roughness: 0.78,
        metalness: 0,
        alphaTest: opacity ? 0.5 : 0,
        side: opacity ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (std.map) std.map.userData.mimeType = opacity ? 'image/png' : 'image/jpeg';
      if (std.normalMap) std.normalMap.userData.mimeType = 'image/jpeg';
      fixed.push(std);
      log.push(`материал ${prefix}: map=${!!std.map} normal=${!!std.normalMap}`);
    }
    mesh.material = fixed.length === 1 ? fixed[0] : fixed;
  }

  // Масштаб и направление: метры, лицо на +Z
  model.scale.setScalar(0.01);
  model.updateMatrixWorld(true);
  const eyeL = model.getObjectByName('Bip01_LEye');
  const eyeR = model.getObjectByName('Bip01_REye');
  if (eyeL && eyeR) {
    const l = eyeL.getWorldPosition(new THREE.Vector3());
    const r = eyeR.getWorldPosition(new THREE.Vector3());
    // Смотрит на +Z, если левый глаз — со стороны +X
    const across = l.sub(r);
    const angle = Math.atan2(-across.z, across.x);
    model.rotation.y = angle;
    log.push(`поворот ${THREE.MathUtils.radToDeg(angle).toFixed(0)}°`);
  }
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  log.push(`рост ${box.getSize(new THREE.Vector3()).y.toFixed(2)} м`);

  const scene = new THREE.Scene();
  model.name = name;
  scene.add(model);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: TEXTURE_SIZE });
  return { glb, log };
}
