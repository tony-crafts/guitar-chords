#!/usr/bin/env python3
"""evaluate.py — 타브 초안(JSON)을 정답 운지 파일과 비교해 정확도를 집계한다.

    ~/.venvs/tab/bin/python tools/tab-draft/evaluate.py out/<이름>/top.json 정답.txt [--tol 2] [--shift auto|N]

정답 파일 형식(한 줄 = 음 하나, # 뒤는 주석):
    마디  박[.16분]  줄  프렛
    1     1         2   11      # 1마디 1박 첫 16분, 2번줄 11프렛
    1     2.3       1   12      # 1마디 2박의 세 번째 16분(= 2박 뒷 8분의 뒤), 1번줄 12프렛
    2     4.2       3   13
마디·박·16분은 1부터, 줄은 1(가는 줄)~6, 프렛은 카포 기준.

판정 분류
    exact      음·박·운지 모두 같음
    fingering  음·박은 같은데 줄/프렛만 다름(같은 음을 다른 자리에서 냄)
    timing     음은 같은데 박 위치가 ±tol 16분 안에서 어긋남
    pitch      같은 박에 음이 있는데 높이가 다름
    missing    정답에는 있는데 초안에 없음
    extra      초안에만 있는 음
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tabdraft.model import parse_tuning, midi_name  # noqa: E402


def load_ref(path: Path, open_midis: list[int], capo: int, sub: int) -> list[dict]:
    refs = []
    for ln, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.split("#")[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 4:
            raise SystemExit(f"{path}:{ln}: '마디 박[.16분] 줄 프렛' 4칸이어야 합니다: {line}")
        bar = int(parts[0]) - 1
        beat_s, _, sub_s = parts[1].partition(".")
        t16 = (int(beat_s) - 1) * 4 + (int(sub_s) - 1 if sub_s else 0)
        string, fret = int(parts[2]), int(parts[3])
        midi = open_midis[6 - string] + capo + fret
        refs.append({"abs": bar * sub + t16, "bar": bar, "t16": t16, "string": string, "fret": fret, "midi": midi})
    return refs


def load_draft(path: Path) -> tuple[list[dict], dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    sub = d["beats_per_bar"] * 4
    notes = []
    for b in d["bars"]:
        for n in b["notes"]:
            notes.append({"abs": n["bar"] * sub + n["t16"], "bar": n["bar"], "t16": n["t16"],
                          "string": n["string"], "fret": n["fret"], "midi": n["midi"], "conf": n["conf"]})
    return notes, d


def match(refs: list[dict], draft: list[dict], tol: int, shift: int) -> dict:
    used = set()
    rows = []
    for r in refs:
        t = r["abs"] + shift
        best = None
        for i, n in enumerate(draft):
            if i in used or n["midi"] != r["midi"] or abs(n["abs"] - t) > tol:
                continue
            key = (abs(n["abs"] - t), 0 if (n["string"], n["fret"]) == (r["string"], r["fret"]) else 1)
            if best is None or key < best[0]:
                best = (key, i)
        if best:
            i = best[1]; used.add(i); n = draft[i]
            dt = n["abs"] - t
            kind = "timing" if dt else ("exact" if (n["string"], n["fret"]) == (r["string"], r["fret"]) else "fingering")
            rows.append({"kind": kind, "ref": r, "draft": n, "dt16": dt})
            continue
        same_slot = [i for i, n in enumerate(draft) if i not in used and n["abs"] == t]
        if same_slot:
            i = min(same_slot, key=lambda i: abs(draft[i]["midi"] - r["midi"]))
            used.add(i)
            rows.append({"kind": "pitch", "ref": r, "draft": draft[i], "dt16": 0})
        else:
            rows.append({"kind": "missing", "ref": r, "draft": None, "dt16": None})
    extra = [n for i, n in enumerate(draft) if i not in used]
    counts = {k: sum(1 for x in rows if x["kind"] == k) for k in ("exact", "fingering", "timing", "pitch", "missing")}
    counts["extra"] = len(extra)
    return {"rows": rows, "extra": extra, "counts": counts}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("draft_json")
    ap.add_argument("reference")
    ap.add_argument("--tol", type=int, default=2, help="박자 허용 오차(16분음표 수, 기본 2)")
    ap.add_argument("--shift", default="auto", help="초안 격자가 정답보다 몇 16분 밀렸는지. auto면 -16~16 중 최적을 찾음")
    args = ap.parse_args()

    draft, meta = load_draft(Path(args.draft_json))
    open_midis = parse_tuning(meta["tuning"])
    sub = meta["beats_per_bar"] * 4
    refs = load_ref(Path(args.reference), open_midis, meta["capo"], sub)
    if not refs:
        print("정답 파일에 음이 없습니다"); return 1

    if args.shift == "auto":
        best = None
        for sh in range(-sub, sub + 1):
            c = match(refs, draft, args.tol, sh)["counts"]
            score = (c["exact"] + c["fingering"]) * 2 + c["timing"]
            if best is None or score > best[0]:
                best = (score, sh)
        shift = best[1]
    else:
        shift = int(args.shift)
    res = match(refs, draft, args.tol, shift)
    c = res["counts"]
    n = len(refs)
    pitch_ok = c["exact"] + c["fingering"] + c["timing"]
    time_ok = c["exact"] + c["fingering"]
    sec16 = 60 / meta["bpm"] / 4
    offs = [abs(r["dt16"]) for r in res["rows"] if r["kind"] == "timing"]

    print(f"정답 {n}음 · 초안 {len(draft)}음 · 격자 보정 {shift:+d}/16 · 허용 ±{args.tol}/16 ({sec16 * 1000:.0f}ms/칸)")
    print(f"  음 높이 일치     {pitch_ok}/{n} = {pitch_ok / n:.0%}   (정답 음이 ±{args.tol}칸 안에 같은 높이로 있음)")
    print(f"  박자 일치        {time_ok}/{max(1, pitch_ok)} = {time_ok / max(1, pitch_ok):.0%}   (음 맞은 것 중 같은 칸)"
          + (f"  · 어긋난 음 평균 {sum(offs) / len(offs):.1f}칸" if offs else ""))
    print(f"  줄·프렛 일치     {c['exact']}/{max(1, time_ok)} = {c['exact'] / max(1, time_ok):.0%}   (음·박 맞은 것 중 운지까지 같음)")
    print("  분류: " + ", ".join(f"{k} {v}" for k, v in c.items()))
    print()
    print("  마디  박    정답(줄/프렛 음)     초안(줄/프렛 음)     판정")
    for r in res["rows"]:
        ref, d = r["ref"], r["draft"]
        rs = f"{ref['string']}/{ref['fret']:<2} {midi_name(ref['midi']):<4}"
        ds = f"{d['string']}/{d['fret']:<2} {midi_name(d['midi']):<4}" if d else "-"
        extra = f" ({r['dt16']:+d}칸)" if r["kind"] == "timing" else ""
        print(f"  {ref['bar'] + 1:>3}  {ref['t16'] // 4 + 1}.{ref['t16'] % 4 + 1}  {rs:<20} {ds:<20} {r['kind']}{extra}")
    if res["extra"]:
        print(f"  초안에만 있는 음 {len(res['extra'])}개: " + ", ".join(
            f"{e['bar'] + 1}마디 {e['t16'] // 4 + 1}.{e['t16'] % 4 + 1} {e['string']}/{e['fret']}" for e in res["extra"][:20])
              + (" …" if len(res["extra"]) > 20 else ""))
    out = Path(args.draft_json).with_suffix(".eval.json")
    out.write_text(json.dumps({"shift": shift, "tol": args.tol, "counts": c, "n_ref": n,
                               "pitch_acc": pitch_ok / n, "timing_acc": time_ok / max(1, pitch_ok),
                               "fingering_acc": c["exact"] / max(1, time_ok)}, ensure_ascii=False, indent=1))
    print(f"\n→ {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
