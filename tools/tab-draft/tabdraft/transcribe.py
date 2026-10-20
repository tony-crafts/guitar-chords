"""음 추출 — Spotify Basic Pitch (맥에서는 CoreML 모델 사용)."""
from __future__ import annotations

import contextlib
import io
import os
import warnings
from pathlib import Path

from .model import Note


def split_reattacks(notes: list[Note], onsets: "np.ndarray", fps: float, threshold: float = 0.3,
                    min_gap_ms: float = 80.0) -> tuple[list[Note], int]:
    """재타격 복구 — 한 음이 울리는 동안 같은 음높이의 음 시작 확률에 봉우리(threshold 이상)가 더 있으면 거기서 음을 쪼갠다.
    onsets: Basic Pitch 음 시작 확률 (프레임 × 88, MIDI 21부터). fps: 초당 프레임."""
    import numpy as np
    out, splits = [], 0
    gap = int(min_gap_ms / 1000 * fps)
    for n in notes:
        col = n.midi - 21
        a, b = int(round(n.start * fps)), int(round(n.end * fps))
        if not (0 <= col < onsets.shape[1]) or b - a < 2 * gap:
            out.append(n); continue
        seg = onsets[a:b, col]
        cuts = []
        last = 0                                           # 첫 어택(음 시작)은 이미 반영됨
        for i in range(gap, len(seg) - gap // 2):
            if seg[i] >= threshold and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1] and i - last >= gap:
                cuts.append(i); last = i
        if not cuts:
            out.append(n); continue
        bounds = [0] + cuts + [len(seg)]
        for j in range(len(bounds) - 1):
            piece = Note(start=n.start + bounds[j] / fps, end=n.start + bounds[j + 1] / fps, midi=n.midi,
                         conf=n.conf if j == 0 else max(n.conf * 0.9, float(seg[bounds[j]])),
                         flags=list(n.flags) + (["reattack"] if j > 0 else []))
            out.append(piece)
        splits += len(cuts)
    out.sort(key=lambda x: (x.start, -x.midi))
    return out, splits


def transcribe(wav_path: str | Path, onset_threshold: float = 0.5, frame_threshold: float = 0.3,
               min_note_ms: float = 60.0, min_freq: float = 70.0, max_freq: float = 1500.0,
               midi_out: str | Path | None = None, reattack_threshold: float | None = 0.3,
               reattack_min_gap_ms: float = 80.0) -> tuple[list[Note], str]:
    """wav → Note 목록. 두 번째 반환값은 사용한 모델 백엔드 설명.
    reattack_threshold 가 있으면 음 시작 확률 지도로 재타격(같은 음 다시 치기)을 쪼갠다."""
    warnings.filterwarnings("ignore")
    import logging
    logging.getLogger().setLevel(logging.ERROR)
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    backend = Path(str(ICASSP_2022_MODEL_PATH)).suffix.lstrip(".") or "unknown"
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):   # coreml 디버그 출력 숨김
        model_output, midi_data, events = predict(
            str(wav_path), ICASSP_2022_MODEL_PATH,
            onset_threshold=onset_threshold, frame_threshold=frame_threshold,
            minimum_note_length=min_note_ms, minimum_frequency=min_freq, maximum_frequency=max_freq,
            multiple_pitch_bends=False, melodia_trick=True,
        )
    if midi_out:
        midi_data.write(str(midi_out))
    notes = [Note(start=float(s), end=float(e), midi=int(p), conf=float(a)) for s, e, p, a, _ in events]
    notes.sort(key=lambda n: (n.start, -n.midi))
    info = f"basic-pitch {backend}"
    if reattack_threshold is not None and reattack_threshold > 0:
        from basic_pitch.constants import AUDIO_SAMPLE_RATE, FFT_HOP
        fps = AUDIO_SAMPLE_RATE / FFT_HOP
        notes, k = split_reattacks(notes, model_output["onset"], fps, reattack_threshold, reattack_min_gap_ms)
        info += f", 재타격 분리 {k}개"
    return notes, info
