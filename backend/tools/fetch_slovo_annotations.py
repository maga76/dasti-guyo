"""Достаёт annotations.csv из архива Slovo (16 ГБ), не скачивая архив целиком.

ZIP хранит оглавление в конце файла, а сервер умеет отдавать куски файла (HTTP Range).
Поэтому читаем только оглавление и нужный файл — несколько мегабайт вместо 16 ГБ.

Запуск из папки backend:
    .venv\\Scripts\\python tools\\fetch_slovo_annotations.py
"""

import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/datasets/slovo/slovo.zip"
OUT = Path(__file__).resolve().parents[1] / "data" / "slovo"


class HttpRangeFile(io.RawIOBase):
    """Файл «только для чтения», который читает куски по сети по мере надобности."""

    def __init__(self, url: str):
        self.url = url
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as res:
            self.size = int(res.headers["Content-Length"])
        self.pos = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = base + offset
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.pos + n, self.size) - 1
        for attempt in range(8):
            try:
                req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
                with urllib.request.urlopen(req, timeout=120) as res:
                    data = res.read()
                break
            except OSError as exc:  # нестабильная сеть — пробуем ещё
                print(f"  повтор {attempt + 1}: {exc}", file=sys.stderr)
        else:
            raise OSError("не удалось скачать кусок файла")
        self.pos += len(data)
        return data

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    remote = io.BufferedReader(HttpRangeFile(URL), buffer_size=1 << 20)
    with zipfile.ZipFile(remote) as archive:
        names = [n for n in archive.namelist() if not n.endswith((".mp4", ".webm", ".mov", "/"))]
        print("Не-видео файлы в архиве:", names)
        for name in names:
            if name.lower().endswith((".csv", ".tsv", ".txt", ".pdf", ".md")):
                target = OUT / Path(name).name
                target.write_bytes(archive.read(name))
                print(f"Сохранено: {target} ({target.stat().st_size} байт)")


if __name__ == "__main__":
    main()
