/* song-core.js — 차트형 곡 페이지 공용 템플릿/엔진
   곡 데이터 객체 하나를 받아 marigold 계열 페이지(컴팩트/펼침/플레이어 탭,
   키 전환, 플레이어 싱크, t0/BPM 캘리브레이션, 자동스크롤, 주법 배지,
   박자 블록, 메트로놈, 화면 꺼짐 방지, 반응형, 목록 링크)를 전부 생성·구동한다.
   practice.js(적응형 속도 + A-B 루프 + Wake Lock)에 의존하고,
   metronome.js가 있으면 메트로놈 컨트롤을 붙인다(없으면 조용히 생략).

   ── 곡 데이터 스키마 ─────────────────────────────────────────────
   {
     title, artist,               // 제목 / 아티스트
     videoId,                     // 유튜브 ID
     key:  { original, capo },    // 표시용 키 라벨(예: 'D' / 'C') — 참고용
     bpm,                         // 기본 ♩ (미세조정은 localStorage 저장)
     prefix,                      // localStorage 키 접두어(예: 'mg' → mg_bpm/mg_t0/mg_speed/mg_ab)
     meta:     { original, capo },// 헤더 메타 문자열(원키 / 카포)
     keyTabs:  { original, capo },// 키 전환 버튼 라벨
     chordList:{ original, capo },// 펼침 범례의 '사용 코드' 문자열(있으면 키 전환 시 갱신)
     capoMap,                     // { '원코드':'카포코드', ... } 반음 변환표
     backHref,                    // '‹ 목록' 링크(기본 '/index.html')
     // 아래 둘 중: compact/expanded를 직접 주거나, sections 하나만 주면 양 탭에 공용
     sections: [ Section ],       // (간단형) 연주 순서 한 벌
     compact:  { flow, blocks, legend },   // 컴팩트 탭
     expanded: { flow, blocks, legend }    // 펼침 탭  (block = Section | { jump:'<html>' })
   }

   Section = {
     name, color,                 // 이름 / 색상토큰(dim·verse·pre·cho·brg·qt·coda …)
     tech,                        // 'pm' | 'os' | null  (섹션 주법칩)
     meta,                        // 우측 마디수 등 텍스트
     repeat,                      // '×2' 같은 반복 배지(선택)
     pass,                        // 펼침 뷰 회차 번호(선택)
     rows: [ [barToken, …], … ],  // 한 줄 = 마디 배열
     note                         // '<html>' 주석(선택)
   }

   barToken(문자열):
     'Gb'                단일
     'Gb,F'              반반 분할(2)
     'Db,Dbsus4,Db'      3분할
     'D^add9'            코드 접미(<small>) — add9/sus4/7/9/maj7 은 붙여쓰기
     'D^𝄋' 'A^ToCoda'    마커 <small> — 그 외는 한 칸 띄어 표기
     끝에 '*'            원샷(◇, .os)  예: 'A*'  'Asus4,A*'  'D^끝*'
   ──────────────────────────────────────────────────────────────── */
window.SongCore = (function(){

  const CSS = `
:root{
  --bg:#14120e; --panel:#1c1913; --line:#35301f;
  --text:#ece4d2; --dim:#988e79; --gold:#f0a83a;
  --verse:#7fb4a8; --pre:#b08bc9; --cho:#f0a83a;
  --brg:#e07b5f; --qt:#8fa3c9; --coda:#c8bd6a;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--bg); color:var(--text);
  font-family:-apple-system,'Apple SD Gothic Neo','Pretendard',sans-serif;
  padding:10px 10px calc(20px + env(safe-area-inset-bottom));
  max-width:520px; margin:0 auto;
}
.back{display:inline-block; font-size:11.5px; color:var(--dim); text-decoration:none; margin-bottom:8px}
.back:hover{color:var(--gold)}
header{display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; padding:2px 2px 8px}
header h1{font-size:19px; letter-spacing:.5px; color:var(--gold); font-weight:800}
header .meta{font-size:11px; color:var(--dim); letter-spacing:.4px}
.tabs{display:flex; gap:6px; margin-bottom:8px}
.tabs button{
  flex:1; padding:9px 0; border-radius:8px; border:1px solid var(--line);
  background:var(--panel); color:var(--dim); font-size:13px; font-weight:700;
  letter-spacing:.3px; cursor:pointer;
}
.tabs button.on{background:var(--gold); border-color:var(--gold); color:#1a1508}
.flow{
  font-size:10.5px; color:var(--dim); line-height:1.7; letter-spacing:.2px;
  background:var(--panel); border:1px solid var(--line); border-radius:8px;
  padding:6px 9px; margin-bottom:8px;
}
.flow b{color:var(--gold); font-weight:700}
.sec{margin-bottom:7px; border-left:3px solid var(--c,var(--dim)); padding-left:7px}
.sec-h{display:flex; align-items:baseline; gap:6px; margin-bottom:3px}
.sec-h b{font-size:12.5px; color:var(--c,var(--text)); letter-spacing:.5px; font-weight:800}
.sec-h span{font-size:10.5px; color:var(--dim)}
.sec-h em{
  font-style:normal; font-size:10.5px; font-weight:800; color:var(--c,var(--gold));
  border:1px solid currentColor; border-radius:5px; padding:0 5px; margin-left:auto;
}
.row{
  display:grid; grid-template-columns:repeat(var(--n,4),1fr);
  border-top:1px solid var(--line); border-bottom:1px solid var(--line);
  margin-bottom:-1px;
}
.bar{
  position:relative;
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
  font-size:14.5px; font-weight:700; text-align:center; padding:5px 1px;
  border-right:1px solid var(--line); white-space:nowrap;
}
.bar:first-child{border-left:2px solid var(--line)}
.bar:last-child{border-right:2px solid var(--line)}
.bar small{font-size:10px; font-weight:600; color:var(--dim)}
.bar.split{display:grid; grid-template-columns:1fr 1fr; padding:0}
.bar.split3{grid-template-columns:1fr 1fr 1fr}
.bar.split i{font-style:normal; padding:5px 1px; font-size:12.5px}
.bar.split i:first-child{border-right:1px dashed var(--line)}
.bar.split3 i:nth-child(2){border-right:1px dashed var(--line)}
/* ---- 주법(3단계): 무표시=8비트 / P.M.=팜뮤트 8비트(섹션칩) / ◇=원샷(마디칩) ---- */
.sec-h .tech{
  font-style:normal; font-size:9.5px; font-weight:800; letter-spacing:.2px;
  border:1px solid currentColor; border-radius:4px; padding:1px 5px;
}
.tech.pm{color:var(--pre)}
.tech.os{color:var(--gold)}
.bar.os::after{
  content:'◇'; position:absolute; top:0; right:2px;
  font-size:8px; line-height:1.5; color:var(--gold); font-weight:400; pointer-events:none;
}
.bar.now.os::after{color:#5a4410}
.note{font-size:10.5px; color:var(--dim); padding:3px 1px 0; line-height:1.5}
.note b{color:var(--gold); font-weight:700}
.mark{color:var(--gold); font-weight:800}
.jump{
  background:var(--panel); border:1px dashed var(--gold); border-radius:8px;
  padding:7px 10px; font-size:11.5px; color:var(--text); margin-bottom:7px; line-height:1.55;
}
.jump b{color:var(--gold)}
.legend{
  margin-top:10px; padding:7px 9px; background:var(--panel);
  border:1px solid var(--line); border-radius:8px;
  font-size:10.5px; color:var(--dim); line-height:1.7;
}
.legend b{color:var(--text); font-family:ui-monospace,monospace}
.view{display:none}
.view.on{display:block}
.pass{
  font-size:10px; font-weight:800; color:var(--bg); background:var(--dim);
  border-radius:4px; padding:1px 5px; margin-right:2px;
}
footer{margin-top:12px; font-size:10px; color:#6b6250; line-height:1.6}

/* ===== 플레이어 ===== */
/* display:contents — #viewP가 박스를 만들지 않아야 내부 sticky가 body 기준으로 붙는다.
   (block이면 viewP 높이만큼만 sticky가 유지돼 차트 스크롤 시 플레이어가 사라짐) */
#viewP.on{display:contents}
.pwrap{
  position:sticky; top:0; z-index:20; background:var(--bg);
  padding-bottom:6px; margin-bottom:6px;
}
.pvid{
  position:relative; width:100%; aspect-ratio:16/9;
  background:#000; border:1px solid var(--line); border-radius:8px; overflow:hidden;
}
.pvid iframe{position:absolute; inset:0; width:100%; height:100%; border:0}
/* 소스 전환(유튜브 / 스템) — 스템은 로컬 저장 음원 */
.psrc{display:flex; gap:5px; margin-bottom:6px}
.psrc button{
  flex:1; padding:7px 0; border-radius:7px; border:1px solid var(--line);
  background:var(--panel); color:var(--dim); font-size:11.5px; font-weight:700;
  letter-spacing:.3px; cursor:pointer;
}
.psrc button.on{background:var(--gold); border-color:var(--gold); color:#1a1508}
body[data-src="stem"] .only-yt{display:none}
body[data-src="yt"]   .only-stem{display:none}
.pnow{
  margin-top:6px; padding:8px 12px;
  background:var(--panel); border:1px solid var(--line); border-radius:8px;
}
/* 1행: 현재 → 다음 코드. 양끝 배치, 화살표 가운데. 폰트는 길이 기반 축소 */
.prow1{
  display:grid; grid-template-columns:1fr auto 1fr; align-items:baseline; gap:6px;
  font-family:ui-monospace,'SF Mono',Menlo,monospace; font-weight:800;
  line-height:1.15; font-size:28px;
}
.prow1.sz-md{ font-size:22px; }
.prow1.sz-sm{ font-size:17px; }
.prow1 .pcode{ white-space:nowrap; }
.prow1 .now{ color:var(--gold); justify-self:start; }
/* 분할 마디에서 지금 연주 중인 쪽 코드만 또렷하게 (활성 정보가 있을 때만) */
.prow1 .now.hasact .sub, .prow1 .now.hasact .sep{ opacity:.4; }
.prow1 .now.hasact .sub.act{ opacity:1; }
.prow1 .next{ color:var(--text); opacity:.5; justify-self:end; text-align:right; }
.prow1 .parrow{ color:var(--dim); font-weight:700; font-size:.68em; justify-self:center; }
/* 2행: 주법 배지. 각 코드 아래 정렬. 배지 없으면 8비트(칩 미표시) */
.prow2{
  display:grid; grid-template-columns:1fr 1fr; align-items:center;
  gap:6px; margin-top:5px; min-height:16px;
}
.ptech{
  font-size:10px; font-weight:800; letter-spacing:.3px;
  border:1px solid currentColor; border-radius:4px; padding:1px 6px; white-space:nowrap;
}
.ptech.pm{ color:var(--dim); }
.ptech.os{ color:var(--gold); }
#pNowTech{ justify-self:start; }
#pNextTech{ justify-self:end; }
/* 3행: 박자 블록 — 한 마디(4박)를 4칸으로. 현재 박 하이라이트.
   칸 위에 덧그리는 세로선(.pbdiv)은 이 마디의 코드 경계(반반=1/2, 3분할=1/3·2/3) */
.pbeats{
  position:relative; display:grid; grid-template-columns:repeat(4,1fr);
  gap:3px; margin-top:7px;
}
.pbeats .pb{
  font-style:normal; text-align:center; line-height:15px; height:15px;
  font-size:9px; font-weight:800; color:var(--dim);
  font-family:ui-monospace,monospace;
  background:#141109; border:1px solid var(--line); border-radius:3px;
}
.pbeats .pb.on{ background:rgba(240,168,58,.42); border-color:var(--gold); color:#e8dcc0; }
.pbeats .pb.on.hi{ background:var(--gold); color:#1a1508; }   /* 1박(강세) */
.pbeats .pbdiv{
  position:absolute; top:-2px; bottom:-2px; width:2px; margin-left:-1px;
  background:var(--text); opacity:.8; border-radius:1px; pointer-events:none;
  z-index:2;
}
/* 현재 코드가 차지하는 구간(반반=1/2, 3분할=1/3)을 옅게 강조.
   칸(박)·경계선은 그대로 두고 위에 얹기만 한다 — 단일 마디에서는 표시 안 함 */
.pbeats .pseg{
  position:absolute; top:-2px; bottom:-2px;
  background:rgba(240,168,58,.13);
  border:1px solid rgba(240,168,58,.45);
  border-radius:4px; pointer-events:none; z-index:1;
}
/* 4행: 메타 */
.pmeta{
  margin-top:7px; font-size:10.5px; color:var(--dim);
  font-family:ui-monospace,monospace; line-height:1.4;
}
.pctl{display:flex; gap:5px; align-items:center; margin-top:6px}
.pctl .lb{font-size:10.5px; color:var(--dim); min-width:30px}
.pctl button{
  flex:1; padding:8px 0; border-radius:7px; border:1px solid var(--line);
  background:var(--panel); color:var(--dim); font-size:12px; font-weight:700; cursor:pointer;
}
.pctl button.on{background:var(--gold); border-color:var(--gold); color:#1a1508}
.pctl button.wide{flex:2}
.pstat{
  margin-top:6px; font-size:10.5px; color:var(--dim); line-height:1.6;
  font-family:ui-monospace,monospace;
}
.phint{ margin-top:6px; font-size:10px; color:var(--dim); line-height:1.5; }
/* 자동 스크롤 시 현재 마디가 상단 sticky(플레이어+상태+컨트롤)에 가리지 않도록 여백 */
#viewF .bar{ scroll-margin-top: var(--stickyH, 320px); }
.bar.now{
  background:var(--gold); color:#1a1508;
  outline:2px solid var(--gold); outline-offset:-2px; border-radius:2px;
}
.bar.now small{color:#6b5410}
.bar.split.now i:first-child{border-right-color:#8a6d18}
.bar.split3.now i:nth-child(2){border-right-color:#8a6d18}

/* ============================ 반응형 ============================ */
/* 1. ~767px(폰): 위 기본 스타일 그대로 (변경 없음) */

/* 2. 768px~(태블릿): 섹션 카드 2단 + 컨테이너 확장 + 마디 폰트 확대 */
@media (min-width:768px){
  body{ max-width:900px; }
  /* 단독 컴팩트/펼침 뷰만 2단. 플레이어 탭의 차트(viewF)는 단일 컬럼 유지 */
  body[data-view="C"] #viewC,
  body[data-view="F"] #viewF{ column-count:2; column-gap:18px; }
  body[data-view="C"] #viewC > .flow, body[data-view="C"] #viewC > .legend,
  body[data-view="F"] #viewF > .flow, body[data-view="F"] #viewF > .legend{ column-span:all; }
  #viewC .sec, #viewF .sec, #viewF .jump{ break-inside:avoid; }
  .bar{ font-size:16px; }
  .bar.split i{ font-size:14px; }
}

/* 3. 1100px~(데스크톱, 플레이어 탭 한정): 좌 고정 패널 + 우 차트 스크롤 */
@media (min-width:1100px){
  body[data-view="P"]{
    max-width:1400px;
    display:grid;
    grid-template-columns:460px minmax(0,1fr);
    column-gap:22px; align-items:start;
  }
  body[data-view="P"] > .back,
  body[data-view="P"] > header,
  body[data-view="P"] > .tabs{ grid-column:1 / -1; }
  body[data-view="P"] > #viewP.on{ display:block; grid-column:1; }
  body[data-view="P"] .pwrap{ position:static; padding-bottom:0; margin-bottom:0; }
  /* 오른쪽 차트: 자체 스크롤 컨테이너 (높이는 JS가 뷰포트에 맞춰 지정) */
  body[data-view="P"] > #viewF{ grid-column:2; overflow-y:auto; overscroll-behavior:contain; }
}

/* 4. 납작한 가로화면(폰 가로): 좌(영상+컨트롤) / 우(차트) 2단.
      예전에는 차트가 pwrap 아래로 흘러서, 자동 스크롤이 차트를 따라가려면
      window를 움직일 수밖에 없었고 그때 영상이 위로 밀려났다.
      데스크톱 분할과 같은 구조로 바꿔 차트를 자체 스크롤 컨테이너로 분리한다. */
@media (max-height:500px) and (orientation:landscape){
  body{ max-width:none; padding:6px 10px calc(6px + env(safe-area-inset-bottom)); }
  header{ display:none; }                 /* sticky/세로 점유 최소화 */
  .tabs{ margin-bottom:5px; }
  .tabs button{ padding:6px 0; }

  body[data-view="P"]{
    display:grid;
    grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);
    column-gap:10px; align-items:start;
  }
  body[data-view="P"] > .back,
  body[data-view="P"] > .tabs{ grid-column:1 / -1; }
  /* 왼쪽 칸: 영상(또는 스템 패널) + 컨트롤. 넘치면 이 칸만 스크롤 */
  body[data-view="P"] > #viewP.on{
    display:block; grid-column:1;
    overflow-y:auto; overscroll-behavior:contain;
  }
  /* 오른쪽 칸: 차트 자체 스크롤 (높이는 JS가 뷰포트에 맞춰 지정) */
  body[data-view="P"] > #viewF{
    grid-column:2; overflow-y:auto; overscroll-behavior:contain;
  }
  body[data-view="P"] .pwrap{
    position:static; padding-bottom:0; margin-bottom:0;
    display:flex; align-items:flex-start; gap:8px;
  }
  body[data-view="P"] .pvid{
    flex:0 0 auto;
    width:min(56%, calc((100dvh - 70px) * 16 / 9));   /* 폭·높이 중 먼저 닿는 쪽 → 잘림 없음 */
  }
  /* 스템 패널도 영상 자리를 그대로 물려받는다 */
  body[data-view="P"] #pStem{ flex:0 0 auto; width:56%; max-height:none; }
  body[data-view="P"] .pctrls{ flex:1 1 auto; min-width:0; max-height:none; }
}
`;

  function injectCSS(){
    if(document.getElementById('song-core-css')) return;
    const s = document.createElement('style');
    s.id = 'song-core-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ===================== 렌더링 ===================== */
  const CHORD_EXT = /^(add9|sus4|7|9|maj7)$/i;   // 붙여쓰는 코드 접미(마커와 구분)

  function el(tag, cls){
    const e = document.createElement(tag);
    if(cls) e.className = cls;
    return e;
  }

  // 마디 토큰 → .bar 엘리먼트
  function renderBar(tok){
    let os = false, t = String(tok);
    if(t.slice(-1) === '*'){ os = true; t = t.slice(0, -1); }
    const parts = t.split(',');
    const span = el('span', 'bar');

    if(parts.length >= 2){                          // 분할 마디(2 또는 3)
      span.classList.add('split');
      if(parts.length >= 3) span.classList.add('split3');
      if(os) span.classList.add('os');
      parts.forEach(function(p){
        const i = document.createElement('i');
        i.textContent = p;                          // 분할 조각은 평문(전조 대상)
        span.appendChild(i);
      });
      return span;
    }

    if(os) span.classList.add('os');
    let main = parts[0], sm = null;
    const ci = main.indexOf('^');
    if(ci >= 0){ sm = main.slice(ci + 1); main = main.slice(0, ci); }
    span.appendChild(document.createTextNode(main)); // 메인 코드(전조 대상)
    if(sm){
      // 코드 접미(add9 등)는 붙여쓰기, 그 외 마커(𝄋·끝 등)는 한 칸 띄움 — 기존 표기 재현
      if(!CHORD_EXT.test(sm)) span.appendChild(document.createTextNode(' '));
      const small = document.createElement('small');
      small.textContent = sm;
      span.appendChild(small);
    }
    return span;
  }

  function renderSection(sec){
    const s = el('section', 'sec');
    s.setAttribute('style', '--c:var(--' + sec.color + ')');
    const h = el('div', 'sec-h');
    if(sec.pass != null){ const p = el('span', 'pass'); p.textContent = sec.pass; h.appendChild(p); }
    const b = document.createElement('b'); b.textContent = sec.name; h.appendChild(b);
    if(sec.tech){
      const e = el('em', 'tech ' + sec.tech);
      e.textContent = (sec.tech === 'pm') ? 'P.M.' : '◇ 원샷';
      h.appendChild(e);
    }
    if(sec.meta != null){ const sp = document.createElement('span'); sp.textContent = sec.meta; h.appendChild(sp); }
    if(sec.repeat){ const e = document.createElement('em'); e.textContent = sec.repeat; h.appendChild(e); }
    s.appendChild(h);
    (sec.rows || []).forEach(function(row){
      const r = el('div', 'row');
      r.setAttribute('style', '--n:' + row.length);
      row.forEach(function(tok){ r.appendChild(renderBar(tok)); });
      s.appendChild(r);
    });
    if(sec.note){ const n = el('div', 'note'); n.innerHTML = sec.note; s.appendChild(n); }
    return s;
  }

  // .view 컨테이너 채우기: flow → blocks(섹션/점프) → legend
  function fillView(view, spec){
    if(!spec) return;
    if(spec.flow){ const f = el('div', 'flow'); f.innerHTML = spec.flow; view.appendChild(f); }
    (spec.blocks || []).forEach(function(blk){
      if(blk && blk.jump){ const j = el('div', 'jump'); j.innerHTML = blk.jump; view.appendChild(j); }
      else view.appendChild(renderSection(blk));
    });
    if(spec.legend){ const lg = el('div', 'legend'); lg.innerHTML = spec.legend; view.appendChild(lg); }
  }

  // 플레이어 탭 정적 마크업(곡 무관). barCount/bpm 초기 표기만 데이터로.
  function playerHTML(barCount, bpm){
    return ''
    + '<div class="pwrap">'
    +   '<div class="pvid only-yt"><div id="ytPlayer"></div></div>'
    +   '<div class="only-stem" id="pStem"></div>'
    +   '<div class="pctrls">'
    +     '<div class="psrc">'
    +       '<button id="srcYT">유튜브</button>'
    +       '<button id="srcStem">스템(내 음원)</button>'
    +     '</div>'
    +     '<div class="pnow">'
    +       '<div class="prow1" id="prow1">'
    +         '<span class="pcode now" id="pNow">대기</span>'
    +         '<span class="parrow">→</span>'
    +         '<span class="pcode next" id="pNext">—</span>'
    +       '</div>'
    +       '<div class="prow2">'
    +         '<span class="ptech" id="pNowTech" style="display:none"></span>'
    +         '<span class="ptech" id="pNextTech" style="display:none"></span>'
    +       '</div>'
    +       '<div class="pbeats" id="pBeats">'
    +         '<i class="pb">1</i><i class="pb">2</i><i class="pb">3</i><i class="pb">4</i>'
    +       '</div>'
    +       '<div class="pmeta" id="pMeta">— · 0/' + barCount + ' 마디</div>'
    +     '</div>'
    +     '<div class="only-yt"   id="pSpeedYT"></div>'
    +     '<div class="only-stem" id="pSpeedStem"></div>'
    +     '<div class="pctl"><button id="btnScroll" class="on wide">↕ 자동스크롤</button></div>'
    +     '<div id="pMetro"></div>'
    +     '<div class="pctl">'
    +       '<button class="wide" id="btnMark">지금이 1마디 시작</button>'
    +       '<button id="btnNudgeDn">−0.1s</button>'
    +       '<button id="btnNudgeUp">+0.1s</button>'
    +     '</div>'
    +     '<div class="only-yt"   id="pLoopYT"></div>'
    +     '<div class="only-stem" id="pLoopStem"></div>'
    +     '<div class="pctl">'
    +       '<span class="lb">BPM</span>'
    +       '<button data-bpm="-0.5">−0.5</button>'
    +       '<button data-bpm="-0.1">−0.1</button>'
    +       '<button data-bpm="0.1">+0.1</button>'
    +       '<button data-bpm="0.5">+0.5</button>'
    +     '</div>'
    +     '<div class="phint">뒤로 갈수록 하이라이트가 빨라지면 BPM ↓, 늦어지면 BPM ↑</div>'
    +     '<div class="pstat" id="pStat">t0=0.00초 · BPM ' + bpm.toFixed(1) + ' · 대기 · 속도 1x</div>'
    +   '</div>'
    + '</div>';
  }

  /* ===================== 조립 + 구동 ===================== */
  function init(data){
    injectCSS();

    // ── 데이터 정규화(간단형 sections → compact/expanded 공용) ──
    const compact  = data.compact  || { blocks: data.sections };
    const expanded = data.expanded || { blocks: data.sections };
    const prefix   = data.prefix || 'song';
    // 시간축(t0·A-B·속도)은 소스마다 다르므로 키를 분리한다. BPM은 곡 고유값이라 공용.
    const K = {
      bpm:    prefix + '_bpm',
      t0:     prefix + '_t0',        speed:      prefix + '_speed',      ab:      prefix + '_ab',
      t0s:    prefix + '_stem_t0',   speedStem:  prefix + '_stem_speed', abStem:  prefix + '_stem_ab',
      mix:    prefix + '_stem_mix',  src:        prefix + '_src',
      metro:  prefix + '_metro'      // 메트로놈 {on, vol, div} — 소스 공용
    };

    // ── DOM 조립(모두 body 직속 — 데스크톱 분할 그리드 셀렉터 전제) ──
    const back = el('a', 'back');
    back.href = data.backHref || '/index.html';
    back.textContent = '‹ 목록';

    const header = document.createElement('header');
    const h1 = document.createElement('h1'); h1.textContent = data.title;
    const metaEl = el('span', 'meta'); metaEl.id = 'meta'; metaEl.textContent = data.meta.original;
    header.appendChild(h1); header.appendChild(metaEl);

    const viewTabs = el('div', 'tabs');
    const tabC = mkBtn('tabC', '컴팩트', 'on');
    const tabF = mkBtn('tabF', '펼침');
    const tabP = mkBtn('tabP', '▶ 플레이어');
    viewTabs.appendChild(tabC); viewTabs.appendChild(tabF); viewTabs.appendChild(tabP);

    const keyTabs = el('div', 'tabs');
    const keyOrig = mkBtn('keyD', data.keyTabs.original, 'on');
    const keyCapo = mkBtn('keyC', data.keyTabs.capo);
    keyTabs.appendChild(keyOrig); keyTabs.appendChild(keyCapo);

    const viewC = el('div', 'view on'); viewC.id = 'viewC'; fillView(viewC, compact);
    const viewP = el('div', 'view');    viewP.id = 'viewP';
    const viewF = el('div', 'view');    viewF.id = 'viewF'; fillView(viewF, expanded);

    // 플레이어 마크업(펼침 마디 수 기준)
    const barCount = viewF.querySelectorAll('.bar').length;
    viewP.innerHTML = playerHTML(barCount, data.bpm);

    const body = document.body;
    [back, header, viewTabs, keyTabs, viewC, viewP, viewF].forEach(function(n){ body.appendChild(n); });

    // ── 상태 ──
    const bars = Array.prototype.slice.call(viewF.querySelectorAll('.bar'));
    let player = null, ytReady = false, tickId = null, apiRequested = false;
    let stem = null;                                   // 스템 엔진(유튜브 호환 인터페이스)
    let source = (localStorage.getItem(K.src) === 'stem') ? 'stem' : 'yt';
    let bpm = parseFloat(localStorage.getItem(K.bpm)) || data.bpm;
    let BAR = 240 / bpm;
    let t0YT   = parseFloat(localStorage.getItem(K.t0))  || 0;
    let t0Stem = parseFloat(localStorage.getItem(K.t0s)) || 0;
    let curIdx = -1, rate = 1, autoScroll = true;
    let suppressScrollUntil = 0, userScrollUntil = 0;
    let metro = null;                                  // 메트로놈(metronome.js 있을 때)
    let segKey = '';                                   // 박 블록 코드 구간 표시 캐시 키
    const wake = Practice.wakeLock();                  // 재생 중 화면 꺼짐 방지

    /* ---- 소스(유튜브 / 스템) 공통 접근자 ---- */
    function activePlayer(){ return (source === 'stem') ? stem : player; }
    function curT0(){ return (source === 'stem') ? t0Stem : t0YT; }
    function setT0(v){
      if(source === 'stem'){ t0Stem = v; localStorage.setItem(K.t0s, String(v)); }
      else                 { t0YT   = v; localStorage.setItem(K.t0,  String(v)); }
    }
    function srcReady(){
      return (source === 'stem') ? !!(stem && stem.hasTracks()) : ytReady;
    }

    const chordListEl = document.getElementById('chordList');   // 펼침 범례에만 존재(선택)

    /* ---- 탭 전환 ---- */
    function show(v){
      viewC.classList.toggle('on', v === 'C');
      viewP.classList.toggle('on', v === 'P');
      viewF.classList.toggle('on', v === 'F' || v === 'P');   // 플레이어 탭은 펼침 차트 동반
      tabC.classList.toggle('on', v === 'C');
      tabF.classList.toggle('on', v === 'F');
      tabP.classList.toggle('on', v === 'P');
      body.setAttribute('data-view', v);
      if(v === 'P'){
        if(source === 'stem') ensureStem(); else initPlayer();
        startTick();
        startBeats();
      }
      updateStickyH(); layoutChart();
      suppressScrollUntil = Date.now() + 700;
      window.scrollTo(0, 0);
    }

    /* ---- 키(카포) 전환 ---- */
    function chordNodes(){
      const nodes = [];
      document.querySelectorAll('.bar').forEach(function(b){
        if(b.classList.contains('split')){
          b.querySelectorAll('i').forEach(function(i){ if(i.firstChild) nodes.push(i.firstChild); });
        } else if(b.firstChild){
          nodes.push(b.firstChild);
        }
      });
      return nodes;
    }
    function setKey(mode){                          // 'orig' | 'capo'
      const capo = (mode === 'capo');
      chordNodes().forEach(function(n){
        if(n.nodeType !== 3) return;
        if(n._orig === undefined) n._orig = n.textContent;
        const raw = n._orig, t = raw.trim();
        n.textContent = capo ? raw.replace(t, data.capoMap[t] || t) : raw;
      });
      metaEl.textContent = capo ? data.meta.capo : data.meta.original;
      if(chordListEl && data.chordList) chordListEl.textContent = capo ? data.chordList.capo : data.chordList.original;
      keyOrig.classList.toggle('on', !capo);
      keyCapo.classList.toggle('on', capo);
      refresh();
    }

    /* ---- 유튜브 IFrame API (플레이어 탭 최초 진입 시 lazy load) ---- */
    function initPlayer(){
      if(player || apiRequested) return;
      apiRequested = true;
      if(window.YT && window.YT.Player){ createPlayer(); return; }
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
    window.onYouTubeIframeAPIReady = createPlayer;
    function createPlayer(){
      if(player) return;
      player = new YT.Player('ytPlayer', {
        videoId: data.videoId,
        playerVars: { playsinline: 1, rel: 0 },
        events: {
          onReady: function(){
            if(ytReady) return;
            ytReady = true;
            speedYT.onReady();
            loopYT.onReady();
            startTick();
            if(source === 'yt') render(-1);
            updateStickyH();
            layoutChart();
          },
          onPlaybackRateChange: function(e){ speedYT.onPlaybackRateChange(e.data); }
        }
      });
    }

    /* ---- 스템 엔진 (플레이어 탭에서 스템 소스 선택 시 lazy 생성) ---- */
    function ensureStem(){
      if(stem) return;
      const mountEl = document.getElementById('pStem');
      if(!window.StemEngine){
        mountEl.textContent = '스템 엔진(stem-engine.js)을 불러오지 못했습니다.';
        return;
      }
      stem = StemEngine.create({
        mount:  mountEl,
        songId: prefix,
        mixKey: K.mix,
        onReady: function(){              // 트랙이 붙어 재생 준비가 끝났을 때
          speedStem.onReady();
          loopStem.onReady();
          updateStickyH(); layoutChart(); refresh();
        },
        onChange: function(){ updateStickyH(); layoutChart(); }
      });
    }

    /* ---- 소스 전환 ---- */
    function setSource(s){
      if(s === source) return;
      const cur = activePlayer();                       // 전환 전 현재 소스는 정지
      try { if(cur && cur.pauseVideo) cur.pauseVideo(); } catch(e){}
      source = s;
      localStorage.setItem(K.src, s);
      body.setAttribute('data-src', s);
      srcYT.classList.toggle('on',   s === 'yt');
      srcStem.classList.toggle('on', s === 'stem');
      rate = (s === 'stem') ? speedStem.rate : speedYT.rate;
      if(s === 'stem') ensureStem(); else initPlayer();
      if(metro) metro.reset();                          // 소스가 바뀌면 예약해 둔 클릭을 버린다
      startTick();
      updateStickyH(); layoutChart();
      // 아직 준비 안 된 소스로 옮겼다면 이전 소스의 마디 위치를 남기지 않는다
      if(srcReady()) refresh(); else render(-1);
    }

    /* ---- 마디 추적 ---- */
    function startTick(){
      if(tickId) return;
      tickId = setInterval(tick, 120);
    }
    function tick(){
      const p = activePlayer();
      if(!p || typeof p.getCurrentTime !== 'function'){ wake.set(false); return; }
      let st;
      try { st = p.getPlayerState(); } catch(e){ wake.set(false); return; }
      wake.set(st === 1);                     // 재생 중에만 화면을 깨워 둔다(정지·일시정지 시 해제)
      // 준비 안 된 소스(예: 음원을 아직 안 넣은 스템)의 시각 0을 1마디로 읽지 않는다
      if(!srcReady()) return;
      // 유튜브는 재생/일시정지에서만 추적(버퍼링·큐 상태의 시각은 신뢰도가 낮다)
      if(source === 'yt' && st !== 1 && st !== 2) return;
      let ct;
      try { ct = p.getCurrentTime(); } catch(e){ return; }
      const n = Math.floor((ct - curT0()) / BAR);
      if(n !== curIdx) render(n);
    }
    function refresh(){
      const p = activePlayer();
      if(!srcReady() || !p || typeof p.getCurrentTime !== 'function'){ render(curIdx); return; }
      let ct;
      try { ct = p.getCurrentTime(); } catch(e){ render(curIdx); return; }
      render(Math.floor((ct - curT0()) / BAR));
    }
    function render(n){
      const prev = curIdx;
      curIdx = n;
      if(prev >= 0 && bars[prev]) bars[prev].classList.remove('now');
      const elx = (n >= 0 && n < bars.length) ? bars[n] : null;
      if(elx){
        elx.classList.add('now');
        if(autoScroll && Date.now() > userScrollUntil){
          suppressScrollUntil = Date.now() + 700;
          scrollToBar(elx);
        }
      }
      const nx = (n + 1 >= 0 && n + 1 < bars.length) ? bars[n + 1] : null;
      const nowCode  = (n < 0) ? '대기' : (elx ? barText(elx) : '—');
      const nextCode = nx ? barText(nx) : '—';
      setNowContent(elx, nowCode);
      document.getElementById('pNext').textContent = nextCode;
      setTech('pNowTech',  elx ? barTech(elx) : '');
      setTech('pNextTech', nx ? barTech(nx) : '');
      sizeRow1(nowCode, nextCode);
      document.getElementById('pMeta').textContent =
        (elx ? secName(elx) : '—') + ' · ' +
        (n < 0 ? 0 : Math.min(n + 1, bars.length)) + '/' + bars.length + ' 마디';
      document.getElementById('pStat').textContent =
        (source === 'stem' ? '스템' : '유튜브') + ' · ' +
        't0=' + curT0().toFixed(2) + '초 · BPM ' + bpm.toFixed(1) + ' · 현재 ' +
        (n < 0 ? '대기' : (n >= bars.length ? '끝' : (n + 1) + '/' + bars.length)) +
        ' · 속도 ' + rate + 'x';
    }

    // NOW 표시: 분할 마디는 조각별 span으로 그려 현재 조각만 강조할 수 있게 한다.
    // 텍스트는 barText()와 동일("G·D/F#") — 폰트 크기 계산도 그 문자열 기준 그대로.
    function setNowContent(elx, nowCode){
      const pn = document.getElementById('pNow');
      if(elx && elx.classList.contains('split')){
        pn.textContent = '';
        elx.querySelectorAll('i').forEach(function(piece, i){
          if(i){
            const sep = document.createElement('span');
            sep.className = 'sep'; sep.textContent = '·';
            pn.appendChild(sep);
          }
          const sp = document.createElement('span');
          sp.className = 'sub'; sp.textContent = piece.textContent.trim();
          pn.appendChild(sp);
        });
      } else {
        pn.textContent = nowCode;
      }
      pn.classList.remove('hasact');
      segKey = '';                       // 내용이 새로 그려졌으니 구간 표시 다시 적용
    }

    function barText(elx){
      if(elx.classList.contains('split')){
        return Array.prototype.map.call(elx.querySelectorAll('i'), function(i){
          return i.textContent.trim();
        }).join('·');
      }
      const main = (elx.firstChild && elx.firstChild.nodeType === 3) ? elx.firstChild.textContent.trim() : '';
      const sm = elx.querySelector('small');
      const s = sm ? sm.textContent.trim() : '';
      return main + (CHORD_EXT.test(s) ? '(' + s + ')' : '');
    }
    function barTech(elx){
      if(elx.classList.contains('os')) return '◇';
      const sec = elx.closest('section');
      if(sec && sec.querySelector('.sec-h .tech.pm')) return 'P.M.';
      return '';
    }
    function setTech(id, tech){
      const b = document.getElementById(id);
      if(tech === '◇'){ b.textContent = '◇ 원샷'; b.className = 'ptech os'; b.style.display = ''; }
      else if(tech === 'P.M.'){ b.textContent = 'P.M.'; b.className = 'ptech pm'; b.style.display = ''; }
      else { b.textContent = ''; b.className = 'ptech'; b.style.display = 'none'; }
    }
    function sizeRow1(a, b){
      const len = a.length + b.length;
      document.getElementById('prow1').className =
        'prow1' + (len > 13 ? ' sz-sm' : len > 8 ? ' sz-md' : '');
    }
    function secName(elx){
      const sec = elx.closest('section');
      const b = sec && sec.querySelector('.sec-h b');
      return b ? b.textContent.trim() : '—';
    }

    /* ---- 박자 블록(마디 = 4박) ----
       마디 내 경과 ÷ (60/bpm) 로 현재 박을 구한다. getCurrentTime()이 미디어
       시각이므로 배속을 걸어도 보정이 필요 없다(마디 계산과 같은 기준).
       마디 갱신(120ms 폴링)보다 촘촘해야 해서 rAF로 따로 돈다. */
    const beatsEl   = document.getElementById('pBeats');
    const beatCells = Array.prototype.slice.call(beatsEl.querySelectorAll('.pb'));
    const segEl     = el('b', 'pseg');           // 현재 코드 구간 오버레이
    segEl.style.display = 'none';
    beatsEl.appendChild(segEl);
    let beatRaf = null, lastBeat = -2, lastDivKind = -1;

    // 추적 가능한 상태의 현재 미디어 시각(아니면 null)
    function mediaNow(){
      const p = activePlayer();
      if(!srcReady() || !p || typeof p.getCurrentTime !== 'function') return null;
      let st;
      try { st = p.getPlayerState(); } catch(e){ return null; }
      if(st !== 1 && st !== 2) return null;            // 재생·일시정지에서만 신뢰
      try { return p.getCurrentTime(); } catch(e){ return null; }
    }
    function setBeat(b){
      if(b === lastBeat) return;
      lastBeat = b;
      beatCells.forEach(function(c, i){
        c.classList.toggle('on', i === b);
        c.classList.toggle('hi', i === b && i === 0);  // 1박 강세
      });
    }
    // 현재 마디의 코드 경계선: 반반 마디 = 3박째(1/2), 3분할 마디 = 1/3·2/3
    function drawBeatDivs(){
      const b = (curIdx >= 0 && curIdx < bars.length) ? bars[curIdx] : null;
      const kind = !b ? 1
                 : b.classList.contains('split3') ? 3
                 : b.classList.contains('split')  ? 2 : 1;
      if(kind === lastDivKind) return;
      lastDivKind = kind;
      beatsEl.querySelectorAll('.pbdiv').forEach(function(n){ n.remove(); });
      for(let i = 1; i < kind; i++){
        const d = el('b', 'pbdiv');
        d.style.left = (100 * i / kind) + '%';
        beatsEl.appendChild(d);
      }
    }
    // 현재 코드 구간 강조: 오버레이(칸 위)와 NOW 텍스트의 활성 조각을 함께 갱신
    function setSeg(segCount, seg){
      const key = curIdx + '/' + segCount + '/' + seg;
      if(key === segKey) return;
      segKey = key;
      if(segCount > 1 && seg >= 0){
        segEl.style.display = '';
        segEl.style.left  = (100 * seg / segCount) + '%';
        segEl.style.width = (100 / segCount) + '%';
      } else {
        segEl.style.display = 'none';
      }
      const pn   = document.getElementById('pNow');
      const subs = pn.querySelectorAll('.sub');
      if(segCount > 1 && seg >= 0 && subs.length === segCount){
        pn.classList.add('hasact');
        subs.forEach(function(sp, i){ sp.classList.toggle('act', i === seg); });
      } else {
        pn.classList.remove('hasact');
        subs.forEach(function(sp){ sp.classList.remove('act'); });
      }
    }
    function updateBeats(){
      const t = mediaNow();
      if(t == null || curIdx < 0 || curIdx >= bars.length){ setBeat(-1); setSeg(1, -1); return; }
      const pos = (t - curT0()) / BAR;                 // 마디 단위 위치
      const f   = pos - Math.floor(pos);               // 마디 내 경과 비율
      setBeat(Math.max(0, Math.min(3, Math.floor(f * 4))));
      const b = bars[curIdx];
      const segCount = b.classList.contains('split3') ? 3
                     : b.classList.contains('split')  ? 2 : 1;
      setSeg(segCount, Math.max(0, Math.min(segCount - 1, Math.floor(f * segCount))));
    }
    function beatLoop(){
      beatRaf = null;
      if(!playerTab()) return;                         // 플레이어 탭에서만 돈다
      updateBeats();
      drawBeatDivs();
      beatRaf = requestAnimationFrame(beatLoop);
    }
    function startBeats(){
      if(!beatRaf && playerTab()) beatRaf = requestAnimationFrame(beatLoop);
    }

    /* ---- 컨트롤(공용 practice.js) — 소스별로 한 벌씩 ---- */
    const speedYT = Practice.createSpeed({
      mount: document.getElementById('pSpeedYT'),
      storageKey: K.speed,
      getPlayer: function(){ return player; },
      onRate: function(r){ if(source === 'yt'){ rate = r; render(curIdx); } }
    });
    const loopYT = Practice.createLoop({
      mount: document.getElementById('pLoopYT'),
      storageKey: K.ab,
      getPlayer: function(){ return player; },
      onSeek: function(){ speedYT.reapply(); }   // 구간 점프 후 속도 유지
    });
    // 로컬 오디오는 임의 배속이 확실 → 지원 감지 생략, 0.5~1.5 / step 0.05
    const speedStem = Practice.createSpeed({
      mount: document.getElementById('pSpeedStem'),
      storageKey: K.speedStem,
      getPlayer: function(){ return stem; },
      min: 0.5, max: 1.5, step: 0.05, detect: false,
      onRate: function(r){ if(source === 'stem'){ rate = r; render(curIdx); } }
    });
    const loopStem = Practice.createLoop({
      mount: document.getElementById('pLoopStem'),
      storageKey: K.abStem,
      getPlayer: function(){ return stem; },
      onSeek: function(){ speedStem.reapply(); }
    });
    rate = (source === 'stem') ? speedStem.rate : speedYT.rate;

    /* ---- 메트로놈(metronome.js) ---- */
    if(window.Metronome){
      metro = Metronome.create({
        mount:      document.getElementById('pMetro'),
        storageKey: K.metro,
        // 스템 모드에서는 엔진의 AudioContext에 직접 예약해 샘플 정밀을 얻는다
        getContext: function(){
          return (source === 'stem' && stem && stem.getAudioContext) ? stem.getAudioContext() : null;
        },
        getTiming: function(){
          const p = activePlayer();
          if(!srcReady() || !p || typeof p.getCurrentTime !== 'function') return null;
          let st, t;
          try { st = p.getPlayerState(); t = p.getCurrentTime(); } catch(e){ return null; }
          if(st !== 1) return { playing: false };      // 정지·일시정지 → 클릭 정지
          return {
            playing: true, time: t, t0: curT0(), bpm: bpm, rate: rate,
            ctxTime: (source === 'stem' && stem && stem.mediaToCtxTime) ? stem.mediaToCtxTime : null
          };
        },
        onChange: function(){ updateStickyH(); layoutChart(); }
      });
    }

    function markStart(){
      const p = activePlayer();
      if(!srcReady() || !p) return;
      setT0(p.getCurrentTime());
      if(metro) metro.reset();          // 기준점이 바뀌면 예약해 둔 클릭을 다시 잡는다
      refresh();
    }
    function nudge(d){
      setT0(Math.max(0, curT0() + d));
      if(metro) metro.reset();
      refresh();
    }
    function nudgeBpm(d){
      bpm = Math.min(200, Math.max(60, Math.round((bpm + d) * 10) / 10));
      BAR = 240 / bpm;
      localStorage.setItem(K.bpm, String(bpm));
      if(metro) metro.reset();
      refresh();
    }
    function toggleScroll(){
      autoScroll = !autoScroll;
      document.getElementById('btnScroll').classList.toggle('on', autoScroll);
    }

    /* ---- 분할 레이아웃(데스크톱 / 폰 가로) + 자동 스크롤 ----
       분할에서는 차트(viewF)가 자체 스크롤 컨테이너다. 자동 스크롤은 그
       컨테이너의 scrollTop만 건드리고 window는 절대 움직이지 않는다. */
    const MQ_DESK = '(min-width:1100px)';
    const MQ_FLAT = '(max-height:500px) and (orientation:landscape)';
    function playerTab(){ return body.getAttribute('data-view') === 'P'; }
    function flatLandscape(){ return window.matchMedia(MQ_FLAT).matches; }
    function splitLayout(){
      return playerTab() && (window.matchMedia(MQ_DESK).matches || flatLandscape());
    }
    function layoutChart(){
      if(splitLayout()){
        // 문서 기준 위치로 계산한다. 뷰포트 기준(top)만 쓰면 페이지가 스크롤된
        // 상태에서 높이가 부풀어 컨테이너가 화면 밖으로 넘친다.
        const topDoc = viewF.getBoundingClientRect().top + window.scrollY;
        const h = Math.max(160, Math.round(window.innerHeight - topDoc - 12));
        viewF.style.height = h + 'px';
        viewP.style.maxHeight = flatLandscape() ? (h + 'px') : '';
      } else {
        if(viewF.style.height)    viewF.style.height = '';
        if(viewP.style.maxHeight) viewP.style.maxHeight = '';
      }
    }
    /* 상단 고정 영역(.pwrap = 플레이어 + NOW/박자 블록 + 컨트롤)이 뷰포트 위쪽을
       덮는 높이. 레이아웃·기기·컨트롤 구성(박자 블록·메트로놈 추가 등)에 따라
       달라지므로 하드코딩하지 않고 그때그때 측정한다.
       sticky가 아닌 레이아웃(데스크톱·폰 가로 분할)에서는 차트를 덮지 않으므로 0. */
    function stickyCover(){
      const w = document.querySelector('.pwrap');
      if(!w || !w.offsetHeight) return 0;
      let cs;
      try { cs = getComputedStyle(w); } catch(e){ return 0; }
      if(cs.position !== 'sticky' && cs.position !== 'fixed') return 0;
      const topPx = parseFloat(cs.top) || 0;            // sticky가 멈추는 지점
      return Math.max(0, topPx + w.getBoundingClientRect().height);
    }
    // 현재 마디를 "가려지지 않는 영역"의 중앙으로. scrollIntoView는 조상 스크롤
    // 컨테이너와 window를 같이 움직여서(가로모드에서 영상이 밀려남) 쓰지 않고
    // 좌표를 직접 계산한다.
    function scrollToBar(elx){
      const cover = stickyCover();
      if(splitLayout()){
        const er = elx.getBoundingClientRect(), br = viewF.getBoundingClientRect();
        // 분할 레이아웃에서 고정 영역은 왼쪽 칸에 있어 보통 0이지만,
        // 컨테이너 상단을 덮는 경우가 생겨도 그만큼 밀어준다.
        const cut = Math.max(0, Math.min(cover - br.top, viewF.clientHeight));
        const visH = Math.max(40, viewF.clientHeight - cut);
        const max = Math.max(0, viewF.scrollHeight - viewF.clientHeight);
        const top = viewF.scrollTop + (er.top - br.top)
                  - cut - (visH - elx.offsetHeight) / 2;
        viewF.scrollTop = Math.max(0, Math.min(max, Math.round(top)));
      } else {
        // 세로(폰)에서는 문서가 움직이는 것이 의도된 동작. 다만 가로 위치는
        // 건드리지 않도록 좌표를 명시해서 스크롤한다.
        const er = elx.getBoundingClientRect();
        const visH = Math.max(40, window.innerHeight - cover);
        const want = cover + (visH - elx.offsetHeight) / 2;   // 목표 뷰포트 Y
        const top = window.scrollY + er.top - want;
        window.scrollTo(window.scrollX, Math.max(0, Math.round(top)));
      }
    }
    // 사용자가 직접 스크롤하면 3초간 자동 스크롤을 멈춘다(차트 컨테이너 포함)
    function onUserScroll(){
      if(Date.now() < suppressScrollUntil) return;
      userScrollUntil = Date.now() + 3000;
    }
    window.addEventListener('scroll', onUserScroll, { passive: true });
    viewF.addEventListener('scroll', onUserScroll, { passive: true });
    viewP.addEventListener('scroll', onUserScroll, { passive: true });
    // 고정 영역 높이를 CSS 변수로도 노출(.bar의 scroll-margin-top 용)
    function updateStickyH(){
      document.documentElement.style.setProperty('--stickyH', Math.round(stickyCover()) + 'px');
    }
    function relayout(){ updateStickyH(); layoutChart(); }
    window.addEventListener('resize', relayout, { passive: true });
    window.addEventListener('orientationchange', function(){ setTimeout(relayout, 120); });

    /* ---- 이벤트 바인딩 ---- */
    const srcYT   = document.getElementById('srcYT');
    const srcStem = document.getElementById('srcStem');
    srcYT.classList.toggle('on',   source === 'yt');
    srcStem.classList.toggle('on', source === 'stem');
    srcYT.addEventListener('click',   function(){ setSource('yt'); });
    srcStem.addEventListener('click', function(){ setSource('stem'); });

    tabC.addEventListener('click', function(){ show('C'); });
    tabF.addEventListener('click', function(){ show('F'); });
    tabP.addEventListener('click', function(){ show('P'); });
    keyOrig.addEventListener('click', function(){ setKey('orig'); });
    keyCapo.addEventListener('click', function(){ setKey('capo'); });
    document.getElementById('btnScroll').addEventListener('click', toggleScroll);
    document.getElementById('btnMark').addEventListener('click', markStart);
    document.getElementById('btnNudgeDn').addEventListener('click', function(){ nudge(-0.1); });
    document.getElementById('btnNudgeUp').addEventListener('click', function(){ nudge(0.1); });
    viewP.querySelectorAll('[data-bpm]').forEach(function(btn){
      btn.addEventListener('click', function(){ nudgeBpm(parseFloat(btn.getAttribute('data-bpm'))); });
    });

    // 초기 진입 뷰(기본 컴팩트) → 태블릿 2단이 처음부터 적용
    body.setAttribute('data-view', 'C');
    body.setAttribute('data-src', source);
  }

  function mkBtn(id, label, cls){
    const b = document.createElement('button');
    b.id = id;
    if(cls) b.className = cls;
    b.textContent = label;
    return b;
  }

  return { init };
})();
