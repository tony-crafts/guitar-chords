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


def measure_lag(ref: np.ndarray, other: np.ndarray, sr: int, max_ms: float = 80.0,
                window_s: float = 8.0) -> tuple[float, float]:
    """other가 ref보다 몇 초 늦는지(양수 = 늦음)와 상관계수. 구간 3곳의 중앙값."""
    L = int(window_s * sr)
    maxlag = int(max_ms / 1000 * sr)
    n = min(len(ref), len(other))
    if n < L + 2 * maxlag + 1:
        L = max(sr, n - 2 * maxlag - 1)
    lags, cors = [], []
    for frac in (0.15, 0.5, 0.85):
        s = int(n * frac) - L // 2
        s = max(maxlag, min(s, n - L - maxlag - 1))
        x = ref[s:s + L]
        if np.abs(x).max() < 1e-4:
            continue
        best = max(range(-maxlag, maxlag + 1), key=lambda k: np.dot(x, other[s + k:s + k + L]))
        c = np.corrcoef(x, other[s + best:s + best + L])[0, 1]
        lags.append(best); cors.append(c)
    if not lags:
        return 0.0, 0.0
    return float(np.median(lags)) / sr, float(np.median(cors))


def shift_audio(y: np.ndarray, lag_s: float, sr: int) -> np.ndarray:
    """lag_s만큼 앞당긴다(양수 = 앞을 잘라냄, 음수 = 앞에 무음 추가). 길이는 유지."""
    k = int(round(lag_s * sr))
    if k > 0:
        return np.concatenate([y[k:], np.zeros(k, dtype=y.dtype)])
    if k < 0:
        return np.concatenate([np.zeros(-k, dtype=y.dtype), y[:k]])
    return y
