# guitar-chords

연주용 기타 코드 차트 모음. 정적 사이트(빌드 불필요).

- `index.html` — 곡 목록
- `chords/<song>.html` — 곡별 코드 차트 (컴팩트 / 펼침 / 유튜브 플레이어 동기화)
- `docs/` — 사양 문서

공용 모듈(`chords/`):

- `song-core.js` — 차트형 곡 페이지 전체(탭·키 전환·마디 싱크·박자 블록·자동 스크롤)
- `stem-engine.js` — 스템 모드 오디오 엔진 (Web Audio + IndexedDB)
- `practice.js` — 속도 조절 · A-B 루프 · 화면 꺼짐 방지(Wake Lock)
- `metronome.js` — 메트로놈 (Web Audio 클릭 합성)

JS를 고치면 이를 부르는 페이지의 `<script src="...?v=">` 값을 함께 올릴 것
(캐시 버스팅 — 수동).

## 곡 추가

1. `chords/<song>.html` 추가
2. `index.html`의 `.song` 블록을 복사해 `href` / 제목 / 부제 수정

## 배포

Vercel 등 정적 호스팅에 저장소를 그대로 연결. 빌드 명령·출력 디렉터리 설정 없음(루트 서빙).
