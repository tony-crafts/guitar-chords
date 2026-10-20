"""MusicXML 출력 — TAB 보표 하나(줄 6, 튜닝 표기, string/fret 포함). MuseScore·TuxGuitar에서 열림."""
from __future__ import annotations

from xml.sax.saxutils import escape

from .durations import split16
from .model import Note, NOTE_NAMES

_TYPE = {1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "16th"}
_CELLS = {1: 16, 2: 8, 4: 4, 8: 2, 16: 1}


def _pitch_xml(midi: int) -> str:
    name = NOTE_NAMES[midi % 12]
    step, alter = name[0], (1 if "#" in name else 0)
    octave = midi // 12 - 1
    s = f"<step>{step}</step>"
    if alter:
        s += f"<alter>{alter}</alter>"
    return f"<pitch>{s}<octave>{octave}</octave></pitch>"


def write_musicxml(path: str, notes: list[Note], n_bars: int, bpm: float, open_midis: list[int], capo: int,
                   beats_per_bar: int = 4, title: str = "tab-draft") -> None:
    sub = beats_per_bar * 4
    by_bar: dict[int, dict[int, list[Note]]] = {}
    for n in notes:
        by_bar.setdefault(n.bar, {}).setdefault(n.t16, []).append(n)

    tuning = "".join(
        f'<staff-tuning line="{i + 1}"><tuning-step>{NOTE_NAMES[m % 12][0]}</tuning-step>'
        + (f"<tuning-alter>1</tuning-alter>" if "#" in NOTE_NAMES[m % 12] else "")
        + f"<tuning-octave>{m // 12 - 1}</tuning-octave></staff-tuning>"
        for i, m in enumerate(open_midis))
    capo_xml = f"<capo>{capo}</capo>" if capo else ""
    parts = [f'<?xml version="1.0" encoding="UTF-8"?>',
             '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
             '<score-partwise version="4.0">',
             f"<work><work-title>{escape(title)}</work-title></work>",
             '<part-list><score-part id="P1"><part-name>Guitar (draft)</part-name></score-part></part-list>',
             '<part id="P1">']
    for bi in range(max(1, n_bars)):
        parts.append(f'<measure number="{bi + 1}">')
        if bi == 0:
            parts.append(
                "<attributes><divisions>4</divisions><key><fifths>0</fifths></key>"
                f"<time><beats>{beats_per_bar}</beats><beat-type>4</beat-type></time>"
                "<clef><sign>TAB</sign><line>5</line></clef>"
                f"<staff-details><staff-lines>6</staff-lines>{tuning}{capo_xml}</staff-details></attributes>"
                f'<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
                f"<per-minute>{bpm:.0f}</per-minute></metronome></direction-type><sound tempo=\"{bpm:.0f}\"/></direction>")
        events = by_bar.get(bi, {})
        pos = 0
        while pos < sub:
            ev = events.get(pos)
            nxt = min([p for p in events if p > pos] + [sub])
            if ev:
                length = min(max(n.dur16 for n in ev), nxt - pos)
                pieces = split16(length, pos, sub)
                for pi, (value, dotted) in enumerate(pieces):
                    dur = _CELLS[value] * (3 if dotted else 2) // 2
                    for ni, n in enumerate(sorted(ev, key=lambda x: x.midi)):
                        chord = "<chord/>" if ni > 0 else ""
                        tie = ""
                        if len(pieces) > 1:
                            if pi < len(pieces) - 1:
                                tie += '<tie type="start"/>'
                            if pi > 0:
                                tie += '<tie type="stop"/>'
                        parts.append(
                            f"<note>{chord}{_pitch_xml(n.midi + 0)}<duration>{dur}</duration>{tie}"
                            f"<type>{_TYPE[value]}</type>{'<dot/>' if dotted else ''}"
                            f"<notations><technical><string>{n.string}</string><fret>{n.fret}</fret></technical></notations></note>")
                pos += length
            else:
                for value, dotted in split16(nxt - pos, pos, sub):
                    dur = _CELLS[value] * (3 if dotted else 2) // 2
                    parts.append(f"<note><rest/><duration>{dur}</duration><type>{_TYPE[value]}</type>{'<dot/>' if dotted else ''}</note>")
                pos = nxt
        parts.append("</measure>")
    parts.append("</part></score-partwise>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
