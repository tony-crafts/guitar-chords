"""16분음표 개수 → 악보 음표값 분할 (GP5·MusicXML 공용).

반환: [(값, 점 여부)] 예) 6칸 → [(4, True)] 점4분음표, 5칸 → [(4, False), (16, False)]
값은 음표 종류(1=온음표, 2=2분, 4=4분, 8=8분, 16=16분).
"""
_TABLE = [(16, 1, False), (12, 2, True), (8, 2, False), (6, 4, True), (4, 4, False), (3, 8, True), (2, 8, False), (1, 16, False)]


def split16(n: int, pos: int = 0, sub: int = 16) -> list[tuple[int, bool]]:
    """n칸을 음표값으로 나눈다. pos는 마디 안 위치 — 박 경계를 넘는 긴 음표는 피한다."""
    out = []
    while n > 0:
        for cells, value, dotted in _TABLE:
            if cells <= n and (pos % cells == 0 or cells == 1):
                out.append((value, dotted))
                n -= cells
                pos += cells
                break
        else:
            out.append((16, False)); n -= 1; pos += 1
    return out
