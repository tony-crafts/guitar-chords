"""멜로디 정리 — 가짜 음 제거, 끊긴 음 합치기, 비브라토 흡수, 한 줄/다성 선택, 음역 맞추기, 격자 양자화."""
from __future__ import annotations

from .model import Note

HARMONIC_INTERVALS = (12, 19, 24, 28, 31, 34, -12)   # 옥타브, 12도, 2옥타브, 2옥+3도, 2옥+5도, 2옥+7도, 아래 옥타브


def _groups(notes: list[Note], window: float) -> list[list[Note]]:
    """시작 시각이 window 안에 모이는 음끼리 묶는다(코드로 함께 친 음)."""
    out: list[list[Note]] = []
    for n in sorted(notes, key=lambda x: x.start):
        if out and n.start - out[-1][0].start < window:
            out[-1].append(n)
        else:
            out.append([n])
    return out


def remove_ghosts(notes: list[Note], ratio: float, window: float) -> tuple[list[Note], int]:
    """배음 자리에 같이 시작한 약한 음, 또는 울리는 음 위에 잠깐 떠오른 배음을 제거."""
    keep, removed = [], 0
    by_start = sorted(notes, key=lambda n: n.start)
    for b in by_start:
        ghost = False
        for a in by_start:
            if a is b or a.start > b.start + window:
                continue
            iv = b.midi - a.midi
            if iv not in HARMONIC_INTERVALS:
                continue
            same_onset = abs(a.start - b.start) < window
            inside = a.start < b.start < a.end and b.dur < 0.15
            if (same_onset or inside) and b.conf < ratio * a.conf:
                ghost = True
                break
        if ghost:
            removed += 1
        else:
            keep.append(b)
    return keep, removed


def merge_same_pitch(notes: list[Note], gap: float) -> tuple[list[Note], int]:
    out: list[Note] = []
    merged = 0
    for n in sorted(notes, key=lambda x: (x.midi, x.start)):
        if out and out[-1].midi == n.midi and n.start - out[-1].end < gap:
            out[-1].end = max(out[-1].end, n.end)
            out[-1].conf = max(out[-1].conf, n.conf)
            out[-1].flags.append("merged")
            merged += 1
        else:
            out.append(n)
    out.sort(key=lambda x: (x.start, -x.midi))
    return out, merged


def absorb_vibrato(notes: list[Note], vib: float, gap: float) -> tuple[list[Note], int]:
    """짧은 음이 바로 옆(앞/뒤) 긴 음과 반음~온음 차이면 그 긴 음에 흡수(비브라토·꺾기·슬라이드 잔재)."""
    notes = sorted(notes, key=lambda x: x.start)
    absorbed = 0
    changed = True
    while changed:
        changed = False
        for i, n in enumerate(notes):
            if n.dur >= vib:
                continue
            best = None
            for m in notes:
                if m is n or abs(m.midi - n.midi) > 2 or m.midi == n.midi or m.dur <= n.dur:
                    continue
                adjacent = (abs(m.end - n.start) < gap) or (abs(n.end - m.start) < gap) or (m.start <= n.start < m.end)
                if adjacent and (best is None or m.dur > best.dur):
                    best = m
            if best is not None:
                best.start = min(best.start, n.start)
                best.end = max(best.end, n.end)
                best.flags.append("vibrato")
                notes.pop(i)
                absorbed += 1
                changed = True
                break
    return notes, absorbed


def _score(n: Note, prev_midi: int | None, lo: int, w: dict) -> float:
    s = w["w_pitch"] * (n.midi - lo) / 12.0 + w["w_conf"] * n.conf
    if prev_midi is not None:
        s -= w["w_cont"] * abs(n.midi - prev_midi) / 12.0
    return s


def pick_melody(notes: list[Note], window: float, weights: dict) -> tuple[list[Note], int]:
    """한 줄만 남긴다. 동시에 시작한 음 + 아직 울리고 있는 멜로디 음 중 점수가 가장 높은 음을 고른다."""
    if not notes:
        return [], 0
    lo = min(n.midi for n in notes)
    melody: list[Note] = []
    dropped = 0
    for g in _groups(notes, window):
        prev = melody[-1] if melody else None
        cands = list(g)
        sustaining = prev is not None and prev.end - g[0].start > 0.06
        if sustaining:
            cands.append(prev)
        prev_midi = (melody[-2].midi if sustaining and len(melody) > 1 else (prev.midi if prev else None))
        best = max(cands, key=lambda n: _score(n, prev_midi, lo, weights))
        if best is prev:               # 울리던 음이 이김 → 이 그룹은 반주로 보고 버림
            dropped += len(g)
            continue
        dropped += len(g) - 1
        if prev is not None and prev.end > best.start:
            prev.end = best.start      # 레가토: 이전 음은 새 음 시작에서 끊음
        melody.append(best)
    return melody, dropped


def limit_voices(notes: list[Note], window: float, max_voices: int) -> tuple[list[Note], int]:
    out, dropped = [], 0
    for g in _groups(notes, window):
        seen: dict[int, Note] = {}
        for n in sorted(g, key=lambda x: -x.conf):
            if n.midi in seen:
                dropped += 1
                continue
            seen[n.midi] = n
        g2 = sorted(seen.values(), key=lambda x: -x.conf)
        dropped += max(0, len(g2) - max_voices)
        out.extend(g2[:max_voices])
    out.sort(key=lambda x: (x.start, -x.midi))
    return out, dropped


def fit_range(notes: list[Note], lo: int, hi: int) -> int:
    shifted = 0
    for n in notes:
        k = 0
        while n.midi < lo:
            n.midi += 12; k += 1
        while n.midi > hi:
            n.midi -= 12; k -= 1
        if k:
            n.oct_shift = k
            n.flags.append("oct")
            shifted += 1
    return shifted


def quantize(notes: list[Note], grid, mono: bool) -> tuple[list[Note], int]:
    """음을 16분음표 격자에 맞춘다. mono면 같은 칸에 두 음이 오면 하나만 남긴다."""
    for n in notes:
        n.bar, n.t16, n.grid_err = grid.quantize(n.start)
        ebar, et16, _ = grid.quantize(n.end)
        n.dur16 = max(1, (ebar - n.bar) * grid.sub + et16 - n.t16)
    notes.sort(key=lambda n: (n.bar, n.t16, -n.midi))
    collided = 0
    if mono:
        out: list[Note] = []
        for n in notes:
            if out and (out[-1].bar, out[-1].t16) == (n.bar, n.t16):
                collided += 1
                if n.conf > out[-1].conf:
                    out[-1] = n
                continue
            out.append(n)
        # 다음 음 시작을 넘지 않게 길이 자름
        for a, b in zip(out, out[1:]):
            span = (b.bar - a.bar) * grid.sub + b.t16 - a.t16
            a.dur16 = max(1, min(a.dur16, span))
        notes = out
    return notes, collided


def clean(notes: list[Note], cfg: dict, mode: str, grid, lo: int, hi: int, low_conf: float) -> tuple[list[Note], dict]:
    """mode: 'top'(한 줄) | 'poly'(동시 음 유지). cfg = weights.toml [clean] + [melody]."""
    c = cfg["clean"]
    win = c["chord_window_ms"] / 1000
    stats = {"input": len(notes)}
    notes = [Note(**{k: v for k, v in n.__dict__.items()}) for n in notes]   # 복사
    for n in notes:
        n.flags = list(n.flags)
    before = len(notes)
    notes = [n for n in notes if n.conf >= c["conf_min"] and n.dur >= c["min_note_ms"] / 1000]
    stats["weak_or_short"] = before - len(notes)
    notes, stats["ghost"] = remove_ghosts(notes, c["ghost_ratio"], win)
    notes, stats["merged"] = merge_same_pitch(notes, c["merge_gap_ms"] / 1000)
    notes, stats["vibrato"] = absorb_vibrato(notes, c["vibrato_ms"] / 1000, c["merge_gap_ms"] / 1000)
    if mode == "top":
        pick = cfg["melody"][cfg["melody"].get("pick", "highest")]
        notes, stats["accompaniment_dropped"] = pick_melody(notes, win, pick)
    else:
        notes, stats["voices_dropped"] = limit_voices(notes, win, c["max_voices"])
    stats["octave_shifted"] = fit_range(notes, lo, hi)
    notes, stats["grid_collisions"] = quantize(notes, grid, mono=(mode == "top"))
    for n in notes:
        if n.conf < low_conf:
            n.flags.append("low_conf")
    stats["output"] = len(notes)
    return notes, stats
