"""Guitar Pro 5 출력 (pyguitarpro) — TuxGuitar·MuseScore에서 열어 편집."""
from __future__ import annotations

from .durations import split16
from .model import Note


def write_gp5(path: str, notes: list[Note], n_bars: int, bpm: float, open_midis: list[int], capo: int,
              beats_per_bar: int = 4, title: str = "tab-draft") -> None:
    import guitarpro as gp

    song = gp.Song()
    song.title = title
    song.tempo = int(round(bpm))
    track = song.tracks[0]
    track.name = "Guitar (draft)"
    track.strings = [gp.GuitarString(6 - i, m) for i, m in enumerate(open_midis)]   # number 1 = 1번줄
    track.strings.sort(key=lambda s: s.number)
    track.fretCount = 24
    track.offset = capo
    sub = beats_per_bar * 4
    while len(track.measures) < max(1, n_bars):
        song.newMeasure()
    for m in track.measures:
        m.timeSignature.numerator = beats_per_bar
        m.timeSignature.denominator.value = 4

    by_bar: dict[int, dict[int, list[Note]]] = {}
    for n in notes:
        by_bar.setdefault(n.bar, {}).setdefault(n.t16, []).append(n)

    for bi, measure in enumerate(track.measures):
        voice = measure.voices[0]
        voice.beats = []
        events = by_bar.get(bi, {})
        pos = 0
        while pos < sub:
            ev = events.get(pos)
            if ev:
                # 다음 사건 전까지 길이(마디 안에서)
                nxt = min([p for p in events if p > pos] + [sub])
                length = min(max(n.dur16 for n in ev), nxt - pos)
                first = True
                for value, dotted in split16(length, pos, sub):
                    beat = gp.Beat(voice, duration=gp.Duration(value, dotted), status=gp.BeatStatus.normal)
                    for n in ev:
                        note = gp.Note(beat, value=n.fret, string=n.string,
                                       type=gp.NoteType.normal if first else gp.NoteType.tie,
                                       velocity=int(60 + 60 * min(1.0, n.conf)))
                        beat.notes.append(note)
                    voice.beats.append(beat)
                    first = False
                pos += length
            else:
                nxt = min([p for p in events if p > pos] + [sub])
                for value, dotted in split16(nxt - pos, pos, sub):
                    voice.beats.append(gp.Beat(voice, duration=gp.Duration(value, dotted), status=gp.BeatStatus.rest))
                pos = nxt
        # 두 번째 보이스는 비워 둠
        measure.voices[1].beats = []
    gp.write(song, path, version=(5, 1, 0))
