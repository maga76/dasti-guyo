"""Экспорт полносвязной сети scikit-learn (MLPClassifier) в формат TensorFlow.js.

Зачем без TensorFlow: он весит сотни мегабайт и капризен на Windows. Сеть из
нескольких Dense-слоёв легко описать вручную в формате «layers-model»,
и браузер загрузит её обычным tf.loadLayersModel('.../model.json').

Результат: model.json (архитектура + список весов) и weights.bin (float32, little-endian).
"""

import json
from pathlib import Path

import numpy as np
from sklearn.neural_network import MLPClassifier

_ACTIVATIONS = {"relu": "relu", "tanh": "tanh", "logistic": "sigmoid", "identity": "linear"}


def _dense_config(name: str, units: int, activation: str, input_size: int | None) -> dict:
    config = {
        "name": name,
        "trainable": True,
        "dtype": "float32",
        "units": units,
        "activation": activation,
        "use_bias": True,
        "kernel_initializer": {"class_name": "Zeros", "config": {}},
        "bias_initializer": {"class_name": "Zeros", "config": {}},
        "kernel_regularizer": None,
        "bias_regularizer": None,
        "activity_regularizer": None,
        "kernel_constraint": None,
        "bias_constraint": None,
    }
    if input_size is not None:
        config["batch_input_shape"] = [None, input_size]
    return {"class_name": "Dense", "config": config}


def mlp_layers(clf: MLPClassifier) -> list[tuple[np.ndarray, np.ndarray, str]]:
    """Слои сети как (kernel[in, out], bias[out], activation) с softmax на выходе.

    Для двух классов sklearn делает один выход с сигмоидой. Превращаем его
    в два выхода с softmax: softmax([0, z]) = [1 − sigmoid(z), sigmoid(z)].
    """
    hidden_act = _ACTIVATIONS[clf.activation]
    layers = []
    last = len(clf.coefs_) - 1
    for i, (kernel, bias) in enumerate(zip(clf.coefs_, clf.intercepts_)):
        kernel = np.asarray(kernel, dtype=np.float32)
        bias = np.asarray(bias, dtype=np.float32)
        if i == last:
            if clf.out_activation_ == "logistic":
                kernel = np.concatenate([np.zeros_like(kernel), kernel], axis=1)
                bias = np.concatenate([np.zeros_like(bias), bias])
            layers.append((kernel, bias, "softmax"))
        else:
            layers.append((kernel, bias, hidden_act))
    return layers


def export_mlp_to_tfjs(
    clf: MLPClassifier, out_dir: Path, labels: list[str], extra_metadata: dict | None = None
) -> Path:
    """Сохраняет модель и возвращает путь к model.json.

    extra_metadata попадает в userDefinedMetadata (например, формат признаков).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    layers = mlp_layers(clf)

    layer_configs = []
    weight_specs = []
    blobs = []
    for i, (kernel, bias, activation) in enumerate(layers):
        name = f"dense_{i + 1}"
        layer_configs.append(
            _dense_config(name, kernel.shape[1], activation, kernel.shape[0] if i == 0 else None)
        )
        weight_specs.append({"name": f"{name}/kernel", "shape": list(kernel.shape), "dtype": "float32"})
        weight_specs.append({"name": f"{name}/bias", "shape": list(bias.shape), "dtype": "float32"})
        blobs.append(kernel.astype("<f4").tobytes(order="C"))
        blobs.append(bias.astype("<f4").tobytes(order="C"))

    (out_dir / "weights.bin").write_bytes(b"".join(blobs))

    model_json = {
        "format": "layers-model",
        "generatedBy": "dasti-guyo (scikit-learn MLP)",
        "convertedBy": None,
        "modelTopology": {
            "class_name": "Sequential",
            "config": {"name": "dasti_guyo", "layers": layer_configs},
            "keras_version": "2.15.0",
            "backend": "tensorflow",
        },
        "weightsManifest": [{"paths": ["weights.bin"], "weights": weight_specs}],
        "userDefinedMetadata": {"labels": labels, **(extra_metadata or {})},
    }
    path = out_dir / "model.json"
    path.write_text(json.dumps(model_json, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def load_tfjs_dense(model_dir: Path) -> list[tuple[np.ndarray, np.ndarray, str]]:
    """Читает экспортированную модель обратно (для тестов и проверки)."""
    meta = json.loads((model_dir / "model.json").read_text(encoding="utf-8"))
    data = (model_dir / "weights.bin").read_bytes()
    arrays, offset = [], 0
    for spec in meta["weightsManifest"][0]["weights"]:
        count = int(np.prod(spec["shape"]))
        arr = np.frombuffer(data, dtype="<f4", count=count, offset=offset).reshape(spec["shape"])
        arrays.append(arr)
        offset += count * 4
    acts = [layer["config"]["activation"] for layer in meta["modelTopology"]["config"]["layers"]]
    return [(arrays[2 * i], arrays[2 * i + 1], act) for i, act in enumerate(acts)]


def predict_with_layers(layers, x: np.ndarray) -> np.ndarray:
    """Прямой проход сети на numpy — так же, как это сделает TensorFlow.js."""
    for kernel, bias, act in layers:
        x = x @ kernel + bias
        if act == "relu":
            x = np.maximum(x, 0)
        elif act == "tanh":
            x = np.tanh(x)
        elif act == "sigmoid":
            x = 1 / (1 + np.exp(-x))
        elif act == "softmax":
            x = np.exp(x - x.max(axis=1, keepdims=True))
            x = x / x.sum(axis=1, keepdims=True)
    return x
