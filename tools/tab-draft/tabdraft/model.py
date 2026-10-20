"""공용 자료형 — 음(Note)과 튜닝."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
STANDARD_TUNING = "EADGBE"
# 줄 이름 → 개방현 MIDI (6번줄 E2=40 부터)
_LETTER_MIDI = {"E": 40, "A": 45, "D": 50, "G": 55, "B": 59}


def midi_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def parse_tuning(s: str) -> list[int]:
    """'EADGBE' / 'DADGBE' / 'D A D G B E' / '38,45,50,55,59,64' → 6번줄부터 개방현 MIDI 목록."""
    s = s.strip()
    if "," in s:
        vals = [int(x) for x in s.split(",")]
    else:
        letters = s.replace(" ", "").upper()
        if len(letters) != 6:
            raise ValueError(f"튜닝은 6글자여야 합니다: {s}")
        vals, prev = [], None
        base = [40, 45, 50, 55, 59, 64]
        for i, ch in enumerate(letters):
            # 표준 튜닝의 해당 줄 근처에서 가장 가까운 같은 이름의 음을 고른다(드롭 D 등)
            pc = NOTE_NAMES.index(ch) if ch in NOTE_NAMES else None
            if pc is None:
                raise ValueError(f"줄 이름을 모르겠습니다: {ch}")
            cands = [m for m in range(base[i] - 6, base[i] + 7) if m % 12 == pc]
            vals.append(min(cands, key=lambda m: abs(m - base[i])))
    if len(vals) != 6:
        raise ValueError("튜닝은 줄 6개여야 합니다")
    return vals


@dataclass
class Note:
    start: float              # 초(구간 시작 기준)
    end: float
    midi: int
    conf: float               # Basic Pitch 진폭(0~1) → 신뢰도로 사용
    bar: int = -1             # 양자화 후
    t16: int = -1             # 마디 안 16분 위치
    dur16: int = 1
    grid_err: float = 0.0     # 격자 대비 오차(초)
    string: int = 0           # 1 = 1번줄(높은 E) … 6
    fret: int = -1
    oct_shift: int = 0        # 음역 밖이라 옮긴 옥타브 수
    flags: list[str] = field(default_factory=list)   # 'low_conf' 'merged' 'vibrato' 'unplayable' …

    @property
    def dur(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        d = asdict(self)
        d["name"] = midi_name(self.midi)
        return d

    @staticmethod
    def from_dict(d: dict) -> "Note":
        d = {k: v for k, v in d.items() if k != "name"}
        return Note(**d)
