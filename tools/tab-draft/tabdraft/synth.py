"""확인용 재생 파일 — Karplus-Strong(줄을 튕긴 소리 흉내)으로 멜로디를 합성하고 원곡과 섞는다."""
from __future__ import annotations

import numpy as np

from .model import Note


def _pluck(freq: float, dur: float, sr: int, decay: float, rng) -> np.ndarray:
    n = int(dur * sr)
    period = max(2, int(round(sr / freq)))
    buf = rng.uniform(-1, 1, period)
    out = np.empty(n, dtype=np.float32)
    for i in range(n):
        j = i % period
        out[i] = buf[j]
        buf[j] = decay * 0.5 * (buf[j] + buf[(j + 1) % period])
    # 끝에서 뚝 끊기지 않게 짧은 페이드
    fade = min(n, int(0.02 * sr))
    if fade > 0:
        out[-fade:] *= np.linspace(1, 0, fade)
    return out


def synthesize(notes: list[Note], grid, duration: float, sr: int, cfg: dict) -> np.ndarray:
    rng = np.random.default_rng(0)
    y = np.zeros(int(duration * sr) + sr, dtype=np.float32)
    lead = cfg.get("lead_ms", 0) / 1000
    for n in notes:
        t0 = grid.time_of(n.bar, n.t16) - lead
        t1 = grid.time_of_beat(n.bar * grid.beats_per_bar + (n.t16 + n.dur16) / 4) - lead
        dur = max(0.08, t1 - t0) + 0.15                   # 조금 더 울리게
        freq = 440.0 * 2 ** ((n.midi - 69) / 12)
        sig = _pluck(freq, dur, sr, cfg["decay"], rng) * (0.4 + 0.6 * min(1.0, n.conf))
        s = int(t0 * sr)
        if s < 0:
            sig, s = sig[-s:], 0
        e = min(len(y), s + len(sig))
        y[s:e] += sig[: e - s]
    peak = np.max(np.abs(y)) or 1.0
    return (y / peak * cfg["gain"]).astype(np.float32)


def mix(original: np.ndarray, synth: np.ndarray, cfg: dict) -> np.ndarray:
    n = max(len(original), len(synth))
    o = np.zeros(n, dtype=np.float32); o[: len(original)] = original
    s = np.zeros(n, dtype=np.float32); s[: len(synth)] = synth
    o_peak = np.max(np.abs(o)) or 1.0
    m = o / o_peak * cfg["mix_original"] + s * cfg["mix_synth"]
    peak = np.max(np.abs(m)) or 1.0
    return (m / max(1.0, peak)).astype(np.float32)


def check_lag(original: np.ndarray, synth: np.ndarray, sr: int, max_ms: float = 120.0) -> float:
    """합성 음이 원본보다 얼마나 늦게 울리는지(초, 양수 = 늦음) — 온셋 세기 상호상관."""
    import librosa
    hop = 128
    n = min(len(original), len(synth))
    o1 = librosa.onset.onset_strength(y=original[:n].astype(np.float32), sr=sr, hop_length=hop)
    o2 = librosa.onset.onset_strength(y=synth[:n].astype(np.float32), sr=sr, hop_length=hop)
    o1 = o1 - o1.mean(); o2 = o2 - o2.mean()
    K = int(max_ms / 1000 * sr / hop)
    best, best_c = 0, -np.inf
    for k in range(-K, K + 1):
        a = o1[max(0, -k):len(o1) - max(0, k)]; b = o2[max(0, k):len(o2) - max(0, -k)]
        c = float(np.dot(a, b))
        if c > best_c:
            best, best_c = k, c
    return best * hop / sr
