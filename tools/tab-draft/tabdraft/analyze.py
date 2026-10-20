"""음원 성격 자동 판단 — 단선율/핑거스타일(다성), 일렉(디스토션)/클린/어쿠스틱 추정.

정확한 분류기가 아니라 몇 가지 간단한 수치로 추정한다. 수치를 함께 내보내므로
판단이 이상하면 사람이 바로 잡을 수 있다(--mode, --ghost-ratio 옵션).
"""
from __future__ import annotations

import numpy as np

from .model import Note


def _polyphony_stats(notes: list[Note], chord_window: float = 0.05) -> dict:
    if not notes:
        return {"avg_poly": 0.0, "chord_onset_ratio": 0.0, "n_notes": 0}
    # 동시 발음 수: 10ms 격자에서 활성 음 개수의 평균(활성 구간만)
    end = max(n.end for n in notes)
    grid = np.zeros(int(end / 0.01) + 2)
    for n in notes:
        grid[int(n.start / 0.01):int(n.end / 0.01) + 1] += 1
    active = grid[grid > 0]
    avg_poly = float(active.mean()) if len(active) else 0.0
    # 온셋이 겹치는(코드로 함께 치는) 음의 비율
    starts = np.array(sorted(n.start for n in notes))
    together = 0
    for s in starts:
        together += int(np.sum(np.abs(starts - s) < chord_window) > 1)
    return {"avg_poly": round(avg_poly, 2), "chord_onset_ratio": round(together / len(starts), 2),
            "n_notes": len(notes), "poly_frames_ratio": round(float((active >= 2).mean()), 2) if len(active) else 0.0}


def _timbre_stats(y: np.ndarray, sr: int) -> dict:
    """음색 지표. 디스토션은 2kHz 이상 에너지 비율(hf2k)로 가장 잘 갈린다
    (측정: 디스토션 기타 스템 0.31, 디스토션 밴드 믹스 0.11~0.18 / 클린 재즈 0.007~0.026).
    스펙트럼 평탄도는 디스토션에서 오히려 낮아져(배음이 뚜렷한 선 스펙트럼) 판정에 쓰지 않고 참고로만 낸다."""
    import librosa
    y = y[: sr * 60]   # 길어도 60초만
    M = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))      # 크기 스펙트럼(평탄도는 크기 기준이어야 함)
    P = M ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    total = P.sum() + 1e-9
    hf2k = float(P[freqs >= 2000].sum() / total)
    hf4k = float(P[freqs >= 4000].sum() / total)
    flat = float(np.mean(librosa.feature.spectral_flatness(S=M)))
    cent = float(np.mean(librosa.feature.spectral_centroid(S=M, sr=sr)))
    roll = float(np.median(librosa.feature.spectral_rolloff(S=M, sr=sr, roll_percent=0.95)))
    frame = sr // 2
    crests = []
    for i in range(0, len(y) - frame, frame):
        seg = y[i:i + frame]
        rms = np.sqrt(np.mean(seg ** 2)) + 1e-9
        if rms > 1e-3:
            crests.append(20 * np.log10(np.max(np.abs(seg)) / rms))
    crest = float(np.median(crests)) if crests else 0.0
    oenv = librosa.onset.onset_strength(y=y, sr=sr)
    onset_peakiness = float(np.percentile(oenv, 99) / (np.mean(oenv) + 1e-9))   # 어택이 뚜렷할수록 큼(디스토션 서스테인은 작음)
    return {"hf2k": round(hf2k, 3), "hf4k": round(hf4k, 3), "flatness": round(flat, 4), "centroid_hz": round(cent),
            "rolloff95_hz": round(roll), "crest_db": round(crest, 1), "onset_peakiness": round(onset_peakiness, 1)}


def analyze(y: np.ndarray, sr: int, notes: list[Note]) -> dict:
    p = _polyphony_stats(notes)
    t = _timbre_stats(y, sr)

    # ① 단선율 vs ② 코드+멜로디
    if p["avg_poly"] < 1.35 and p["chord_onset_ratio"] < 0.25:
        texture, texture_conf = "mono", "높음" if p["avg_poly"] < 1.2 else "중간"
    elif p["avg_poly"] < 1.7 and p["chord_onset_ratio"] < 0.45:
        texture, texture_conf = "poly", "중간"
    else:
        texture, texture_conf = "poly", "높음"

    # ③ 디스토션 / 클린. (어쿠스틱 vs 클린 일렉은 보정할 표본이 없어 구분하지 않는다)
    if t["hf2k"] >= 0.08:
        timbre, timbre_conf = "electric_distorted", ("높음" if t["onset_peakiness"] < 7 else "중간")
    elif t["hf2k"] >= 0.05:
        timbre, timbre_conf = "electric_distorted", "낮음"
    else:
        timbre, timbre_conf = "clean", ("높음" if t["hf2k"] < 0.03 else "중간")

    labels = {"mono": "① 단선율 멜로디", "poly": "② 코드+멜로디(핑거스타일/다성)",
              "electric_distorted": "③ 디스토션 있음(일렉)", "clean": "③ 클린(일렉 클린 또는 어쿠스틱 — 둘은 구분 안 함)"}
    return {
        "texture": texture, "texture_label": labels[texture], "texture_conf": texture_conf,
        "timbre": timbre, "timbre_label": labels[timbre], "timbre_conf": timbre_conf,
        "metrics": {**p, **t},
        "recommend": {
            "mode": "top" if texture == "mono" else "both",
            # 디스토션이면 조금 더 엄격하게. (0.85는 용의자 리프 검증에서 멜로디까지 지워 86%→81%로 떨어뜨렸고, 0.7까지는 손실 없음)
            "ghost_ratio": 0.7 if timbre == "electric_distorted" else 0.6,
        },
    }


def describe(a: dict) -> str:
    m = a["metrics"]
    lines = [
        f"  {a['texture_label']}  (확신 {a['texture_conf']}; 평균 동시음 {m['avg_poly']}, 코드 온셋 비율 {m['chord_onset_ratio']}, 다성 프레임 {m.get('poly_frames_ratio')})",
        f"  {a['timbre_label']}  (확신 {a['timbre_conf']}; 2kHz↑ 에너지 {m['hf2k']} [디스토션 ≥0.08], 온셋 첨도 {m['onset_peakiness']}, 센트로이드 {m['centroid_hz']}Hz, 평탄도 {m['flatness']}, 크레스트 {m['crest_db']}dB)",
        f"  → 추천: --mode {a['recommend']['mode']}, --ghost-ratio {a['recommend']['ghost_ratio']}",
    ]
    return "\n".join(lines)
