"""줄·프렛 배치 — 동적 계획법으로 손 이동·줄 건너뛰기·높은 프렛에 벌점을 주어 가장 편한 경로를 고른다.

한 '사건'은 같은 격자 칸(마디, 16분 위치)에서 시작하는 음들의 묶음이다(단선율이면 음 1개).
사건마다 가능한 운지 조합(후보)을 만들고, 이전 사건의 후보에서 넘어오는 비용이 최소인 경로를 고른다.
"""
from __future__ import annotations

from itertools import product

from .model import Note


def positions_for(midi: int, open_midis: list[int], capo: int, max_fret: int) -> list[tuple[int, int]]:
    """(string 1~6, fret) 후보. fret은 카포 기준 0 = 카포 바로 위 개방."""
    out = []
    for i, om in enumerate(open_midis):          # i=0 → 6번줄
        fret = midi - (om + capo)
        if 0 <= fret <= max_fret - capo:
            out.append((6 - i, fret))
    return out


def _fingers_needed(assign: list[tuple[int, int]]) -> int:
    fretted = sorted(f for _, f in assign if f > 0)
    if not fretted:
        return 0
    low = fretted[0]
    barre = sum(1 for f in fretted if f == low)
    return len(fretted) - (barre - 1 if barre >= 2 else 0)


def _chord_candidates(notes: list[Note], open_midis, capo, w: dict) -> tuple[list[list[tuple[int, int]]], str]:
    """동시 음 묶음의 운지 조합. 반환: (후보 목록, 상태 'ok'|'stretch'|'unplayable')."""
    per_note = [positions_for(n.midi, open_midis, capo, w["max_fret"]) for n in notes]
    if any(not p for p in per_note):
        return [], "unplayable"
    combos = []
    for combo in product(*per_note):
        strings = [s for s, _ in combo]
        if len(set(strings)) != len(strings):
            continue
        combos.append(list(combo))
    if not combos:
        return [], "unplayable"

    def span(c):
        fr = [f for _, f in c if f > 0]
        return (max(fr) - min(fr)) if fr else 0

    ok = [c for c in combos if span(c) <= w["chord_span"] and _fingers_needed(c) <= 4]
    if ok:
        return ok, "ok"
    stretch = [c for c in combos if span(c) <= w["chord_span"] + 1 and _fingers_needed(c) <= 4]
    if stretch:
        return stretch, "stretch"
    combos.sort(key=span)
    return combos[:w["max_candidates"]], "unplayable"


def _local_cost(assign, w: dict, position: int | None) -> float:
    cost = 0.0
    for _, f in assign:
        cost += w["w_fret"] * f if f > 0 else w["w_open"]
    hand = _hand(assign)
    if position is not None and hand is not None:
        cost += w["w_pos"] * abs(hand - position)
    return cost


def _hand(assign) -> int | None:
    fretted = [f for _, f in assign if f > 0]
    return min(fretted) if fretted else None


def _trans_cost(prev_assign, prev_hand, cur_assign, dt: float, w: dict) -> float:
    cost = 0.0
    hand = _hand(cur_assign)
    if hand is not None and prev_hand is not None:
        d = abs(hand - prev_hand)
        cost += w["w_move"] * d
        if d > w["span"]:
            cost += w["w_shift"]
    if len(prev_assign) == 1 and len(cur_assign) == 1:
        skip = abs(cur_assign[0][0] - prev_assign[0][0]) - 1
        if skip > 0:
            cost += w["w_string"] * skip
    if dt < w["fast_gap_s"]:
        cost *= w["fast_mult"]
    return cost


def assign_fingering(notes: list[Note], open_midis: list[int], capo: int, w: dict,
                     position: int | None = None, grid=None) -> dict:
    """notes에 string/fret을 채워 넣는다(제자리 수정). 반환: 통계."""
    events: dict[tuple[int, int], list[Note]] = {}
    for n in notes:
        events.setdefault((n.bar, n.t16), []).append(n)
    keys = sorted(events)
    stats = {"events": len(keys), "stretch": 0, "unplayable": 0, "no_position": 0}
    if not keys:
        return stats

    cand_lists, statuses, times = [], [], []
    for k in keys:
        ev = events[k]
        if len(ev) == 1:
            c = [[p] for p in positions_for(ev[0].midi, open_midis, capo, w["max_fret"])]
            st = "ok" if c else "unplayable"
        else:
            c, st = _chord_candidates(ev, open_midis, capo, w)
        if not c:                       # 음역 밖 등 — 가장 가까운 줄에 강제 배치
            c = [[(1 if n.midi > open_midis[-1] else 6, max(0, min(w["max_fret"], n.midi - open_midis[0] - capo)))
                  for n in ev]]
            st = "unplayable"
            stats["no_position"] += 1
        c.sort(key=lambda a: _local_cost(a, w, position))
        cand_lists.append(c[: w["max_candidates"]])
        statuses.append(st)
        times.append(grid.time_of(*k) if grid else k[0] * 4 + k[1] / 4)

    # DP
    INF = float("inf")
    dp = [[(_local_cost(a, w, position), -1, _hand(a)) for a in cand_lists[0]]]
    for i in range(1, len(keys)):
        dt = times[i] - times[i - 1]
        row = []
        for a in cand_lists[i]:
            lc = _local_cost(a, w, position)
            best = (INF, -1, None)
            for j, (pc, _, ph) in enumerate(dp[i - 1]):
                c = pc + lc + _trans_cost(cand_lists[i - 1][j], ph, a, dt, w)
                if c < best[0]:
                    best = (c, j, _hand(a) if _hand(a) is not None else ph)
            row.append(best)
        dp.append(row)

    # 역추적
    j = min(range(len(dp[-1])), key=lambda x: dp[-1][x][0])
    choice = [0] * len(keys)
    for i in range(len(keys) - 1, -1, -1):
        choice[i] = j
        j = dp[i][j][1]
    for i, k in enumerate(keys):
        assign = cand_lists[i][choice[i]]
        for n, (s, f) in zip(events[k], assign):
            n.string, n.fret = s, f
            if statuses[i] == "stretch":
                n.flags.append("stretch")
            elif statuses[i] == "unplayable":
                n.flags.append("unplayable")
        stats["stretch"] += statuses[i] == "stretch"
        stats["unplayable"] += statuses[i] == "unplayable"
    stats["total_cost"] = round(dp[-1][choice[-1]][0], 2)
    return stats
