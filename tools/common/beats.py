"""박자·마디 격자 — 코드 추출(1단계)과 타브 초안(2단계)이 함께 쓰는 모듈.

사용 흐름
    grid = track_beats(y, sr, bpm=None 또는 숫자, beats_per_bar=4)
    bar, t16, err = grid.quantize(1.23)      # 초 → (마디 번호 0부터, 16분 위치, 격자 오차 초)
    t = grid.time_of(bar, t16)               # 반대 방향

bpm을 주면: 고정 간격 격자를 만들고 온셋(음 시작) 에너지에 가장 잘 맞는 위상(첫 박 위치)을 고른다.
bpm이 없으면: librosa 비트 추적 결과(균일하지 않을 수 있음)를 그대로 쓴다.
첫 마디(다운비트)는 네 가지 위상 중 온셋 에너지가 가장 센 쪽을 고른다 — 틀릴 수 있으니 결과에 적어 둔다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class BeatGrid:
    beat_times: np.ndarray          # 각 박의 시각(초). 구간 전체를 덮도록 앞뒤로 늘려 둠
    bpm: float
    beats_per_bar: int = 4
    downbeat_phase: int = 0         # beat_times[downbeat_phase]가 첫 마디 첫 박
    source: str = "librosa"         # 'fixed' | 'librosa'
    notes: list[str] = field(default_factory=list)

    @property
    def sub(self) -> int:           # 마디당 16분음표 수
        return self.beats_per_bar * 4

    def quantize(self, t: float, div: int = 4) -> tuple[int, int, float]:
        """시각 → (마디, 16분 위치, 격자와의 오차 초). div=4면 박을 4등분(16분)."""
        bt = self.beat_times
        i = int(np.searchsorted(bt, t, side="right") - 1)
        i = max(0, min(i, len(bt) - 2))
        period = bt[i + 1] - bt[i]
        frac = (t - bt[i]) / period
        k = int(round(frac * div))
        beat_idx = i - self.downbeat_phase
        if k >= div:                                   # 다음 박으로 반올림
            k = 0
            beat_idx += 1
        snapped = self.time_of_beat(beat_idx + k / div)
        bar, beat_in_bar = divmod(beat_idx, self.beats_per_bar)
        return bar, beat_in_bar * div + k, t - snapped

    def time_of_beat(self, beat_pos: float) -> float:
        """다운비트 기준 박 위치(실수, 예: 2.25) → 초."""
        i = int(np.floor(beat_pos)) + self.downbeat_phase
        frac = beat_pos - np.floor(beat_pos)
        bt = self.beat_times
        if i < 0:
            return float(bt[0] + (beat_pos + self.downbeat_phase) * (bt[1] - bt[0]))
        if i >= len(bt) - 1:
            return float(bt[-1] + (i - (len(bt) - 1) + frac) * (bt[-1] - bt[-2]))
        return float(bt[i] + frac * (bt[i + 1] - bt[i]))

    def time_of(self, bar: int, t16: int) -> float:
        return self.time_of_beat(bar * self.beats_per_bar + t16 / 4)

    def bar_count(self, duration: float) -> int:
        bar, t16, _ = self.quantize(duration)
        return bar + (1 if t16 > 0 else 0)


def _onset_envelope(y: np.ndarray, sr: int, hop: int = 512):
    import librosa
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(len(oenv)), sr=sr, hop_length=hop)
    return oenv, times


def _extend(beats: np.ndarray, duration: float, period: float) -> np.ndarray:
    """격자를 0초 이전과 끝 이후까지 늘려 구간 전체를 덮게 한다."""
    beats = list(beats)
    while beats[0] - period > -period:        # 0초 조금 앞까지
        beats.insert(0, beats[0] - period)
    while beats[-1] < duration + period:
        beats.append(beats[-1] + period)
    return np.array(beats)


def _pick_downbeat(beats: np.ndarray, oenv: np.ndarray, times: np.ndarray, beats_per_bar: int) -> int:
    """네 위상 중 마디 첫 박 자리의 온셋 에너지 합이 가장 큰 위상."""
    strength = np.interp(beats, times, oenv, left=0, right=0)
    best, best_s = 0, -1.0
    for p in range(beats_per_bar):
        s = strength[p::beats_per_bar].sum()
        if s > best_s:
            best, best_s = p, s
    # 첫 박보다 앞쪽 격자점이 있으면 위상을 0~beats_per_bar-1 안으로
    return best


def track_beats(y: np.ndarray, sr: int, bpm: float | None = None,
                beats_per_bar: int = 4) -> BeatGrid:
    import librosa
    duration = len(y) / sr
    oenv, times = _onset_envelope(y, sr)
    notes: list[str] = []

    if bpm:
        period = 60.0 / bpm
        # 위상: 한 박 길이를 40등분해서 격자점 온셋 합이 최대인 오프셋
        best_off, best_s = 0.0, -1.0
        for off in np.linspace(0, period, 40, endpoint=False):
            grid = np.arange(off, duration, period)
            s = np.interp(grid, times, oenv, left=0, right=0).sum()
            if s > best_s:
                best_off, best_s = off, s
        beats = np.arange(best_off, duration + period, period)
        source = "fixed"
        notes.append(f"고정 템포 {bpm:.1f} BPM, 첫 박 오프셋 {best_off * 1000:.0f}ms")
    else:
        tempo, frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=512, units="frames")
        beats = librosa.frames_to_time(frames, sr=sr, hop_length=512)
        tempo = float(np.atleast_1d(tempo)[0])
        if len(beats) < 4:
            period = 60.0 / (tempo or 120)
            beats = np.arange(0, duration + period, period)
            notes.append("비트 추적 실패 — 추정 템포로 고정 격자 사용")
        period = float(np.median(np.diff(beats)))
        bpm = 60.0 / period
        source = "librosa"
        notes.append(f"비트 추적 템포 {bpm:.1f} BPM (박 간격 편차 {np.std(np.diff(beats)) * 1000:.0f}ms)")

    beats = _extend(np.asarray(beats, dtype=float), duration, period)
    # 다운비트는 0초 이후 첫 박부터 센다
    first = int(np.searchsorted(beats, 0.0))
    phase = first + _pick_downbeat(beats[first:], oenv, times, beats_per_bar)
    grid = BeatGrid(beat_times=beats, bpm=float(bpm), beats_per_bar=beats_per_bar,
                    downbeat_phase=phase, source=source, notes=notes)
    grid.notes.append(f"첫 마디 시작 {grid.time_of(0, 0):.3f}s (온셋 세기로 추정 — 틀리면 --bar-offset 로 보정)")
    return grid
