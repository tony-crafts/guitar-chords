#!/usr/bin/env python3
"""tab-pages.py — TAB 악보 영상에서 '페이지(한 화면)'마다 대표 프레임 1장을 뽑는다.

동작
  1) TAB 오버레이 영역만 잘라 초당 N장 샘플링, 밝은 글자/선만 이진화한다.
  2) 연속 프레임 차이가 크면 '내용이 바뀐 지점'으로 보고 구간을 나눈다.
  3) 같은 페이지가 반복되면(벌스 ×2 등) 화면이 거의 안 바뀌어 한 구간으로 뭉친다.
     → 구간 길이를 '한 페이지 길이'로 나눠 여러 페이지로 쪼갠다.
       한 페이지 길이 = --bpm(4마디 기준) 또는 구간 길이 분포에서 추정.
  4) 정수배로 안 떨어지는 구간(예: 한 화면에 5마디)은 ← 표시로 알려 준다.
     이런 페이지는 사람이/모델이 반드시 마디 수를 직접 세어 확인할 것.

의존성: ffmpeg/ffprobe, Python 3 표준 라이브러리만.

사용:
  scripts/tab-pages.py <영상> <출력폴더> [--bpm 109] [--bars 4] [--crop 0.727:0.995]
    --crop  TAB 영역의 세로 범위(0~1 비율, 기본값 = 1080p 기준 785~1075px)
  출력: <출력폴더>/p00.jpg … (페이지별), g0.jpg … (3장 세로 묶음), pages.tsv (시각표)
"""
import argparse, os, subprocess, sys

W, H = 192, 32   # 비교용 축소 크기(글자 위치만 보면 됨)
BRIGHT = 200     # 원본 해상도에서 이 밝기 이상 = TAB 글자/선 (배경 영상은 반투명 어둡게 깔림)
INK = 24         # 축소 후 이 값 이상이면 '글자 있는 칸'


def probe(video):
    out = subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration', '-of', 'default=nw=1', video
    ], text=True)
    d = dict(l.split('=', 1) for l in out.split())
    return int(d['width']), int(d['height']), float(d['duration'])


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video'); ap.add_argument('outdir')
    ap.add_argument('--crop', default='0.727:0.995')
    ap.add_argument('--fps', type=float, default=2)
    ap.add_argument('--bpm', type=float, help='곡 템포. 주면 한 페이지 길이를 bars×4박으로 계산')
    ap.add_argument('--bars', type=int, default=4, help='한 페이지 기본 마디 수(기본 4)')
    ap.add_argument('--thresh', type=float, default=0.04, help='내용 변화로 볼 픽셀 변화 비율')
    ap.add_argument('--min-page', type=float, default=3.0, help='글자가 이보다 짧게 보이면 무시(초)')
    a = ap.parse_args()

    vw, vh, dur = probe(a.video)
    r0, r1 = (float(x) for x in a.crop.split(':'))
    y0, ch = int(vh * r0), int(vh * (r1 - r0))
    crop = f'crop={vw}:{ch}:0:{y0}'
    os.makedirs(a.outdir, exist_ok=True)

    raw = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', a.video,
        '-vf', f"fps={a.fps},{crop},format=gray,lut=y='if(gte(val,{BRIGHT}),255,0)',scale={W}:{H}:flags=area",
        '-f', 'rawvideo', '-'
    ])
    N = W * H
    n = len(raw) // N
    frames = [bytes(1 if p >= INK else 0 for p in raw[i*N:(i+1)*N]) for i in range(n)]
    inked = [sum(f) / N >= 0.01 for f in frames]

    # 1) 내용 변화 지점으로 구간 나누기
    cuts = [0]
    for i in range(1, n):
        diff = sum(x != y for x, y in zip(frames[i], frames[i-1])) / N
        if diff > a.thresh and (i - cuts[-1]) / a.fps >= 1.0:
            cuts.append(i)
    cuts.append(n)

    # 구간마다 '글자가 보이는' 프레임 범위만 남김(앞뒤 타이틀·암전 제외)
    segs = []
    for s, e in zip(cuts, cuts[1:]):
        idx = [i for i in range(s, e) if inked[i]]
        if len(idx) / a.fps < a.min_page:
            continue
        segs.append((idx[0] / a.fps, (idx[-1] + 1) / a.fps))

    # 2) 한 페이지 길이
    if a.bpm:
        page = a.bars * 4 * 60 / a.bpm
    else:
        rough = median([t1 - t0 for t0, t1 in segs])
        page = median([t1 - t0 for t0, t1 in segs if 0.7 * rough <= t1 - t0 <= 1.3 * rough]) or rough

    # 3) 긴 구간은 페이지 길이로 쪼갬
    pages = []   # (start, end, 경고)
    for t0, t1 in segs:
        ratio = (t1 - t0) / page
        k = max(1, round(ratio))
        warn = ''
        if abs(ratio - k) > 0.15:
            bars = (t1 - t0) / page * a.bars
            warn = f'길이 {t1-t0:.1f}s ≈ {bars:.1f}마디 — 마디 수 직접 확인'
        if k > 1 and not warn:
            warn_k = f'같은 화면 {k}회 반복으로 추정'
        else:
            warn_k = ''
        step = (t1 - t0) / k
        for j in range(k):
            pages.append((t0 + j * step, t0 + (j + 1) * step, warn or warn_k))

    with open(os.path.join(a.outdir, 'pages.tsv'), 'w') as f:
        f.write('page\tstart\tend\tlen\tnote\n')
        for k, (t0, t1, note) in enumerate(pages):
            f.write(f'{k:02d}\t{t0:.1f}\t{t1:.1f}\t{t1-t0:.1f}\t{note}\n')
            subprocess.run([
                'ffmpeg', '-v', 'error', '-y', '-ss', f'{(t0 + t1) / 2:.2f}', '-i', a.video,
                '-frames:v', '1', '-vf', crop, '-q:v', '2',
                os.path.join(a.outdir, f'p{k:02d}.jpg')], check=True)

    # 3장씩 세로 묶음(판독용)
    for g in range(0, len(pages), 3):
        imgs = [os.path.join(a.outdir, f'p{k:02d}.jpg') for k in range(g, min(g + 3, len(pages)))]
        out = os.path.join(a.outdir, f'g{g//3}.jpg')
        cmd = ['ffmpeg', '-v', 'error', '-y']
        for p in imgs: cmd += ['-i', p]
        cmd += (['-filter_complex', f'vstack={len(imgs)}'] if len(imgs) > 1 else []) + ['-q:v', '2', out]
        subprocess.run(cmd, check=True)

    src = f'bpm {a.bpm:g}' if a.bpm else '구간 길이에서 추정'
    print(f'{len(pages)} pages · 영상 {dur:.1f}s · 한 페이지 {page:.2f}s ({src})')
    for k, (t0, t1, note) in enumerate(pages):
        print(f'p{k:02d}  {t0:6.1f} – {t1:6.1f}  ({t1-t0:4.1f}s)' + (f'  ← {note}' if note else ''))


if __name__ == '__main__':
    sys.exit(main())
