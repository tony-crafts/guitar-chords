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
    import librosa
    y = y[: sr * 60]   # 길어도 60초만
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    total = S.sum() + 1e-9
    hf_ratio = float(S[freqs >= 4000].sum() / total)          # 4kHz 이상 에너지 비율
    flat = float(np.mean(librosa.feature.spectral_flatness(S=S)))
    cent = float(np.mean(librosa.feature.spectral_centroid(S=S, sr=sr)))
    # 크레스트 팩터(피크/RMS, dB): 디스토션·컴프레션이 세면 낮아진다
    frame = sr // 2
    crests = []
    for i in range(0, len(y) - frame, frame):
        seg = y[i:i + frame]
        rms = np.sqrt(np.mean(seg ** 2)) + 1e-9
        if rms > 1e-3:
            crests.append(20 * np.log10(np.max(np.abs(seg)) / rms))
    crest = float(np.median(crests)) if crests else 0.0
    # 어택 날카로움: 온셋 세기 분포의 첨도(어쿠스틱 핑거/피킹은 트랜지언트가 뚜렷)
    oenv = librosa.onset.onset_strength(y=y, sr=sr)
    onset_peakiness = float(np.percentile(oenv, 99) / (np.mean(oenv) + 1e-9))
    return {"hf_ratio": round(hf_ratio, 4), "flatness": round(flat, 4), "centroid_hz": round(cent),
            "crest_db": round(crest, 1), "onset_peakiness": round(onset_peakiness, 1)}


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

    # ③ 디스토션 / 클린 일렉 / 어쿠스틱
    dist_score = 0
    dist_score += t["crest_db"] < 11
    dist_score += t["flatness"] > 0.02
    dist_score += t["hf_ratio"] > 0.05
    if dist_score >= 2:
        timbre = "electric_distorted"
    elif t["onset_peakiness"] > 9 and t["centroid_hz"] > 1500:
        timbre = "acoustic"
    else:
        timbre = "electric_clean"
    timbre_conf = "중간" if dist_score in (1, 2) else "낮음~중간"

    labels = {"mono": "① 단선율 멜로디", "poly": "② 코드+멜로디(핑거스타일/다성)",
              "electric_distorted": "③ 일렉 — 디스토션 있음", "electric_clean": "③ 일렉(클린) 또는 잔향 많은 어쿠스틱",
              "acoustic": "③ 어쿠스틱"}
    return {
        "texture": texture, "texture_label": labels[texture], "texture_conf": texture_conf,
        "timbre": timbre, "timbre_label": labels[timbre], "timbre_conf": timbre_conf,
        "metrics": {**p, **t},
        "recommend": {
            "mode": "top" if texture == "mono" else "both",
            "ghost_ratio": 0.85 if timbre == "electric_distorted" else 0.6,
        },
    }


def describe(a: dict) -> str:
    m = a["metrics"]
    lines = [
        f"  {a['texture_label']}  (확신 {a['texture_conf']}; 평균 동시음 {m['avg_poly']}, 코드 온셋 비율 {m['chord_onset_ratio']}, 다성 프레임 {m.get('poly_frames_ratio')})",
        f"  {a['timbre_label']}  (확신 {a['timbre_conf']}; 크레스트 {m['crest_db']}dB, 평탄도 {m['flatness']}, 4kHz↑ {m['hf_ratio']}, 센트로이드 {m['centroid_hz']}Hz, 온셋 첨도 {m['onset_peakiness']})",
        f"  → 추천: --mode {a['recommend']['mode']}, --ghost-ratio {a['recommend']['ghost_ratio']}",
    ]
    return "\n".join(lines)
