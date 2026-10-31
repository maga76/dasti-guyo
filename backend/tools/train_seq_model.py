"""Новая нейросеть распознавания жестов (эксперимент): 1D-свёртки + Transformer по кадрам.

Идея — как у решения, занявшего 1-е место в соревновании Google «Isolated Sign Language
Recognition» на Kaggle (hoyso48, лицензия MIT): модель смотрит на последовательность кадров
точек рук; свёртки по времени ловят короткие движения пальцев, внимание (Transformer) —
жест целиком. Наша версия маленькая, чтобы в браузере считалась за миллисекунды.

Данные, признаки кадра и честная проверка — те же, что у build_slovo_base.py (MLP):
учимся на людях из train, проверяем на других людях (test), «не наш жест» — записи других слов.

Сохраняет для сайта:
  frontend/public/models/seq/model.json — устройство сети, слова, метрики
  frontend/public/models/seq/weights.bin — веса (float32 подряд, порядок — в model.json)
  frontend/public/models/seq/check.json — несколько записей и ответы PyTorch (самопроверка браузера)

Запуск из папки backend:
    $env:PYTHONPATH = "."; .venv\\Scripts\\python tools\\train_seq_model.py
"""

import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_slovo_base as base  # noqa: E402
from app.services.features import FRAME, LIMIT, SLOT, augment, resample  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "models" / "seq"

SEQ = 24  # кадров на входе
FEATURES = FRAME * 2  # кадр + его изменение относительно прошлого (скорость)
DIM = 96
HEADS = 4
KERNEL = 15
LAYERS = ["conv", "conv", "attn", "conv", "conv"]
EPOCHS = 60
AUG_COPIES = 4
NONE_PER_EPOCH = 60
BATCH = 64
LR = 2e-3
SEED = 0


# ---------- Признаки (ДОЛЖНЫ совпадать с frontend/src/model/seqModel.js → seqInput) ----------


def seq_input(frames) -> np.ndarray:
    """Кадры записи (n × 132) → вход сети (SEQ × 264): нормализованные кадры и их скорость."""
    seq = resample(np.asarray(frames, dtype=np.float32), SEQ).copy()
    present = seq[:, 65] > 0
    if present.any():
        ref_x, ref_y, scale = seq[present, 63].mean(), seq[present, 64].mean(), seq[present, 65].mean()
    else:
        ref_x, ref_y, scale = 0.0, 0.0, 1.0
    scale = scale or 1.0
    for s in (0, 1):
        b = s * SLOT
        has = seq[:, b + 65] > 0
        seq[has, b + 63] = (seq[has, b + 63] - ref_x) / scale
        seq[has, b + 64] = (seq[has, b + 64] - ref_y) / scale
        seq[has, b + 65] = seq[has, b + 65] / scale
    seq = np.clip(seq, -LIMIT, LIMIT)
    # Скорость: разница с прошлым кадром; где руки нет в одном из кадров — ноль
    delta = np.zeros_like(seq)
    delta[1:] = seq[1:] - seq[:-1]
    for s in (0, 1):
        b = s * SLOT
        both = (seq[1:, b + 65] > 0) & (seq[:-1, b + 65] > 0)
        delta[1:, b : b + SLOT][~both] = 0
    return np.concatenate([seq, delta], axis=1).astype(np.float32)


# ---------- Сеть (каждый слой — так, чтобы его легко было повторить в JS) ----------


class ConvBlock(nn.Module):
    """LayerNorm → расширение ×2 + SiLU → свёртка по времени (у каждого канала своя) + SiLU → сужение."""

    def __init__(self, dim, kernel=KERNEL, expand=2, drop=0.2):
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.expand = nn.Linear(dim, dim * expand)
        self.dw = nn.Conv1d(dim * expand, dim * expand, kernel, padding=kernel // 2, groups=dim * expand)
        self.project = nn.Linear(dim * expand, dim)
        self.drop = nn.Dropout(drop)

    def forward(self, x):
        h = F.silu(self.expand(self.norm(x)))
        h = F.silu(self.dw(h.transpose(1, 2)).transpose(1, 2))
        return x + self.drop(self.project(h))


class AttnBlock(nn.Module):
    """LayerNorm → внимание (HEADS голов) → LayerNorm → MLP ×2 с SiLU."""

    def __init__(self, dim, heads=HEADS, drop=0.2):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(dim)
        self.qkv = nn.Linear(dim, dim * 3)
        self.out = nn.Linear(dim, dim)
        self.norm2 = nn.LayerNorm(dim)
        self.mlp1 = nn.Linear(dim, dim * 2)
        self.mlp2 = nn.Linear(dim * 2, dim)
        self.drop = nn.Dropout(drop)

    def forward(self, x):
        b, t, d = x.shape
        q, k, v = self.qkv(self.norm1(x)).reshape(b, t, 3, self.heads, d // self.heads).permute(2, 0, 3, 1, 4)
        att = torch.softmax(q @ k.transpose(-1, -2) / math.sqrt(d // self.heads), dim=-1)
        h = (att @ v).transpose(1, 2).reshape(b, t, d)
        x = x + self.drop(self.out(h))
        return x + self.drop(self.mlp2(F.silu(self.mlp1(self.norm2(x)))))


class SeqNet(nn.Module):
    def __init__(self, classes):
        super().__init__()
        self.stem = nn.Linear(FEATURES, DIM)
        self.blocks = nn.ModuleList([ConvBlock(DIM) if kind == "conv" else AttnBlock(DIM) for kind in LAYERS])
        self.norm = nn.LayerNorm(DIM)
        self.drop = nn.Dropout(0.3)
        self.head = nn.Linear(DIM, classes)

    def forward(self, x):
        x = self.stem(x)
        for block in self.blocks:
            x = block(x)
        return self.head(self.drop(self.norm(x).mean(1)))


# ---------- Обучение и проверка ----------


def batches(words, others, rng):
    """Записи одной эпохи — как у MLP: слова с AUG_COPIES случайными копиями + часть «не наш жест»."""
    xs, ys = [], []
    for s in words:
        xs.append(seq_input(s["frames"]))
        ys.append(s["label"])
        for _ in range(AUG_COPIES):
            xs.append(seq_input(augment(s["frames"], rng)))
            ys.append(s["label"])
    if others:
        for i in rng.choice(len(others), size=min(NONE_PER_EPOCH, len(others)), replace=False):
            frames = others[i]["frames"]
            xs.append(seq_input(augment(frames, rng) if rng.random() < 0.5 else frames))
            ys.append(others[i]["label"])
    x = torch.from_numpy(np.stack(xs))
    y = torch.from_numpy(np.asarray(ys, dtype=np.int64))
    order = torch.from_numpy(rng.permutation(len(x)))
    return x[order], y[order]


def probabilities(model, samples):
    model.eval()
    with torch.no_grad():
        x = torch.from_numpy(np.stack([seq_input(s["frames"]) for s in samples]))
        return torch.softmax(model(x), dim=-1).numpy()


def train(samples, classes, rng, test=None):
    torch.manual_seed(SEED)
    model = SeqNet(classes)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.05)
    words = [s for s in samples if s["role"] == "word"]
    others = [s for s in samples if s["role"] != "word"]
    steps_per_epoch = math.ceil((len(words) * (AUG_COPIES + 1) + NONE_PER_EPOCH) / BATCH)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=EPOCHS * steps_per_epoch + 10, pct_start=0.1)
    curve = []
    y_test = np.asarray([s["label"] for s in test]) if test else None
    for epoch in range(1, EPOCHS + 1):
        model.train()
        x, y = batches(words, others, rng)
        for i in range(0, len(x), BATCH):
            loss = F.cross_entropy(model(x[i : i + BATCH]), y[i : i + BATCH], label_smoothing=0.1)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        point = {"epoch": epoch}
        if test:
            point["test"] = round(float((probabilities(model, test).argmax(1) == y_test).mean()), 4)
        curve.append(point)
        if epoch % 10 == 0:
            print(f"  эпоха {epoch}: {point}", flush=True)
    return model, curve


def word_stats(model, samples, none_index):
    proba = probabilities(model, samples)
    y = np.asarray([s["label"] for s in samples])
    top, sure = proba.argmax(1), proba.max(1) >= base.ACCEPT
    correct = (top == y) & sure
    wrong = (top != y) & sure & (top != none_index)
    return {
        "accuracy": round(float((top == y).mean()), 4),
        "acceptedCorrect": round(float(correct.mean()), 4),
        "acceptedWrong": round(float(wrong.mean()), 4),
        "missed": round(float(1 - correct.mean() - wrong.mean()), 4),
    }


def false_accept(model, samples, none_index):
    proba = probabilities(model, samples)
    top = proba.argmax(1)
    return {"n": len(samples), "falseAccept": round(float(((top != none_index) & (proba.max(1) >= base.ACCEPT)).mean()), 4)}


# ---------- Сохранение для браузера ----------


def export(model, labels, metrics, check_samples):
    OUT.mkdir(parents=True, exist_ok=True)
    tensors = []

    def add(name, t):
        arr = t.detach().cpu().numpy().astype(np.float32)
        tensors.append({"name": name, "shape": list(arr.shape), "data": arr})

    add("stem.w", model.stem.weight.T)  # [вход × выход] — как в JS
    add("stem.b", model.stem.bias)
    for i, (kind, block) in enumerate(zip(LAYERS, model.blocks)):
        p = f"b{i}."
        if kind == "conv":
            add(p + "norm.g", block.norm.weight), add(p + "norm.b", block.norm.bias)
            add(p + "expand.w", block.expand.weight.T), add(p + "expand.b", block.expand.bias)
            add(p + "dw.w", block.dw.weight[:, 0, :]), add(p + "dw.b", block.dw.bias)  # [канал × ядро]
            add(p + "project.w", block.project.weight.T), add(p + "project.b", block.project.bias)
        else:
            add(p + "norm1.g", block.norm1.weight), add(p + "norm1.b", block.norm1.bias)
            add(p + "qkv.w", block.qkv.weight.T), add(p + "qkv.b", block.qkv.bias)
            add(p + "out.w", block.out.weight.T), add(p + "out.b", block.out.bias)
            add(p + "norm2.g", block.norm2.weight), add(p + "norm2.b", block.norm2.bias)
            add(p + "mlp1.w", block.mlp1.weight.T), add(p + "mlp1.b", block.mlp1.bias)
            add(p + "mlp2.w", block.mlp2.weight.T), add(p + "mlp2.b", block.mlp2.bias)
    add("norm.g", model.norm.weight), add("norm.b", model.norm.bias)
    add("head.w", model.head.weight.T), add("head.b", model.head.bias)

    offset = 0
    index = []
    with open(OUT / "weights.bin", "wb") as f:
        for t in tensors:
            f.write(t["data"].tobytes())
            index.append({"name": t["name"], "shape": t["shape"], "offset": offset})
            offset += t["data"].size
    meta = {
        "format": "dasti-guyo-seq-1",
        "createdAt": datetime.now(UTC).isoformat(),
        "seq": SEQ,
        "features": FEATURES,
        "dim": DIM,
        "heads": HEADS,
        "kernel": KERNEL,
        "layers": LAYERS,
        "labels": labels,
        "tensors": index,
        "metrics": metrics,
    }
    (OUT / "model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    # Самопроверка браузера: те же записи → те же ответы, что у PyTorch
    proba = probabilities(model, check_samples)
    check = [
        {"frames": np.round(s["frames"], 5).tolist(), "probs": np.round(p, 6).tolist()}
        for s, p in zip(check_samples, proba)
    ]
    (OUT / "check.json").write_text(json.dumps(check), encoding="utf-8")


def main():
    rng = np.random.default_rng(42)
    samples, source_labels = base.build_samples(base.load_annotations())
    classes = len(source_labels)
    none_index = source_labels.index(base.NONE_SOURCE)
    words_train = [s for s in samples if s["role"] == "word" and s["train"]]
    words_test = [s for s in samples if s["role"] == "word" and not s["train"]]
    other_train = [s for s in samples if s["role"] == "other" and s["train"]]
    other_test = [s for s in samples if s["role"] == "other" and not s["train"]]
    heldout = [s for s in samples if s["role"] == "heldout"]
    params = sum(p.numel() for p in SeqNet(classes).parameters())
    print(f"Записей: {len(samples)}, классов: {classes}, параметров сети: {params}", flush=True)

    print("Проверочное обучение (люди из test не участвуют)…", flush=True)
    probe, curve = train(words_train + other_train, classes, rng, test=words_test)
    metrics = {
        "testAccuracy": curve[-1]["test"],
        "accept": base.ACCEPT,
        "words": word_stats(probe, words_test, none_index),
        "otherNewPeople": false_accept(probe, other_test, none_index),
        "heldout": false_accept(probe, heldout, none_index),
        "curve": curve,
        "params": params,
    }
    print(f"Точность на новых людях: {metrics['testAccuracy']:.1%}", flush=True)
    print(f"  {json.dumps({k: v for k, v in metrics.items() if k != 'curve'}, ensure_ascii=False)}", flush=True)

    print("Итоговое обучение на всех записях…", flush=True)
    final, _ = train(samples, classes, rng)  # как у MLP: «не наш жест» — все не-слова
    tj_labels = [base.WORDS[l][0] if l in base.WORDS else base.NONE_LABEL for l in source_labels]
    export(final, tj_labels, metrics, words_test[:4])
    print(f"Готово: {OUT}", flush=True)


if __name__ == "__main__":
    main()
