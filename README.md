# guitar-chords

연주용 기타 코드 차트 모음. 정적 사이트(빌드 불필요).

- `index.html` — 곡 목록
- `chords/<song>.html` — 곡별 코드 차트 (컴팩트 / 펼침 / 유튜브 플레이어 동기화)
- `docs/` — 사양 문서

## 곡 추가

1. `chords/<song>.html` 추가
2. `index.html`의 `.song` 블록을 복사해 `href` / 제목 / 부제 수정

## 배포

Vercel 등 정적 호스팅에 저장소를 그대로 연결. 빌드 명령·출력 디렉터리 설정 없음(루트 서빙).
