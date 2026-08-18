/* metronome.js — 차트형 곡 페이지용 메트로놈
   재생 중인 소스(유튜브 / 스템)의 미디어 시각 위에 클릭을 얹는다.
   음원 파일 없이 Web Audio로 클릭을 합성한다(1박 강세 = 높은음, 2~4박 = 낮은음).

   ── 스케줄링 ────────────────────────────────────────────────────
   · 폴링(90ms) + lookahead(0.3초) 예약. setTimeout이 아니라 AudioContext
     시각으로 예약하므로 타이머 지터와 무관하게 정확하다.
   · 스템 모드: 엔진의 AudioContext를 그대로 쓰고, 미디어 시각 → 컨텍스트
     시각 변환(mediaToCtxTime)을 받아 샘플 정밀로 예약한다.
   · 유튜브 모드: 자체 컨텍스트에서 (미디어 시각 차 ÷ 배속)만큼 앞으로 예약.
     배속이 바뀌어도 매 폴링마다 현재 시각 기준으로 다시 계산하므로 간격이
     자동으로 따라간다.
   · 미디어 시각 기준이라 t0/BPM 캘리브레이션 결과가 그대로 반영된다.

   ── opts ────────────────────────────────────────────────────────
   mount        컨트롤을 그릴 엘리먼트
   storageKey   localStorage 키 ({on, vol, div} 저장)
   getContext   () => AudioContext|null — 스템 컨텍스트(없으면 자체 생성)
   getTiming    () => null | { playing, time, t0, bpm, rate, ctxTime }
                  playing  재생 중 여부
                  time     현재 미디어 시각(초)
                  t0       1마디 시작 시각(초)
                  bpm      ♩ (마디 = 4박)
                  rate     재생 배속
                  ctxTime  (선택) 미디어 시각 → 컨텍스트 시각 변환 함수.
                           null을 돌려주면 배속 기반 근사로 대체한다.
   onChange     UI 높이가 바뀌었을 때 훅(상단 고정 영역 재측정용)
   ──────────────────────────────────────────────────────────────── */
window.Metronome = (function(){

  const TICK_MS   = 90;     // 폴링 간격
  const LOOKAHEAD = 0.30;   // 미리 예약할 길이(초, 미디어 시각 기준)
  const ANCHOR_TOL= 0.25;   // 앵커 예측 허용 오차(초, 미디어 시각). 배속만큼 넓어진다.
  const ANCHOR_MISS= 2;     // 연속 이만큼 벗어나야 앵커를 다시 잡는다(순간적인 튐 무시)
  const EPS       = 1e-4;

  // 세분화: 한 박(♩)을 몇 개로 나눠 칠지
  const DIVS = [
    { v: 0.5, label: '½',  hint: '2분' },
    { v: 1,   label: '1x', hint: '4분' },
    { v: 2,   label: '2x', hint: '8분' }
  ];

  function injectCSS(){
    if(document.getElementById('metronome-css')) return;
    const s = document.createElement('style');
    s.id = 'metronome-css';
    s.textContent =
      '.mt-row{display:flex;gap:5px;align-items:center;margin-top:6px}'
    + '.mt-btn{padding:8px 0;border-radius:7px;border:1px solid var(--line);'
    +   'background:var(--panel);color:var(--dim);font-size:12px;font-weight:700;cursor:pointer}'
    + '.mt-btn.on{background:var(--gold);border-color:var(--gold);color:#1a1508}'
    + '.mt-btn.tog{flex:2}'
    + '.mt-btn.div{flex:1}'
    + '.mt-lb{font-size:10.5px;color:var(--dim);min-width:30px}'
    + '.mt-range{flex:1;accent-color:var(--gold);min-width:0}'
    + '.mt-val{min-width:38px;text-align:right;font-size:12px;font-weight:800;color:var(--gold);'
    +   'font-family:ui-monospace,monospace}';
    document.head.appendChild(s);
  }

  function create(opts){
    injectCSS();
    const mount      = opts.mount;
    const storageKey = opts.storageKey || 'metro';
    const getContext = opts.getContext || function(){ return null; };
    const getTiming  = opts.getTiming;
    const onChange   = opts.onChange || function(){};

    let on = false, vol = 0.6, div = 1;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
      on  = !!saved.on;
      if(typeof saved.vol === 'number') vol = Math.max(0, Math.min(1, saved.vol));
      if(saved.div === 0.5 || saved.div === 1 || saved.div === 2) div = saved.div;
    } catch(e){}

    let ownCtx = null;        // 유튜브 모드용 자체 컨텍스트(첫 제스처에서 생성)
    let curCtx = null;        // 현재 예약에 쓰는 컨텍스트
    let timer  = null;
    let nextK  = null;        // 다음에 예약할 박 번호(t0 기준)
    let live   = [];          // 예약해 둔 노드(정지 시 취소용)
    let anchor = null;        // { m: 미디어 시각, c: 컨텍스트 시각, rate } 기준점
    let miss   = 0;           // 앵커 예측이 연속으로 빗나간 횟수

    /* ---- 마크업 ---- */
    mount.innerHTML = ''
      + '<div class="mt-row">'
      +   '<button type="button" class="mt-btn tog">🔔 메트로놈</button>'
      +   DIVS.map(function(d){
            return '<button type="button" class="mt-btn div" data-div="' + d.v + '">' + d.label + '</button>';
          }).join('')
      + '</div>'
      + '<div class="mt-row vol">'
      +   '<span class="mt-lb">클릭</span>'
      +   '<input type="range" class="mt-range" min="0" max="1" step="0.05">'
      +   '<span class="mt-val"></span>'
      + '</div>';
    const elTog   = mount.querySelector('.mt-btn.tog');
    const elDivs  = Array.prototype.slice.call(mount.querySelectorAll('.mt-btn.div'));
    const elRange = mount.querySelector('.mt-range');
    const elVal   = mount.querySelector('.mt-val');
    const elVol   = mount.querySelector('.mt-row.vol');

    function draw(){
      elTog.classList.toggle('on', on);
      elTog.textContent = on ? '🔔 메트로놈 ON' : '🔔 메트로놈';
      elDivs.forEach(function(b){
        b.classList.toggle('on', parseFloat(b.getAttribute('data-div')) === div);
      });
      elRange.value = String(vol);
      elVal.textContent = Math.round(vol * 100) + '%';
      // 꺼져 있을 때는 볼륨 줄을 감춘다 — 상단 고정 영역이 그만큼 낮아져
      // 차트가 더 많이 보인다(높이는 song-core가 런타임 측정해 반영)
      elVol.style.display = on ? '' : 'none';
    }
    function save(){
      try { localStorage.setItem(storageKey, JSON.stringify({ on: on, vol: vol, div: div })); } catch(e){}
    }

    /* ---- 컨텍스트 ---- */
    function ensureOwn(){
      if(ownCtx) return ownCtx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      try { ownCtx = new AC(); } catch(e){ return null; }
      // iOS 무음 스위치와 무관하게 미디어 채널로 재생 (Safari 16.4+, 스템 엔진과 동일)
      try { if(navigator.audioSession) navigator.audioSession.type = 'playback'; } catch(e){}
      // iOS는 제스처 밖에서 만든 컨텍스트를 suspended로 둔다.
      // (예: 저장된 ON 상태로 페이지를 다시 연 경우) 아무 조작에서나 한 번 깨운다.
      const wake = function(){
        if(ownCtx && ownCtx.state === 'suspended'){ try { ownCtx.resume(); } catch(e){} }
      };
      document.addEventListener('pointerdown', wake, { passive: true });
      document.addEventListener('touchend',    wake, { passive: true });
      document.addEventListener('keydown',     wake);
      return ownCtx;
    }
    function ctxFor(){
      const ext = getContext();          // 스템 모드면 엔진의 컨텍스트(샘플 정밀)
      return ext || ensureOwn();
    }

    /* ---- 클릭 합성 ---- */
    // kind: 'hi' 1박 강세 / 'lo' 2~4박 / 'sub' 세분화된 사이 박
    function click(c, when, kind){
      const f    = (kind === 'hi') ? 1760 : 1150;
      const amp  = vol * (kind === 'hi' ? 0.9 : kind === 'lo' ? 0.5 : 0.26);
      const dec  = (kind === 'hi') ? 0.055 : 0.04;
      if(amp <= 0) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'square';                 // 사각파 + 짧은 감쇠 = 또렷한 클릭
      o.frequency.setValueAtTime(f, when);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(amp, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dec);
      o.connect(g); g.connect(c.destination);
      try { o.start(when); o.stop(when + dec + 0.02); } catch(e){ return; }
      const rec = { o: o, g: g };
      o.onended = function(){
        const i = live.indexOf(rec);
        if(i >= 0) live.splice(i, 1);
        try { g.disconnect(); } catch(e){}
      };
      live.push(rec);
    }
    // 예약해 둔(아직 울리지 않은) 클릭까지 즉시 취소 — 정지/구간 점프용
    function cancel(){
      live.slice().forEach(function(rec){
        try { rec.o.onended = null; rec.o.stop(); } catch(e){}
        try { rec.o.disconnect(); rec.g.disconnect(); } catch(e){}
      });
      live = [];
      nextK = null;                      // 재개 시 박 위치를 다시 계산한다
      anchor = null; miss = 0;
    }

    /* ---- 미디어 시각 → 컨텍스트 시각 ----
       유튜브의 getCurrentTime()은 성기게(수백 ms 단위) 갱신돼서, 매번 그 값으로
       예약 시각을 새로 계산하면 클릭 간격이 들쭉날쭉해진다. 그래서 (미디어 시각,
       컨텍스트 시각) 앵커를 잡아 두고 그 위의 격자로 예약한다.
       구간 점프·seek는 박 번호 창(pump)에서 이미 걸러져 예약이 통째로 초기화되므로,
       여기서는 느리게 쌓이는 드리프트만 보면 된다. 성긴 갱신 한 번에 앵커가 흔들리지
       않도록 허용 오차를 배속에 비례해 잡고, 연속으로 빗나갈 때만 다시 잡는다. */
    function ctxAt(c, T, mt){
      if(T.ctxTime){                       // 스템 정속: 엔진이 주는 정확한 변환
        const v = T.ctxTime(mt);
        if(v != null) return v;
      }
      const rate = T.rate || 1;
      if(anchor && anchor.rate === rate){
        const predicted = anchor.m + (c.currentTime - anchor.c) * rate;
        if(Math.abs(predicted - T.time) < ANCHOR_TOL * Math.max(1, rate)) miss = 0;
        else miss++;
        if(miss < ANCHOR_MISS) return anchor.c + (mt - anchor.m) / rate;
      }
      miss = 0;
      anchor = { m: T.time, c: c.currentTime, rate: rate };
      return anchor.c + (mt - anchor.m) / rate;
    }

    /* ---- 스케줄러 ---- */
    function pump(){
      if(!on) return;
      const T = getTiming ? getTiming() : null;
      if(!T || !T.playing || !T.bpm){ if(live.length || nextK !== null) cancel(); return; }

      const c = ctxFor();
      if(!c) return;
      if(c !== curCtx){ cancel(); curCtx = c; }        // 소스 전환 → 예약 초기화
      if(c.state === 'suspended'){ try { c.resume(); } catch(e){} }

      const quarter = 60 / T.bpm;                      // ♩ 한 박(미디어 초)
      const step    = quarter / div;                   // 세분화된 클릭 간격
      const rate    = T.rate || 1;
      const now     = T.time;

      // 다음 예약 번호는 항상 [현재 박, 현재 박 + lookahead] 안에 있어야 한다.
      // 벗어났다면 구간 점프(A-B 루프)·seek·t0/BPM 변경이므로 예약을 버리고
      // 현재 위치에서 박을 다시 잡는다.
      const k       = Math.ceil((now - T.t0) / step - EPS);
      const ahead   = Math.ceil(LOOKAHEAD * rate / step) + 2;
      if(nextK === null || nextK < k || nextK > k + ahead){
        cancel();                    // 아직 울리지 않은 예약을 취소(cancel이 nextK를 비운다)
        nextK = k;
      }

      const horizon = now + LOOKAHEAD * rate;
      let guard = 64;
      while(nextK * step + T.t0 < horizon && guard-- > 0){
        const mt = T.t0 + nextK * step;                // 이 클릭의 미디어 시각
        nextK++;
        if(mt < 0) continue;                           // t0 이전(인트로 전)은 치지 않는다
        const when = ctxAt(c, T, mt);
        if(when < c.currentTime + 0.005) continue;     // 이미 지난 박은 건너뜀
        click(c, when, kindOf(mt, T.t0, quarter));
      }
    }
    // 마디 안 위치로 강세를 정한다. 마디 = ♩ 4박.
    function kindOf(mt, t0, quarter){
      const q  = (mt - t0) / quarter;
      const qi = Math.round(q);
      if(Math.abs(q - qi) > 0.01) return 'sub';        // 박 사이(8분 뒷박 등)
      return (((qi % 4) + 4) % 4 === 0) ? 'hi' : 'lo'; // 1박만 강세
    }

    function start(){
      if(timer) return;
      timer = setInterval(pump, TICK_MS);
      pump();
    }
    function stop(){
      if(timer){ clearInterval(timer); timer = null; }
      cancel();
    }

    /* ---- 이벤트 ---- */
    elTog.addEventListener('click', function(){
      on = !on;
      if(on){
        const c = ctxFor();                       // 제스처 안에서 컨텍스트 생성·resume
        if(c && c.state === 'suspended'){ try { c.resume(); } catch(e){} }
        start();
      } else {
        stop();
      }
      save(); draw(); onChange();     // 줄 수가 바뀌었으니 고정 영역 높이 재측정
    });
    elDivs.forEach(function(b){
      b.addEventListener('click', function(){
        div = parseFloat(b.getAttribute('data-div'));
        cancel();                                 // 간격이 바뀌면 예약을 다시 잡는다
        save(); draw();
      });
    });
    elRange.addEventListener('input', function(){
      vol = Math.max(0, Math.min(1, parseFloat(elRange.value) || 0));
      save(); draw();
    });

    draw();
    if(on) start();      // 저장된 ON 상태 — 컨텍스트는 첫 재생 제스처 뒤에 살아난다
    onChange();

    return {
      // 소스 전환·정지 등에서 즉시 클릭을 끊고 싶을 때
      reset: cancel,
      // 페이지 정리
      destroy: function(){ stop(); if(ownCtx){ try { ownCtx.close(); } catch(e){} ownCtx = null; } },
      get on(){ return on; },
      get div(){ return div; }
    };
  }

  return { create: create };
})();
