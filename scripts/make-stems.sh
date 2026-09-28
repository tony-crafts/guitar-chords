#!/usr/bin/env bash
# make-stems.sh — 영상/음원 → 스템 모드용 4트랙 MP3 (드럼 · 베이스 · 기타 · 보컬외)
#
#   scripts/make-stems.sh <영상|음원> <곡이름> [앞에서 자를 초]
#   예) scripts/make-stems.sh ~/Downloads/용의자.mp4 용의자 5
#
# 출력: ~/Desktop/stems/<곡이름>-4트랙/{1-드럼,2-베이스,3-기타,4-보컬외}.mp3 (320k · 44.1k · 스테레오)
#
# 과정
#   1) ffmpeg로 오디오 추출(선택: 앞 N초 자름)
#   2) Demucs htdemucs_6s(6트랙) 분리 — 이 환경의 torchaudio는 WAV 저장이 안 돼서 MP3로 받음
#   3) 4-보컬외 = vocals + piano + other (amix normalize=0 → 레벨 유지)
#   4) 4트랙 모두 같은 ffmpeg 경로로 재인코딩 + 앞 1104샘플(≈25ms, MP3 인코더 지연) 제거
#      → 트랙끼리 샘플 단위로 맞고, 원본 시각과도 맞음
#   5) 검증: 4트랙 합 vs 원본 상호상관(구간 3곳) — 어긋남 ms와 상관계수 출력
#
# 환경변수
#   DEMUCS_VENV  Demucs 가상환경 (기본 ~/.venvs/demucs)
#   STEMS_DIR    출력 상위 폴더 (기본 ~/Desktop/stems)
#   DEVICE       mps | cpu (기본 mps)
set -euo pipefail

if [[ $# -lt 2 ]]; then
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

SRC=$1
NAME=$2
TRIM=${3:-0}
VENV=${DEMUCS_VENV:-$HOME/.venvs/demucs}
OUT=${STEMS_DIR:-$HOME/Desktop/stems}/$NAME-4트랙
DEVICE=${DEVICE:-mps}
DELAY=1104   # 44.1kHz 기준 MP3 인코더 지연(실측 25ms)

[[ -f $SRC ]] || { echo "입력 파일 없음: $SRC" >&2; exit 1; }
[[ -x $VENV/bin/demucs ]] || { echo "Demucs 없음: $VENV (DEMUCS_VENV로 지정)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg 필요" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/make-stems.XXXXXX")
echo "작업 폴더: $WORK"

echo "① 오디오 추출 (앞 ${TRIM}초 자름)"
ffmpeg -v error -y -ss "$TRIM" -i "$SRC" -vn -ac 2 -ar 44100 "$WORK/src.wav"

echo "② Demucs htdemucs_6s 분리 ($DEVICE)"
"$VENV/bin/demucs" -n htdemucs_6s -d "$DEVICE" --mp3 --mp3-bitrate 320 -o "$WORK/sep" "$WORK/src.wav" \
  2>&1 | grep -v '%|' || true
D=$WORK/sep/htdemucs_6s/src
for s in drums bass guitar vocals piano other; do
  [[ -f $D/$s.mp3 ]] || { echo "분리 실패: $s.mp3 없음" >&2; exit 1; }
done

echo "③④ 4트랙 인코딩 → $OUT"
mkdir -p "$OUT"
ENC=(-c:a libmp3lame -b:a 320k -ar 44100 -ac 2)
TRIMF="atrim=start_sample=$DELAY,asetpts=N/SR/TB"
ffmpeg -v error -y -i "$D/drums.mp3"  -af "$TRIMF" "${ENC[@]}" "$OUT/1-드럼.mp3"
ffmpeg -v error -y -i "$D/bass.mp3"   -af "$TRIMF" "${ENC[@]}" "$OUT/2-베이스.mp3"
ffmpeg -v error -y -i "$D/guitar.mp3" -af "$TRIMF" "${ENC[@]}" "$OUT/3-기타.mp3"
ffmpeg -v error -y -i "$D/vocals.mp3" -i "$D/piano.mp3" -i "$D/other.mp3" \
  -filter_complex "amix=inputs=3:normalize=0:duration=longest,$TRIMF" "${ENC[@]}" "$OUT/4-보컬외.mp3"

echo "⑤ 검증"
for f in "$OUT"/*.mp3; do
  printf '  %-14s %s s\n' "$(basename "$f")" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
done
ffmpeg -v error -y -i "$OUT/1-드럼.mp3" -i "$OUT/2-베이스.mp3" -i "$OUT/3-기타.mp3" -i "$OUT/4-보컬외.mp3" \
  -filter_complex "amix=inputs=4:normalize=0" -ac 1 -ar 22050 -f s16le "$WORK/sum.raw"
ffmpeg -v error -y -i "$WORK/src.wav" -ac 1 -ar 22050 -f s16le "$WORK/orig.raw"
"$VENV/bin/python" - "$WORK/orig.raw" "$WORK/sum.raw" <<'PY'
import sys, numpy as np
a = np.fromfile(sys.argv[1], dtype=np.int16).astype(float)
b = np.fromfile(sys.argv[2], dtype=np.int16).astype(float)
sr, L = 22050, 10
n = min(len(a), len(b)) / sr
bad = False
for t in (n * 0.1, n * 0.5, n * 0.85):
    s = int(t * sr); x = a[s:s + L * sr]
    k = max(range(-1500, 1501), key=lambda k: np.dot(x, b[s + k:s + k + L * sr]))
    c = np.corrcoef(x, b[s + k:s + k + L * sr])[0, 1]
    ms = k / sr * 1000
    bad |= abs(ms) > 2 or c < 0.9
    print(f"  {t:6.1f}s  어긋남 {ms:+.2f}ms  상관 {c:.3f}")
print("  → 싱크 OK" if not bad else "  → ⚠ 어긋남/상관 이상 — 확인 필요")
PY

echo "완료: $OUT"
echo "(중간 결과물: $WORK — 필요 없으면 지워도 됨)"
