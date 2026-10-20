"""텍스트 타브 — 6줄 ASCII, 마디 구분선, 16분음표 한 칸 = 3글자.

표시: (7) 또는 윗줄 ? = 신뢰도 낮음(두 자리 프렛), 윗줄 마커 o = 옥타브 이동한 음, ! = 한 손으로 잡기 어려운 동시 음, ~ = 프렛 폭이 넓은 동시 음
"""
from __future__ import annotations

from .model import Note

CELL = 3


def render(notes: list[Note], n_bars: int, sub: int, tuning_names: list[str], bars_per_line: int = 4,
           capo: int = 0, title: str = "") -> str:
    by_bar: dict[int, list[Note]] = {}
    for n in notes:
        by_bar.setdefault(n.bar, []).append(n)
    names = list(reversed(tuning_names))        # 1번줄부터 위에
    lines_out = []
    if title:
        lines_out.append(title)
    if capo:
        lines_out.append(f"Capo {capo}  (프렛 숫자는 카포 기준)")
    for start in range(0, n_bars, bars_per_line):
        bars = range(start, min(start + bars_per_line, n_bars))
        marker = ["  "]
        rows = [[f"{names[s]:>2}"] for s in range(6)]
        for b in bars:
            cells_mark = ["-"] * (sub * CELL)
            cells = [["-"] * (sub * CELL) for _ in range(6)]
            for n in by_bar.get(b, []):
                pos = n.t16 * CELL
                low = "low_conf" in n.flags
                txt = f"({n.fret})" if low and n.fret < 10 else str(n.fret)   # 두 자리 프렛은 윗줄 ? 로 표시
                row = cells[n.string - 1]
                for i, ch in enumerate(txt):
                    if pos + i < len(row):
                        row[pos + i] = ch
                mk = ("!" if "unplayable" in n.flags else "~" if "stretch" in n.flags else
                      "o" if "oct" in n.flags else "?" if (low and n.fret >= 10) else None)
                if mk and cells_mark[pos] == "-":
                    cells_mark[pos] = mk
            marker.append("".join(cells_mark).replace("-", " ") + " ")
            for s in range(6):
                rows[s].append("".join(cells[s]) + "|")
        header = "  " + "".join(f"{b + 1:<{sub * CELL + 1}}" for b in bars)
        lines_out.append(header.rstrip())
        mk_line = "".join(marker).rstrip()
        if mk_line.strip():
            lines_out.append(mk_line)
        for s in range(6):
            lines_out.append("".join(rows[s]))
        lines_out.append("")
    legend = "( ) 또는 윗줄 ? = 신뢰도 낮음 · o 옥타브 이동 · ! 한 손으로 잡기 어려움 · ~ 프렛 폭 넓음 · 한 칸 = 16분음표"
    lines_out.append(legend)
    return "\n".join(lines_out)
