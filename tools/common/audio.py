"""오디오 입출력 — ffmpeg로 디코딩해서 mp3/m4a/wav를 모두 같은 경로로 읽는다."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np


def load_audio(path: str | Path, sr: int = 22050, mono: bool = True,
               start: float | None = None, end: float | None = None) -> tuple[np.ndarray, int]:
    """파일을 float32 배열로 읽는다. 구간(start~end 초)을 주면 그 부분만."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if end is not None:
        cmd += ["-t", f"{end - (start or 0):.3f}"]
    cmd += ["-vn", "-ac", "1" if mono else "2", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    y = np.frombuffer(raw, dtype=np.float32)
    if not mono:
        y = y.reshape(-1, 2).T
    return y, sr


def duration_of(path: str | Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def write_wav(path: str | Path, y: np.ndarray, sr: int) -> None:
    import soundfile as sf
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 2 and y.shape[0] in (1, 2):   # (channels, n) → (n, channels)
        y = y.T
    sf.write(str(path), y, sr)
