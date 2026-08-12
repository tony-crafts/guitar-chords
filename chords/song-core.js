/* song-core.js — 차트형 곡 페이지 공용 템플릿/엔진
   곡 데이터 객체 하나를 받아 marigold 계열 페이지(컴팩트/펼침/플레이어 탭,
   키 전환, 플레이어 싱크, t0/BPM 캘리브레이션, 자동스크롤, 주법 배지,
   반응형, 목록 링크)를 전부 생성·구동한다.
   practice.js(적응형 속도 + A-B 루프)에 의존한다.

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
/* 3행: 메타 */
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

/* 4. 납작한 가로화면(폰 가로): 영상 좌(높이 기준)+컨트롤 우, 헤더 숨김, 전체 폭 */
@media (max-height:500px) and (orientation:landscape){
  body{ max-width:none; padding:6px 10px calc(6px + env(safe-area-inset-bottom)); }
  header{ display:none; }                 /* sticky/세로 점유 최소화 */
  .tabs{ margin-bottom:5px; }
  .tabs button{ padding:6px 0; }

  /* 플레이어 탭: 영상 왼쪽(세로 꽉·16:9 유지·비잘림) + 컨트롤 오른쪽 세로 스택,
     차트(viewF)는 그 아래로 스크롤 → sticky 해제 */
  body[data-view="P"] .pwrap{
    position:static; padding-bottom:6px; margin-bottom:6px;
    display:flex; align-items:flex-start; gap:10px;
  }
  body[data-view="P"] .pvid{
    flex:0 0 auto;
    width:min(58vw, calc((100dvh - 58px) * 16 / 9));   /* 폭·높이 중 먼저 닿는 쪽 → 잘림 없음 */
  }
  body[data-view="P"] .pctrls{
    flex:1 1 auto; min-width:0;
    max-height:calc(100dvh - 58px); overflow-y:auto;   /* 우측 컨트롤 자체 스크롤 */
  }
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
    +   '<div class="pvid"><div id="ytPlayer"></div></div>'
    +   '<div class="pctrls">'
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
    +       '<div class="pmeta" id="pMeta">— · 0/' + barCount + ' 마디</div>'
    +     '</div>'
    +     '<div id="pSpeed"></div>'
    +     '<div class="pctl"><button id="btnScroll" class="on wide">↕ 자동스크롤</button></div>'
    +     '<div class="pctl">'
    +       '<button class="wide" id="btnMark">지금이 1마디 시작</button>'
    +       '<button id="btnNudgeDn">−0.1s</button>'
    +       '<button id="btnNudgeUp">+0.1s</button>'
    +     '</div>'
    +     '<div id="pLoop"></div>'
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
    const K = { bpm: prefix + '_bpm', t0: prefix + '_t0', speed: prefix + '_speed', ab: prefix + '_ab' };

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
    let player = null, ready = false, tickId = null, apiRequested = false;
    let bpm = parseFloat(localStorage.getItem(K.bpm)) || data.bpm;
    let BAR = 240 / bpm;
    let t0 = parseFloat(localStorage.getItem(K.t0)) || 0;
    let curIdx = -1, rate = 1, autoScroll = true;
    let suppressScrollUntil = 0, userScrollUntil = 0;

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
      if(v === 'P') initPlayer();
      updateStickyH(); layoutRight();
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
            if(ready) return;
            ready = true;
            speedCtl.onReady();
            loopCtl.onReady();
            if(tickId) clearInterval(tickId);
            tickId = setInterval(tick, 120);
            render(-1);
            updateStickyH();
            layoutRight();
          },
          onPlaybackRateChange: function(e){ speedCtl.onPlaybackRateChange(e.data); }
        }
      });
    }

    /* ---- 마디 추적 ---- */
    function tick(){
      if(!ready || typeof player.getCurrentTime !== 'function') return;
      let st;
      try { st = player.getPlayerState(); } catch(e){ return; }
      if(st !== 1 && st !== 2) return;
      const n = Math.floor((player.getCurrentTime() - t0) / BAR);
      if(n !== curIdx) render(n);
    }
    function refresh(){
      if(!ready){ render(curIdx); return; }
      render(Math.floor((player.getCurrentTime() - t0) / BAR));
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
      document.getElementById('pNow').textContent  = nowCode;
      document.getElementById('pNext').textContent = nextCode;
      setTech('pNowTech',  elx ? barTech(elx) : '');
      setTech('pNextTech', nx ? barTech(nx) : '');
      sizeRow1(nowCode, nextCode);
      document.getElementById('pMeta').textContent =
        (elx ? secName(elx) : '—') + ' · ' +
        (n < 0 ? 0 : Math.min(n + 1, bars.length)) + '/' + bars.length + ' 마디';
      document.getElementById('pStat').textContent =
        't0=' + t0.toFixed(2) + '초 · BPM ' + bpm.toFixed(1) + ' · 현재 ' +
        (n < 0 ? '대기' : (n >= bars.length ? '끝' : (n + 1) + '/' + bars.length)) +
        ' · 속도 ' + rate + 'x';
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

    /* ---- 컨트롤(공용 practice.js) ---- */
    const speedCtl = Practice.createSpeed({
      mount: document.getElementById('pSpeed'),
      storageKey: K.speed,
      getPlayer: function(){ return player; },
      onRate: function(r){ rate = r; render(curIdx); }
    });
    const loopCtl = Practice.createLoop({
      mount: document.getElementById('pLoop'),
      storageKey: K.ab,
      getPlayer: function(){ return player; },
      onSeek: function(){ speedCtl.reapply(); }   // 구간 점프 후 속도 유지
    });

    function markStart(){
      if(!ready) return;
      t0 = player.getCurrentTime();
      localStorage.setItem(K.t0, String(t0));
      refresh();
    }
    function nudge(d){
      t0 = Math.max(0, t0 + d);
      localStorage.setItem(K.t0, String(t0));
      refresh();
    }
    function nudgeBpm(d){
      bpm = Math.min(200, Math.max(60, Math.round((bpm + d) * 10) / 10));
      BAR = 240 / bpm;
      localStorage.setItem(K.bpm, String(bpm));
      refresh();
    }
    function toggleScroll(){
      autoScroll = !autoScroll;
      document.getElementById('btnScroll').classList.toggle('on', autoScroll);
    }

    /* ---- 데스크톱 분할 + 자동 스크롤 ---- */
    function desktopSplit(){
      return body.getAttribute('data-view') === 'P'
          && window.matchMedia('(min-width:1100px)').matches;
    }
    function layoutRight(){
      if(desktopSplit()){
        const top = viewF.getBoundingClientRect().top;
        viewF.style.height = Math.max(240, Math.round(window.innerHeight - top - 12)) + 'px';
      } else if(viewF.style.height){
        viewF.style.height = '';
      }
    }
    function scrollToBar(elx){
      if(desktopSplit()){
        const er = elx.getBoundingClientRect(), sr = viewF.getBoundingClientRect();
        viewF.scrollTop += (er.top - sr.top) - (viewF.clientHeight - elx.offsetHeight) / 2;
      } else {
        elx.scrollIntoView({ block: 'center' });
      }
    }
    function onUserScroll(){
      if(Date.now() < suppressScrollUntil) return;
      userScrollUntil = Date.now() + 3000;
    }
    window.addEventListener('scroll', onUserScroll, { passive: true });
    viewF.addEventListener('scroll', onUserScroll, { passive: true });
    function updateStickyH(){
      const w = document.querySelector('.pwrap');
      if(w && w.offsetHeight) document.documentElement.style.setProperty('--stickyH', w.offsetHeight + 'px');
    }
    window.addEventListener('resize', function(){ updateStickyH(); layoutRight(); }, { passive: true });

    /* ---- 이벤트 바인딩 ---- */
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
