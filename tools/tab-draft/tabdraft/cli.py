"""tab-draft 명령줄 — 음원 구간 → 텍스트 타브 + GP5 + MusicXML + 확인용 wav."""
from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent          # tools/tab-draft
sys.path.insert(0, str(HERE.parent))                   # tools/ → common 패키지

from common.audio import load_audio, write_wav, duration_of, measure_lag, shift_audio   # noqa: E402
from common.beats import track_beats, estimate_feel, estimate_local_offsets, apply_local_offsets  # noqa: E402
from .analyze import analyze, describe                        # noqa: E402
from .fingering import assign_fingering, suggest_position     # noqa: E402
from .melody import clean                                     # noqa: E402
from .model import parse_tuning, NOTE_NAMES                   # noqa: E402
from .output_gp import write_gp5                              # noqa: E402
from .output_text import render                               # noqa: E402
from .output_xml import write_musicxml                        # noqa: E402
from .synth import synthesize, mix, check_lag                 # noqa: E402
from .transcribe import transcribe                            # noqa: E402

SR = 22050


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tab-draft", description="오디오 → 기타 멜로디 타브 초안")
    p.add_argument("audio", help="음원 파일 (mp3/wav/m4a)")
    p.add_argument("--source", choices=["vocal", "guitar"], default="guitar", help="뽑을 멜로디(기본 guitar)")
    p.add_argument("--start", type=float, default=0.0, help="구간 시작(초)")
    p.add_argument("--end", type=float, default=None, help="구간 끝(초). 생략하면 끝까지")
    p.add_argument("--capo", type=int, default=0)
    p.add_argument("--tuning", default="EADGBE", help="6번줄부터. 예: EADGBE, DADGBE, 또는 MIDI 숫자 6개")
    p.add_argument("--bpm", type=float, default=None, help="템포를 알면 지정(고정 격자)")
    p.add_argument("--beats-per-bar", type=int, default=4)
    p.add_argument("--bar-offset", type=int, default=0, help="첫 마디 위치를 박 단위로 보정(예: 1이면 한 박 뒤가 1마디 시작)")
    p.add_argument("--position", default="auto", help="선호 포지션 프렛(예: 5). auto = 멜로디에 맞춰 자동 제안, none = 선호 없음")
    p.add_argument("--mode", choices=["auto", "top", "poly", "both"], default="auto",
                   help="top=가장 높은 음 한 줄 / poly=동시 음 유지 / both=둘 다 / auto=음원 성격으로 결정")
    p.add_argument("--pick", choices=["highest", "loudest"], default=None,
                   help="top 모드에서 멜로디 고르는 기준(기본: 단선율이면 loudest, 다성이면 highest)")
    p.add_argument("--stems", type=Path, default=None, help="기존 Demucs 분리 폴더 재사용")
    p.add_argument("--no-separate", action="store_true", help="음원 분리 건너뜀(기타 단독 녹음 등)")
    p.add_argument("--stem-gate", choices=["off", "auto", "soft", "hard"], default="off",
                   help="믹스에서 음을 뽑고 기타/나머지 스템 에너지 비율로 반주를 가려냄(실험 기능, 기본 off). "
                        "soft = 멜로디 선택에서 감점만, hard = 기준 미만 음 제거, auto = 스템이 있거나 분리할 때 soft")
    p.add_argument("--gate-ratio", type=float, default=0.5, help="스템 게이트 기준: 기타 에너지 비율 최소값(기본 0.5, 높을수록 엄격)")
    p.add_argument("--device", default="mps", help="Demucs 장치 mps|cpu")
    p.add_argument("--weights", type=Path, default=HERE / "weights.toml")
    p.add_argument("--out", type=Path, default=None, help="출력 폴더(기본 tools/tab-draft/out/<이름>)")
    p.add_argument("--name", default=None, help="출력 이름(기본 음원 파일 이름)")
    # 정리 기준값 덮어쓰기
    p.add_argument("--min-note-ms", type=float, default=None)
    p.add_argument("--ghost-ratio", type=float, default=None, help="배음 가짜 음 제거 기준(높을수록 엄격)")
    p.add_argument("--conf-min", type=float, default=None)
    p.add_argument("--onset-threshold", type=float, default=0.5, help="Basic Pitch 음 시작 민감도(낮을수록 많이 잡음)")
    p.add_argument("--frame-threshold", type=float, default=0.3)
    p.add_argument("--reattack", type=float, default=0.0,
                   help="실험: 음이 울리는 동안 음 시작 확률이 이 값 이상인 봉우리에서 음을 쪼갬(예: 0.6). 가짜 분리가 많아 기본 0 = 끔")
    p.add_argument("--max-fret", type=int, default=None)
    p.add_argument("--offset-ms", type=float, default=0.0,
                   help="음원을 N ms 앞당겨 읽음(분리 트랙이 원곡과 어긋날 때). 보통은 --grid-offset 를 쓴다")
    p.add_argument("--grid-offset", default="auto",
                   help="멜로디가 비트보다 늦게/빠르게 연주될 때 격자를 옮김(ms, 양수 = 연주가 늦음). auto = 멜로디로 추정")
    p.add_argument("--swing", choices=["auto", "on", "off"], default="auto",
                   help="스윙 격자(뒷박 8분음표 = 박의 2/3). auto = 뒷박 위치로 감지")
    p.add_argument("--phrase-offset", choices=["on", "off"], default="on",
                   help="프레이즈 단위로 오프셋을 따로 추정해 격자에 반영(기본 on)")
    p.add_argument("--phrase-bars", type=int, default=3, help="프레이즈 창 길이(마디, 기본 3; 1마디씩 이동)")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    with open(args.weights, "rb") as f:
        cfg = tomllib.load(f)
    if args.min_note_ms is not None: cfg["clean"]["min_note_ms"] = args.min_note_ms
    if args.conf_min is not None: cfg["clean"]["conf_min"] = args.conf_min
    if args.max_fret is not None: cfg["fingering"]["max_fret"] = args.max_fret

    audio = Path(args.audio).expanduser()
    if not audio.exists():
        print(f"파일 없음: {audio}", file=sys.stderr); return 1
    name = args.name or audio.stem
    out = args.out or (HERE / "out" / name)
    out.mkdir(parents=True, exist_ok=True)
    open_midis = parse_tuning(args.tuning)
    total = duration_of(audio)
    end = min(args.end, total) if args.end else total
    print(f"▶ {audio.name}  구간 {args.start:.1f}~{end:.1f}s  source={args.source}  tuning={args.tuning} capo={args.capo}")

    # 1. 분리
    #   스템 게이트(기본): 믹스에서 음을 뽑고 기타/나머지 스템 에너지로 반주를 걸러낸다 → 6스템 전부 필요
    #   게이트 off: 예전 방식(대상 스템에서 바로 음 추출)
    from .separate import find_stem, find_all_stems, separate, separate_all
    src = audio
    stems: dict = {}
    gate = args.stem_gate
    if args.stems:
        stems = find_all_stems(args.stems)
    if gate == "auto":
        gate = "off" if (args.no_separate and not args.stems) else "soft"
    if gate in ("soft", "hard") and args.source == "guitar":
        if "guitar" not in stems or not any(k in stems for k in ("piano", "other", "bass")):
            if args.no_separate:
                print("① 분리: 스템이 없어 게이트를 끕니다 (--stems 로 폴더를 주거나 --no-separate 를 빼세요)"); gate = "off"
            else:
                print("① 분리: Demucs 6스템 (스템 게이트용)")
                stems = separate_all(audio, out / "stems", device=args.device)
        if gate in ("soft", "hard"):
            print(f"① 음은 믹스에서 뽑고, 기타 스템 vs {'+'.join(k for k in stems if k not in ('guitar', 'drums'))} 스템 에너지로 반주를 가려냄 ({gate}, 기준 {args.gate_ratio})")
    if gate not in ("soft", "hard"):
        if args.stems:
            found = find_stem(args.stems, args.source)
            if not found:
                print(f"--stems 폴더에서 {args.source} 트랙을 못 찾음: {args.stems}", file=sys.stderr); return 1
            src = found
            print(f"① 분리: 기존 스템 재사용 → {src}")
        elif args.no_separate:
            print("① 분리: 건너뜀 (--no-separate)")
        else:
            print(f"① 분리: Demucs ({args.source})")
            src = separate(audio, args.source, out / "stems", device=args.device)
            print(f"   분리 트랙 → {src}")

    # 구간 자르기
    y, sr = load_audio(src, sr=SR, start=args.start, end=end)
    # 박자 추적과 혼합 wav는 분리 전 원곡으로(분리된 트랙만으로는 비트가 불안정)
    y_orig = y
    if src != audio:
        y_orig = load_audio(audio, sr=SR, start=args.start, end=end)[0]
        lag, cor = measure_lag(y_orig, y, sr)        # Demucs MP3 스템은 인코더 지연(≈25ms)으로 늦다
        if abs(lag) >= 0.002 and cor > 0.3:
            y = shift_audio(y, lag, sr)
            print(f"   스템이 원본보다 {lag * 1000:+.0f}ms 늦어 맞춤 (상관 {cor:.2f})")
    if args.offset_ms:
        y = shift_audio(y, args.offset_ms / 1000, sr)
    seg_wav = out / "segment.wav"
    write_wav(seg_wav, y, sr)
    seg_dur = len(y) / sr

    # 2. 음 추출
    print("② 음 추출: Basic Pitch", end="", flush=True)
    raw, backend = transcribe(seg_wav, onset_threshold=args.onset_threshold, frame_threshold=args.frame_threshold,
                              min_note_ms=min(cfg["clean"]["min_note_ms"], 60), midi_out=out / "notes_raw.mid",
                              reattack_threshold=args.reattack)
    print(f" ({backend}) → 음 {len(raw)}개")
    gate_stats = None
    if gate in ("soft", "hard") and args.source == "guitar":
        from .stemgate import gate_notes
        g = load_audio(stems["guitar"], sr=SR, start=args.start, end=end)[0]
        lag, cor = measure_lag(y_orig, g, sr)
        others = None
        for k, pth in stems.items():
            if k in ("guitar", "drums"):
                continue
            o = load_audio(pth, sr=SR, start=args.start, end=end)[0]
            others = o if others is None else others[: len(o)] + o[: len(others)]
        if abs(lag) >= 0.002 and cor > 0.3:
            g = shift_audio(g, lag, sr); others = shift_audio(others, lag, sr)
        raw, gate_stats = gate_notes(raw, g, others, sr, ratio_min=args.gate_ratio, mode=gate)
        if gate == "hard":
            print(f"   스템 게이트(hard): {gate_stats['input']}개 중 반주로 판정 {gate_stats['dropped_accomp']}개 제거, 판단 보류 {gate_stats['unsure']}개 → {gate_stats['kept']}개")
        else:
            print(f"   스템 게이트(soft): {gate_stats['input']}개 중 반주 쪽(비율<{args.gate_ratio}) {gate_stats['low_ratio_kept']}개는 멜로디 선택에서 감점, 판단 보류 {gate_stats['unsure']}개")

    # 3. 음원 성격
    an = analyze(y, sr, raw)
    print("③ 음원 성격 판단")
    print(describe(an))
    with open(out / "analysis.json", "w") as f:
        json.dump(an, f, ensure_ascii=False, indent=1)
    ghost = args.ghost_ratio if args.ghost_ratio is not None else an["recommend"]["ghost_ratio"]
    cfg["clean"]["ghost_ratio"] = ghost
    mode = args.mode if args.mode != "auto" else an["recommend"]["mode"]
    modes = ["top", "poly"] if mode == "both" else [mode]
    cfg["melody"]["pick"] = args.pick or ("loudest" if an["texture"] == "mono" else "highest")
    print(f"   적용: 모드 {modes}, 멜로디 선택 {cfg['melody']['pick']}, ghost_ratio {ghost}")

    # 4. 박자
    grid = track_beats(y_orig, sr, bpm=args.bpm, beats_per_bar=args.beats_per_bar)
    if args.bar_offset:
        grid.downbeat_phase += args.bar_offset
    if grid.source == "fixed" and raw:
        import numpy as np
        errs = np.array([grid.quantize(n.start)[2] for n in raw if n.conf >= cfg["clean"]["conf_min"]])
        med = float(np.median(errs)) if len(errs) else 0.0
        if abs(med) > 0.003:
            grid.beat_times = grid.beat_times + med
            grid.notes.append(f"격자를 음 시작 중심으로 {med * 1000:+.0f}ms 미세 보정")
    # 느낌(오프셋·스윙) 추정: 멜로디 한 줄을 미리 뽑아 그 음 시작으로 계산
    lo_tmp, hi_tmp = open_midis[0] + args.capo, open_midis[-1] + cfg["fingering"]["max_fret"]
    pre, _ = clean(raw, cfg, "top", grid, lo_tmp, hi_tmp, cfg["clean"]["low_conf"], do_quantize=False)
    feel = estimate_feel([(n.start, n.conf * min(n.dur, 0.5), n.dur) for n in pre if n.dur >= 0.12], grid)
    if args.grid_offset == "auto":
        goff = feel["offset"]
    else:
        goff = float(args.grid_offset) / 1000
    if abs(goff) >= 0.005:
        grid.beat_times = grid.beat_times + goff
        grid.notes.append(f"격자 오프셋 {goff * 1000:+.0f}ms ({'멜로디로 추정' if args.grid_offset == 'auto' else '지정'}; 양수 = 연주가 비트보다 늦음)")
    grid.swing = feel["swing"] if args.swing == "auto" else (args.swing == "on")
    medtxt = f"{feel['offbeat_median']:.2f}" if feel["offbeat_median"] is not None else "-"
    grid.notes.append(f"{'스윙' if grid.swing else '직선'} 격자 (보정 후 뒷박 음 중앙값 위치 {medtxt}; 0.5 = 직선, 0.67 = 스윙)")
    if args.phrase_offset == "on":
        onsets = [(n.start, n.conf * min(n.dur, 0.5), n.dur) for n in pre if n.dur >= 0.12]
        local = estimate_local_offsets(onsets, grid, grid.swing, goff, window_bars=args.phrase_bars,
                                       hop_bars=max(1, args.phrase_bars // 2))
        apply_local_offsets(grid, local, args.phrase_bars)
        hop = max(1, args.phrase_bars // 2)
        acc = [(b0 + 1, o, m) for _, o, _, b0, m in local if abs(o) >= 0.005]
        if acc:
            grid.notes.append(f"프레이즈 오프셋(전체 대비, 채택된 창만; 창 {args.phrase_bars}마디): "
                              + " ".join(f"{b}~{b + args.phrase_bars - 1}마디 {o * 1000:+.0f}ms(우위 {m:.2f})" for b, o, m in acc))
        else:
            grid.notes.append("프레이즈 오프셋: 근거가 확실한 창 없음(전체 오프셋만 적용)")
    n_bars = grid.bar_count(seg_dur)
    print(f"④ 박자: {grid.bpm:.1f} BPM ({grid.source}), {n_bars}마디")
    for s in grid.notes:
        print("   ·", s)

    lo = open_midis[0] + args.capo
    hi = open_midis[-1] + cfg["fingering"]["max_fret"]
    tuning_names = [NOTE_NAMES[m % 12] for m in open_midis]
    results = {}
    for m in modes:
        # 5. 정리
        notes, st = clean(raw, cfg, m, grid, lo, hi, cfg["clean"]["low_conf"])
        # 6. 운지 (포지션: 숫자 / auto / none)
        if args.position == "auto":
            position, ranking = suggest_position(notes, open_midis, args.capo, cfg["fingering"], grid=grid)
            print(f"   포지션 자동 제안: {position}프렛 (후보 비용: " + ", ".join(f"{p}→{c}" for p, c in ranking[:4]) + " …)")
        elif args.position == "none":
            position = None
        else:
            position = int(args.position)
        fs = assign_fingering(notes, open_midis, args.capo, cfg["fingering"], position=position, grid=grid)
        fs["position"] = position
        n_bars = max(n_bars, max((n.bar + 1 for n in notes), default=0))
        print(f"⑤⑥ [{m}] 정리: " + ", ".join(f"{k} {v}" for k, v in st.items())
              + f"\n       운지: " + ", ".join(f"{k} {v}" for k, v in fs.items()))
        # 7. 출력
        title = f"{name} [{m}] {args.start:.0f}-{end:.0f}s"
        text = render(notes, n_bars, grid.sub, tuning_names, capo=args.capo, title=title)
        (out / f"{m}.tab.txt").write_text(text + "\n", encoding="utf-8")
        data = {"name": name, "mode": m, "source": args.source, "start": args.start, "end": end,
                "bpm": grid.bpm, "beats_per_bar": grid.beats_per_bar, "beat_source": grid.source, "swing": grid.swing,
                "bar_start_s": grid.time_of(0, 0) - cfg["synth"].get("lead_ms", 0) / 1000, "tuning": args.tuning, "capo": args.capo,
                "n_bars": n_bars, "clean_stats": st, "fingering_stats": fs, "gate_stats": gate_stats,
                "bars": [{"n": b + 1, "notes": [n.to_dict() for n in notes if n.bar == b]} for b in range(n_bars)]}
        with open(out / f"{m}.json", "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        try:
            write_gp5(str(out / f"{m}.gp5"), notes, n_bars, grid.bpm, open_midis, args.capo, grid.beats_per_bar, title)
        except Exception as e:   # 출력 하나가 실패해도 나머지는 남긴다
            print(f"   ⚠ GP5 저장 실패: {e}")
        write_musicxml(str(out / f"{m}.musicxml"), notes, n_bars, grid.bpm, open_midis, args.capo, grid.beats_per_bar, title)
        synth = synthesize(notes, grid, seg_dur, sr, cfg["synth"])
        write_wav(out / f"{m}.synth.wav", synth, sr)
        write_wav(out / f"{m}.mix.wav", mix(y_orig, synth, cfg["synth"]), sr)
        lag = check_lag(y_orig, synth, sr)
        print(f"   확인: 합성 음이 원본보다 {lag * 1000:+.0f}ms (±15ms 밖이면 weights.toml [synth] lead_ms 조절)")
        results[m] = text
        print(f"   → {out / (m + '.tab.txt')} · .json · .gp5 · .musicxml · .synth.wav · .mix.wav")

    for m, text in results.items():
        print(f"\n═══ {m} ═══\n{text}")
    print(f"\n완료: {out}")
    return 0
