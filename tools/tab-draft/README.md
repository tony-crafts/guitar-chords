# tab-draft — 음원 → 기타 멜로디 타브 초안

음원 파일(또는 그 일부 구간)을 넣으면 **사람이 고쳐 쓰기 쉬운 타브 초안**을 만든다.
완벽한 채보가 아니라 "귀로 확인하면서 고칠 출발점"이 목표다.

한 번 실행하면 이런 파일이 나온다 (`out/<이름>/`):

| 파일 | 용도 |
|---|---|
| `top.tab.txt` / `poly.tab.txt` | 텍스트 타브(메모장에서 바로 읽음). `( )` = 신뢰도 낮은 음 |
| `*.gp5` | Guitar Pro 5 — TuxGuitar(무료), MuseScore에서 열어 편집 |
| `*.musicxml` | MusicXML — MuseScore 등에서 열림 |
| `*.json` | 정본 데이터(마디별 음·줄·프렛·신뢰도). 나중에 앱에 붙일 때 이걸 쓴다 |
| `*.synth.wav` | 뽑은 멜로디를 기타 비슷한 소리로 합성 |
| `*.mix.wav` | 원곡 + 합성 멜로디를 겹친 소리 — 귀로 틀린 곳 찾기용 |
| `analysis.json` | 음원 성격 판단 결과(단선율/다성, 디스토션/클린) |
| `notes_raw.mid` | 정리 전 Basic Pitch 원본 MIDI |
| `segment.wav` | 실제로 분석한 구간(분리했으면 분리된 트랙) |

`top` = 가장 높은 음 한 줄만 남긴 멜로디, `poly` = 동시에 울리는 음을 모두 유지(코드+멜로디).
음원이 단선율이면 `top`만, 코드와 멜로디가 섞였으면 둘 다 나온다.

## 설치 (처음 한 번)

Python 3.12와 ffmpeg가 필요하다 (`brew install python@3.12 ffmpeg`).
Demucs 가상환경(`~/.venvs/demucs`, `scripts/make-stems.sh`와 공용)은 음원 분리를 쓸 때만 필요하다.

```bash
/opt/homebrew/bin/python3.12 -m venv ~/.venvs/tab
~/.venvs/tab/bin/pip install -U pip wheel
~/.venvs/tab/bin/pip install --no-deps basic-pitch==0.4.0     # 의존성 선언이 3.12와 안 맞아 따로 설치
~/.venvs/tab/bin/pip install -r tools/tab-draft/requirements.txt
```

확인: `~/.venvs/tab/bin/python -c "import basic_pitch.inference, guitarpro, librosa; print('ok')"`

## 실행

```bash
~/.venvs/tab/bin/python tools/tab-draft/tab-draft.py <음원> [옵션]
```

처음에는 짧은 구간(15~30초)으로 돌려 보고, 괜찮으면 전체를 돌린다.

```bash
# 기타 단독 녹음, 앞 20초
~/.venvs/tab/bin/python tools/tab-draft/tab-draft.py ~/Music/연습.mp3 --no-separate --end 20

# 원곡에서 리드 기타 라인 (Demucs htdemucs_6s로 기타 트랙 분리)
~/.venvs/tab/bin/python tools/tab-draft/tab-draft.py ~/Music/원곡.mp3 --source guitar --start 30 --end 60 --bpm 109

# 노래 멜로디를 기타로 (보컬 트랙 분리), 5프렛 근처 선호
~/.venvs/tab/bin/python tools/tab-draft/tab-draft.py ~/Music/원곡.mp3 --source vocal --end 30 --position 5
```

### 옵션

| 옵션 | 뜻 |
|---|---|
| `--source vocal\|guitar` | 어떤 멜로디를 뽑을지 (기본 guitar) |
| `--start`, `--end` | 구간(초). `--end` 생략 = 끝까지 |
| `--capo N` | 카포. 프렛 숫자는 카포 기준으로 나옴 |
| `--tuning EADGBE` | 6번줄부터 줄 이름. `DADGBE`처럼 쓰거나 MIDI 숫자 6개 |
| `--bpm` | 템포를 알면 지정 — 박자 정렬이 훨씬 안정됨 |
| `--beats-per-bar` | 한 마디 박 수(기본 4) |
| `--bar-offset N` | 첫 마디 위치가 틀렸을 때 박 단위로 보정 |
| `--grid-offset auto\|N` | 멜로디가 비트보다 늦게/빠르게 연주될 때 격자를 N ms 옮김(양수 = 연주가 늦음). 기본 auto = 멜로디 음 시작으로 추정 |
| `--swing auto\|on\|off` | 스윙 격자(뒷박 8분음표 = 박의 2/3 지점). 기본 auto = 뒷박 위치 분포로 감지 |
| `--phrase-offset on\|off` | 프레이즈(창) 단위로 오프셋을 따로 추정해 격자에 반영(기본 on). 근거가 확실한 창만 채택 |
| `--phrase-bars N` | 프레이즈 창 길이(마디, 기본 3; 1마디씩 이동) |
| `--position auto\|N\|none` | 손 범위 창의 시작 프렛. 창(N~N+4) 밖 음에 벌점. 기본 auto = 멜로디가 한 손 범위에 가장 잘 들어가는 자리를 자동 제안(실행 로그에 후보 비용 표시), none = 선호 없음 |
| `--mode auto\|top\|poly\|both` | 멜로디 한 줄 / 동시 음 유지 / 둘 다 (기본 auto = 음원 성격으로 결정) |
| `--pick highest\|loudest` | top 모드에서 멜로디 고르는 기준 |
| `--no-separate` | 음원 분리 건너뜀(기타 단독 녹음 등) |
| `--stems 폴더` | 이미 Demucs로 분리한 폴더가 있으면 재사용(`make-stems` 4트랙 폴더도 됨) |
| `--stem-gate off\|auto\|soft\|hard` | 실험 기능. 믹스에서 음을 뽑고, 음마다 기타 스템 vs 나머지 스템(피아노·베이스…) 에너지 비율로 반주를 가려냄. soft = 멜로디 선택에서 감점만, hard = 기준 미만 음 제거(`--gate-ratio`, 기본 0.5). 6스템 분리가 필요하고, Demucs가 기타 멜로디를 피아노로 보낸 구간은 같이 틀리므로 기본 off |
| `--ghost-ratio` | 배음 가짜 음 제거 기준. 높을수록 엄격(디스토션이면 자동으로 0.85) |
| `--min-note-ms` | 이보다 짧은 음은 버림(기본 60) |
| `--conf-min` | 이보다 신뢰도 낮은 음은 버림(기본 0.25) |
| `--onset-threshold` | Basic Pitch 음 시작 민감도(기본 0.5, 낮추면 더 많이 잡음) |
| `--reattack N` | 실험: 음이 울리는 동안 음 시작 확률 봉우리(N 이상)에서 음을 쪼갬. 가짜 분리가 많아 기본 0(끔). 같은 음 다시 치기는 보통 Basic Pitch가 이미 나누며, 도구는 간격 0으로 맞닿은 같은 음을 합치지 않는다 |
| `--offset-ms N` | 음원 자체를 N ms 앞당겨 읽음(분리 트랙이 원곡과 어긋날 때). 보통은 `--grid-offset`을 쓴다 |
| `--weights 파일` | 벌점·기준값 설정 파일(기본 `weights.toml`) |
| `--out`, `--name` | 출력 폴더 / 이름 |

### 벌점 조절 — `weights.toml`

운지 선택은 "손 이동 거리 + 줄 건너뛰기 + 높은 프렛 + 포지션 이탈"에 벌점을 주고
전체 합이 가장 작은 경로를 고른다(동적 계획법). 가중치와 정리 기준값은 `weights.toml`에 있고
주석으로 뜻을 적어 두었다. 숫자를 바꾸고 다시 돌리면 된다.

### 결과 읽는 법

- `( )` 괄호 = 신뢰도 낮음. 윗줄 `o` = 음역 밖이라 옥타브를 옮긴 음, `!` = 동시 음이 한 손으로 안 잡힘, `~` = 프렛 폭이 넓음.
- 터미널에 찍히는 `③ 음원 성격 판단`을 먼저 본다. 판단이 틀렸으면 `--mode`, `--ghost-ratio`로 바로잡는다.
- `④ 박자`의 첫 마디 시작 시각이 틀리면 `--bar-offset` 또는 `--bpm`으로 보정.
- `④ 박자`에 `격자 오프셋 +140ms`, `스윙 격자`처럼 나오면 멜로디가 반주 비트보다 뒤에서(laid-back) 스윙으로 연주된다고 판단한 것. 틀리면 `--grid-offset 0`, `--swing off`.
- `프레이즈 오프셋 … 19~21마디 -195ms(우위 0.45)`는 그 프레이즈만 전체와 다르게(여기선 제때) 쳤다고 본 것. "우위"는 0 대비 점수 이득(0.3 이상만 채택). 혼합 wav로 그 구간을 들어 보고 아니면 `--phrase-offset off`.
- 멜로디 한 줄(top) 모드에서 반주 음이 섞여 들어오면 `weights.toml`의 `top_conf_min`(기본 0.5)을 올리고, 멜로디가 빠지면 내린다.
- 같은 음을 연달아 친 것이 한 음으로 붙어 나오면 `weights.toml`의 `merge_gap_ms`(끊긴 같은 음을 합치는 최대 무음 간격, 기본 80)를 줄인다. 맞닿은(간격 0) 같은 음은 합치지 않는다.
- 하행 선율의 낮은 음이 자꾸 빠지면 `w_sustain`(앞 음이 울리는 동안 새 음과 경쟁할 때 앞 음이 받는 감점, 기본 0.4)을 올리고, 멜로디 밑 베이스 음이 멜로디로 올라오면 내린다.
- `*.mix.wav`를 들으면서 틀린 음을 찾고 GP5/MusicXML에서 고친다.
- 합성 음이 원곡보다 늦게 들리면: 실행 끝의 `확인: 합성 음이 원본보다 ±Nms`를 보고 `weights.toml`의 `[synth] lead_ms`를 올린다(기본 0, 격자가 멜로디 음 시작에 자동으로 맞춰지므로 보통 0으로 충분).
- Demucs MP3 스템은 원본보다 약 25ms 늦게 나오는데, 도구가 원본과 상호상관으로 자동으로 맞춘다(`스템이 원본보다 +25ms 늦어 맞춤` 메시지).

## 정확도 평가 (정답 운지가 있을 때)

직접 친 멜로디를 녹음하고 운지를 적어 두면 비교할 수 있다.

```bash
~/.venvs/tab/bin/python tools/tab-draft/evaluate.py out/<이름>/top.json 정답.txt
```

정답 파일은 한 줄에 음 하나: `마디 박[.16분] 줄 프렛` (`#` 뒤는 주석).

```
1 1   2 11    # 1마디 1박, 2번줄 11프렛
1 2.3 1 12    # 1마디 2박의 세 번째 16분, 1번줄 12프렛
```

결과는 세 가지로 나눠 집계한다: **음 높이 일치율**, (음이 맞은 것 중) **박자 일치율**, (음·박이 맞은 것 중) **줄·프렛 일치율**.
음마다 `exact / fingering(운지만 다름) / timing(박자만 어긋남) / pitch(음 틀림) / missing / extra`로 판정한다.
초안 격자가 정답보다 밀린 경우는 자동으로 보정한다(`--shift`).

## 구조

```
tools/common/beats.py      박자·마디 격자(코드 추출 도구와 공용), 16분음표 양자화
tools/common/audio.py      ffmpeg 기반 오디오 읽기/쓰기
tools/tab-draft/tabdraft/
  transcribe.py            Basic Pitch(CoreML) 음 추출
  analyze.py               음원 성격 판단
  melody.py                가짜 음 제거 · 병합 · 비브라토 흡수 · 한 줄/다성 선택 · 음역 · 양자화
  fingering.py             줄·프렛 배치(동적 계획법) · 동시 음 운지 가능성 검사
  output_text.py / output_gp.py / output_xml.py   텍스트 타브 / GP5 / MusicXML
  synth.py                 확인용 합성·혼합 wav
  separate.py              Demucs 분리(기존 ~/.venvs/demucs 호출)
```

음원과 `out/` 산출물은 `.gitignore`로 제외된다.
