"""스템 게이트 — 믹스에서 뽑은 음이 기타 스템에서 더 세게 울리는지 검사해 반주(피아노·베이스 등) 누출을 걸러낸다.

음마다 [시작, 끝] 구간에서 기본음과 2·3배음 주파수 대역의 에너지를 기타 스템과 나머지 스템(드럼 제외)에서 각각 재고,
비율 r = E기타 / (E기타 + E나머지) 가 기준값보다 낮으면 반주로 본다. 둘 다 거의 무음이면 판단을 보류(유지)한다.
"""
from __future__ import annotations

import numpy as np

from .model import Note

N_FFT, HOP = 4096, 512


def _spec(y: np.ndarray, sr: int):
    import librosa
    S = np.abs(librosa.stft(y.astype(np.float32), n_fft=N_FFT, hop_length=HOP)) ** 2
    return S, librosa.fft_frequencies(sr=sr, n_fft=N_FFT)


def gate_notes(notes: list[Note], guitar: np.ndarray, others: np.ndarray, sr: int,
               ratio_min: float = 0.5, harmonics: int = 3, silence_db: float = -60.0,
               mode: str = "soft") -> tuple[list[Note], dict]:
    """mode='hard': 비율이 기준 미만인 음을 제거. mode='soft': 제거하지 않고 stem_ratio만 기록해
    멜로디 선택(동시에 울리는 음 중 고르기)에서 기타 쪽 음이 이기게 한다(Demucs가 멜로디를 피아노로 보낸 경우에도 안전).
    반환: (남은 음, 통계)."""
    Sg, freqs = _spec(guitar, sr)
    So, _ = _spec(others, sr)
    ref = max(Sg.max(), So.max(), 1e-12)
    kept, dropped, undecided = [], [], 0
    for n in notes:
        f0 = 440.0 * 2 ** ((n.midi - 69) / 12)
        a = int(n.start * sr / HOP); b = max(a + 1, int(n.end * sr / HOP))
        eg = eo = 0.0
        for h in range(1, harmonics + 1):
            lo, hi = f0 * h * 2 ** (-1 / 24), f0 * h * 2 ** (1 / 24)     # ±반음의 절반
            bins = np.where((freqs >= lo) & (freqs <= hi))[0]
            if len(bins) == 0:
                continue
            wgt = 1.0 / h
            eg += wgt * Sg[bins, a:b].sum()
            eo += wgt * So[bins, a:b].sum()
        level_db = 10 * np.log10((eg + eo) / ref / max(1, b - a) + 1e-12)
        if level_db < silence_db:
            n.flags.append("gate_unsure"); undecided += 1
            kept.append(n); continue
        r = eg / (eg + eo + 1e-12)
        n.stem_ratio = round(float(r), 2)
        if mode == "soft" or r >= ratio_min:
            if r < ratio_min:
                n.flags.append("accomp?")
            kept.append(n)
        else:
            n.flags.append("accomp"); dropped.append(n)
    low = sum(1 for n in kept if 0 <= n.stem_ratio < ratio_min)
    stats = {"input": len(notes), "kept": len(kept), "dropped_accomp": len(dropped), "low_ratio_kept": low,
             "unsure": undecided, "ratio_min": ratio_min, "mode": mode}
    return kept, stats
