/* practice.js — 코드 연습 페이지 공용 모듈
   - Practice.createSpeed(): 적응형 속도 조절 (임의 속도 지원 감지 → step 전환)
   - Practice.createLoop() : A-B 구간 루프
   두 페이지(marigold/love)가 공유. 테마 CSS 변수(--gold/--dim/--panel/--line/--brg) 전제. */
window.Practice = (function(){

  // 컨트롤 CSS 1회 주입 (테마 변수 사용)
  function injectCSS(){
    if(document.getElementById('practice-css')) return;
    const s = document.createElement('style');
    s.id = 'practice-css';
    s.textContent =
      '.pr-row{display:flex;gap:5px;align-items:center;margin-top:6px}'
    + '.pr-lb{font-size:10.5px;color:var(--dim);min-width:30px}'
    + '.pr-btn{flex:1;padding:8px 0;border-radius:7px;border:1px solid var(--line);'
    +   'background:var(--panel);color:var(--dim);font-size:12px;font-weight:700;cursor:pointer}'
    + '.pr-btn.on{background:var(--gold);border-color:var(--gold);color:#1a1508}'
    + '.pr-btn.sm{flex:0 0 auto;padding:8px 13px}'
    + '.pr-range{flex:1;accent-color:var(--gold);min-width:0}'
    + '.pr-val{min-width:52px;text-align:right;font-size:13px;font-weight:800;color:var(--gold);'
    +   'font-family:ui-monospace,monospace}'
    + '.pr-stat{margin-top:6px;font-size:10.5px;color:var(--dim);'
    +   'font-family:ui-monospace,monospace;line-height:1.5}'
    + '.pr-hint{margin-top:4px;font-size:10px;color:var(--brg,#e07b5f);line-height:1.4}';
    document.head.appendChild(s);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtRate = r => (+r.toFixed(2)) + 'x';          // 0.80→"0.8x", 1.00→"1x"
  const fmtTime = t => (t == null ? '—' : t.toFixed(2) + '초');

  /* ============================ 적응형 속도 ============================ */
  function createSpeed(opts){
    injectCSS();
    const { mount, storageKey, getPlayer, onRate } = opts;
    const MIN = 0.25, MAX = 2.0;
    let step = 0.25;                                    // 감지 전 기본(프리셋 가정)
    let detected = false, detecting = false;
    let rate = parseFloat(localStorage.getItem(storageKey)) || 1;

    mount.innerHTML =
      '<div class="pr-row">'
    +   '<span class="pr-lb">속도</span>'
    +   '<button type="button" class="pr-btn sm" data-d="-1">−</button>'
    +   '<input type="range" class="pr-range" min="'+MIN+'" max="'+MAX+'" step="'+step+'">'
    +   '<button type="button" class="pr-btn sm" data-d="1">+</button>'
    +   '<span class="pr-val"></span>'
    + '</div>';
    const range = mount.querySelector('.pr-range');
    const val   = mount.querySelector('.pr-val');
    const [dn, up] = mount.querySelectorAll('.pr-btn');

    function draw(){
      range.step = step;
      range.value = String(rate);
      val.textContent = fmtRate(rate);
    }

    // r 적용. fromPlayer=true면 유튜브가 이미 반영한 값(재설정 안 함)
    function apply(r, fromPlayer){
      rate = clamp(r, MIN, MAX);
      localStorage.setItem(storageKey, String(rate));
      if(!fromPlayer){
        const p = getPlayer();
        if(p && p.setPlaybackRate) p.setPlaybackRate(rate);
      }
      draw();
      if(onRate) onRate(rate);
    }

    function nudge(dir){
      const grid = Math.round((rate + dir*step) / step) * step;   // step 격자에 스냅
      apply(+grid.toFixed(2), false);
    }

    range.addEventListener('input', () => apply(parseFloat(range.value), false));
    dn.addEventListener('click', () => nudge(-1));
    up.addEventListener('click', () => nudge(1));

    // 플레이어 준비 후: 임의 속도 지원 1회 감지 → step/슬라이더 구성 + 저장값 복원
    function onReady(){
      const p = getPlayer();
      if(!p || !p.setPlaybackRate){ draw(); return; }
      detecting = true;
      const orig = p.getPlaybackRate();
      try { p.setPlaybackRate(0.8); } catch(e){}
      setTimeout(() => {
        let got = 0.8;
        try { got = p.getPlaybackRate(); } catch(e){}
        detected = Math.abs(got - 0.8) < 0.01;           // 0.8 유지되면 임의 속도 지원
        try { p.setPlaybackRate(orig); } catch(e){}      // 감지 후 원래 속도 복원
        step = detected ? 0.05 : 0.25;
        if(!detected) rate = Math.round(rate / 0.25) * 0.25;   // 미지원이면 프리셋으로 스냅
        detecting = false;
        console.log('[practice] 임의 속도 지원:', detected, '· step', step, '· 복원 속도', rate);
        apply(rate, false);
      }, 250);
      draw();
    }

    // 유튜브 메뉴에서 속도 변경 시 (양방향 동기화)
    function onPlaybackRateChange(r){
      if(detecting) return;                              // 감지 중 이벤트는 무시
      apply(r, true);
    }

    draw();
    return { onReady, onPlaybackRateChange, get rate(){ return rate; } };
  }

  /* ============================ A-B 구간 루프 ============================ */
  function createLoop(opts){
    injectCSS();
    const { mount, storageKey, getPlayer } = opts;
    let a = null, b = null, on = false, timer = null;

    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if(typeof saved.a === 'number') a = saved.a;
      if(typeof saved.b === 'number') b = saved.b;
      on = !!saved.on;
    } catch(e){}

    mount.innerHTML =
      '<div class="pr-row">'
    +   '<button type="button" class="pr-btn" data-k="a">A 설정</button>'
    +   '<button type="button" class="pr-btn" data-k="b">B 설정</button>'
    +   '<button type="button" class="pr-btn" data-k="t">루프 OFF</button>'
    +   '<button type="button" class="pr-btn" data-k="c">초기화</button>'
    + '</div>'
    + '<div class="pr-stat"></div>'
    + '<div class="pr-hint" style="display:none"></div>';
    const [bA, bB, bT, bC] = mount.querySelectorAll('.pr-btn');
    const stat = mount.querySelector('.pr-stat');
    const hint = mount.querySelector('.pr-hint');

    const valid = () => a != null && b != null && b > a;

    function save(){ localStorage.setItem(storageKey, JSON.stringify({ a, b, on })); }

    function draw(){
      stat.textContent = 'A ' + fmtTime(a) + ' · B ' + fmtTime(b) + ' · 루프 ' + (on ? 'ON' : 'OFF');
      bT.textContent = '루프 ' + (on ? 'ON' : 'OFF');
      bT.classList.toggle('on', on);
      bA.classList.toggle('on', a != null);
      bB.classList.toggle('on', b != null);
      // B ≤ A 이면 안내
      if(a != null && b != null && b <= a){
        hint.style.display = '';
        hint.textContent = 'B는 A보다 뒤(큰 시각)여야 합니다 — 루프 무시됨';
      } else {
        hint.style.display = 'none';
      }
    }

    function now(){
      const p = getPlayer();
      return (p && p.getCurrentTime) ? p.getCurrentTime() : null;
    }

    bA.addEventListener('click', () => { const t = now(); if(t != null){ a = +t.toFixed(2); save(); draw(); } });
    bB.addEventListener('click', () => { const t = now(); if(t != null){ b = +t.toFixed(2); save(); draw(); } });
    bT.addEventListener('click', () => {
      if(!on && !valid()){ draw(); return; }             // 유효하지 않으면 켜지 않음(안내만)
      on = !on; save(); draw();
    });
    bC.addEventListener('click', () => { a = b = null; on = false; save(); draw(); });

    // 폴링: 루프 ON + 재생 중 + B 도달 → A로 seek
    function poll(){
      if(!on || !valid()) return;
      const p = getPlayer();
      if(!p || !p.getCurrentTime || !p.getPlayerState) return;
      let st; try { st = p.getPlayerState(); } catch(e){ return; }
      if(st !== 1) return;                                // 1=재생 중일 때만
      if(p.getCurrentTime() >= b) p.seekTo(a, true);
    }

    function onReady(){
      if(timer) clearInterval(timer);
      timer = setInterval(poll, 100);
      draw();
    }

    draw();
    return { onReady, get state(){ return { a, b, on }; } };
  }

  return { createSpeed, createLoop };
})();
