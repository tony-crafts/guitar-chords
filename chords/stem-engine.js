/* stem-engine.js — 로컬 음원(스템) 연습 엔진
   곡별로 오디오 파일 1~4개를 기기(IndexedDB)에 저장해 두고 동기 재생한다.
   서버에 음원을 올리지 않으므로 사이트를 공개해도 안전하다.

   ── 제공 ────────────────────────────────────────────────────────
   StemEngine.create({ mount, songId, mixKey, onReady, onChange })
     → 컨트롤러. 유튜브 IFrame API와 호환되는 플레이어 인터페이스를 함께 노출해
       song-core / practice.js(속도·A-B 루프)가 그대로 재사용된다.

       getCurrentTime() / getDuration() / getPlayerState()
       seekTo(t, allow) / playVideo() / pauseVideo()
       setPlaybackRate(r) / getPlaybackRate()
       addEventListener('onStateChange', fn) / removeEventListener(...)

   StemEngine.listTracks(songId) → Promise<[record]>
   StemEngine.clearSong(songId)  → Promise<void>

   ── 재생 경로 세 가지 ───────────────────────────────────────────
   'wa' 정속(1배속) — Web Audio.
        가져온 음원을 미리 전부 디코딩해 AudioBuffer로 들고 있다가,
        재생 시 4트랙의 AudioBufferSourceNode를 공통 기준시각
        (ctx.currentTime + START_LEAD)에 동시 start 한다. 같은 클럭에서
        같은 시각에 출발하므로 샘플 단위로 맞고 드리프트 보정이 필요 없다.
        디코딩을 끝내 놓기 때문에 첫 재생(콜드 스타트)도 어긋나지 않는다.
        트랙 음량은 GainNode — iOS는 audio.volume 변경을 무시하므로 필수.

   'mix' 배속(1배속 아님) — 믹스다운 + 단일 <audio>.
        AudioBufferSourceNode.playbackRate는 음정이 같이 변해(varispeed)
        연습에 못 쓰므로 배속은 preservesPitch가 되는 <audio>로 돌린다.
        다만 <audio>를 트랙마다 두면 4개가 서로 어긋나고 드리프트 보정까지
        끼어들어 iOS에서 음이 울렁거렸다. 그래서 배속 진입 시 현재 게인
        그대로 OfflineAudioContext로 한 트랙으로 렌더해 단일 <audio>로
        재생한다. 트랙이 하나뿐이라 동기 문제가 정의상 사라진다.
        게인이 파일에 구워지므로 이 엘리먼트는 AudioContext에 물리지
        않는다 — 덕분에 화면 잠금으로 컨텍스트가 suspend돼도 영향이 없고
        iOS 볼륨 제약도 받지 않는다. 음량을 바꾸면 재믹스한다(안내 표시).

   'legacy' Web Audio가 없는 브라우저 — <audio> 4개 + 드리프트 보정.
        0번 트랙이 기준. 2초 주기로 나머지 트랙의 currentTime을 검사해
        0.05초 이상이면 미세 배속(±10%)으로 수렴, 0.5초 이상이면 seek로
        회수한다(연속 seek 금지 간격 2.5초). 이동(seeking) 중인 트랙에
        currentTime을 다시 쓰면 seek가 재시작돼 그 트랙만 멈추므로 건너뛴다.

   ── 화면 잠금 ───────────────────────────────────────────────────
   iOS는 잠금 시 AudioContext를 suspended/interrupted로 바꾼다. 재생 버튼
   제스처에서 running이 아니면 resume을 기다렸다 시작하고, 화면 복귀·인터럽션
   종료 시에는 소스 노드가 죽었는지 알 수 없으므로 현재 위치에서 재구성한다.

   ── 메모리 ──────────────────────────────────────────────────────
   디코딩은 압축을 푸는 것이라 RAM을 크게 먹는다(5분21초 스테레오 48kHz면
   트랙당 118MB, 4트랙 471MB). MEM_BUDGET 안에 들도록 모노 → 낮은
   샘플레이트 순으로 자동 강등하고, 실제 사용량을 UI에 표시한다.
   ──────────────────────────────────────────────────────────────── */
window.StemEngine = (function(){
  'use strict';

  const DB_NAME = 'guitar-stems';
  const DB_VER  = 1;
  const STORE   = 'tracks';
  const MAX_TRACKS = 4;

  const START_LEAD = 0.12;    // 초 — 4트랙 동시 start까지 확보하는 여유
  const REMIX_WAIT = 500;     // 음량 변경 후 재믹스까지 기다리는 시간
  const DRIFT_TOL  = 0.05;    // 이하 'legacy' 경로 전용
  const HARD_TOL   = 0.5;
  const TRIM_MAX   = 0.10;
  const DRIFT_MS   = 2000;
  const SEEK_COOL  = 2500;

  const MEM_BUDGET = 220 * 1024 * 1024;   // 디코딩 총량 상한
  const LOW_RATES  = [32000, 22050];      // 모노로도 안 되면 이 순서로 강등

  /* ========================= IndexedDB ========================= */
  let dbp = null;

  function openDB(){
    if(dbp) return dbp;
    dbp = new Promise(function(res, rej){
      if(!window.indexedDB){ rej(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다')); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function(){
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)){
          const st = db.createObjectStore(STORE, { keyPath:'id' });
          st.createIndex('songId', 'songId', { unique:false });
        }
      };
      req.onsuccess = function(){ res(req.result); };
      req.onerror   = function(){ rej(req.error); };
    });
    return dbp;
  }

  function listTracks(songId){
    return openDB().then(function(db){
      return new Promise(function(res, rej){
        const tx  = db.transaction(STORE, 'readonly');
        const idx = tx.objectStore(STORE).index('songId');
        const out = [];
        const req = idx.openCursor(IDBKeyRange.only(songId));
        req.onsuccess = function(){
          const c = req.result;
          if(c){ out.push(c.value); c.continue(); }
          else { out.sort(function(a,b){ return a.order - b.order; }); res(out); }
        };
        req.onerror = function(){ rej(req.error); };
      });
    });
  }

  function clearSong(songId){
    return openDB().then(function(db){
      return new Promise(function(res, rej){
        const tx  = db.transaction(STORE, 'readwrite');
        const idx = tx.objectStore(STORE).index('songId');
        const req = idx.openCursor(IDBKeyRange.only(songId));
        req.onsuccess = function(){ const c = req.result; if(c){ c.delete(); c.continue(); } };
        tx.oncomplete = function(){ res(); };
        tx.onerror    = function(){ rej(tx.error); };
        tx.onabort    = function(){ rej(tx.error); };
      });
    });
  }

  // 곡의 기존 스템 삭제 + 새 스템 저장을 한 트랜잭션으로 처리한다.
  // 저장 도중 실패(용량 부족 등)하면 통째로 롤백돼 기존 스템이 살아남는다.
  function replaceTracks(songId, recs){
    return openDB().then(function(db){
      return new Promise(function(res, rej){
        const tx  = db.transaction(STORE, 'readwrite');
        const st  = tx.objectStore(STORE);
        const req = st.index('songId').openCursor(IDBKeyRange.only(songId));
        req.onsuccess = function(){
          const c = req.result;
          if(c){ c.delete(); c.continue(); }
          else { recs.forEach(function(r){ st.put(r); }); }   // 삭제가 끝난 뒤 저장
        };
        tx.oncomplete = function(){ res(); };
        tx.onerror    = function(){ rej(tx.error); };
        tx.onabort    = function(){
          rej(tx.error || new Error('저장 공간이 부족할 수 있습니다'));
        };
      });
    });
  }

  // 저장 지속성 요청(사용자 제스처 직후 호출해야 승인 확률이 높다)
  function requestPersist(){
    if(!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persisted().then(function(already){
      return already ? true : navigator.storage.persist();
    }).catch(function(){ return false; });
  }

  function storageInfo(){
    const out = { persisted:null, usage:null, quota:null };
    if(!navigator.storage) return Promise.resolve(out);
    const jobs = [];
    if(navigator.storage.persisted){
      jobs.push(navigator.storage.persisted().then(function(v){ out.persisted = v; }).catch(function(){}));
    }
    if(navigator.storage.estimate){
      jobs.push(navigator.storage.estimate().then(function(e){
        out.usage = e.usage; out.quota = e.quota;
      }).catch(function(){}));
    }
    return Promise.all(jobs).then(function(){ return out; });
  }

  /* ========================= 파일 → 레코드 ========================= */
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aif|aiff|ogg|oga|opus|flac|caf|weba|webm)$/i;

  function isAudio(f){
    return (f.type && f.type.indexOf('audio/') === 0) || AUDIO_EXT.test(f.name || '');
  }
  function baseName(n){
    return String(n || '트랙').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || '트랙';
  }
  // Blob/File → ArrayBuffer (Safari 14 미만 대비 FileReader 폴백)
  function readBuf(f){
    if(f.arrayBuffer) return f.arrayBuffer();
    return new Promise(function(res, rej){
      const r = new FileReader();
      r.onload  = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
      r.readAsArrayBuffer(f);
    });
  }

  // 곡의 스템을 통째로 교체 저장. onProgress(i, total, name)
  function importFiles(songId, files, onProgress){
    const all  = Array.prototype.slice.call(files);
    const list = all.filter(isAudio).slice(0, MAX_TRACKS);
    if(!list.length) return Promise.reject(new Error('오디오 파일을 찾지 못했습니다'));

    return requestPersist()
      .then(function(){
        // 1) 먼저 전부 읽어 레코드를 만든다 — 여기서 실패해도 기존 저장분은 그대로다
        const recs = [];
        let chain = Promise.resolve();
        list.forEach(function(f, i){
          chain = chain.then(function(){
            if(onProgress) onProgress(i, list.length, f.name);
            return readBuf(f).then(function(buf){
              const type = f.type || 'audio/mpeg';
              recs.push({
                id: songId + '::' + i + '::' + f.name,
                songId: songId,
                order: i,
                name: baseName(f.name),
                type: type,
                size: buf.byteLength,
                blob: new Blob([buf], { type: type }),
                savedAt: Date.now()
              });
            });
          });
        });
        return chain.then(function(){ return recs; });
      })
      .then(function(recs){
        // 2) 기존 삭제 + 새 저장을 한 트랜잭션으로 (실패 시 기존 스템 유지)
        return replaceTracks(songId, recs).then(function(){
          return { saved: recs.length, skipped: all.length - list.length };
        });
      });
  }

  /* ========================= 디코딩 ========================= */
  function OfflineCtx(){ return window.OfflineAudioContext || window.webkitOfflineAudioContext; }
  function OnlineCtx(){ return window.AudioContext || window.webkitAudioContext; }
  function waSupported(){ return !!(OnlineCtx() && OfflineCtx()); }

  // 길이·트랙수로 채널/샘플레이트를 정해 MEM_BUDGET 안에 들어오게 한다
  function decodePlan(seconds, n, nativeRate){
    const bytes = function(ch, sr){ return seconds * sr * ch * 4 * n; };
    if(bytes(2, nativeRate) <= MEM_BUDGET) return { ch:2, rate:nativeRate };
    if(bytes(1, nativeRate) <= MEM_BUDGET) return { ch:1, rate:nativeRate };
    for(let i = 0; i < LOW_RATES.length; i++){
      if(bytes(1, LOW_RATES[i]) <= MEM_BUDGET) return { ch:1, rate:LOW_RATES[i] };
    }
    return { ch:1, rate:LOW_RATES[LOW_RATES.length - 1] };
  }

  // OfflineAudioContext로 디코딩하면 그 컨텍스트의 샘플레이트로 리샘플된다.
  // (재생용 AudioContext는 사용자 제스처 전에 만들지 않아도 되게 분리)
  function decodeBlob(blob, targetRate, wantMono){
    const OC = OfflineCtx();
    return readBuf(blob).then(function(arr){
      const oc = new OC(1, Math.max(1, Math.round(targetRate)), targetRate);
      return new Promise(function(res, rej){
        const p = oc.decodeAudioData(arr, res, rej);
        if(p && p.then) p.then(res, rej);
      }).then(function(ab){
        if(!wantMono || ab.numberOfChannels < 2) return ab;
        const out = oc.createBuffer(1, ab.length, ab.sampleRate);
        const o = out.getChannelData(0);
        const L = ab.getChannelData(0), R = ab.getChannelData(1);
        for(let i = 0; i < ab.length; i++) o[i] = (L[i] + R[i]) * 0.5;
        return out;                                  // 스테레오 버퍼는 여기서 버려진다
      });
    });
  }

  /* ========================= 믹스다운 → WAV ========================= */
  // 렌더된 AudioBuffer를 16bit WAV Blob으로. 합산이 풀스케일을 넘으면
  // 잘리므로(스템을 다 더하면 원곡 마스터 수준이 된다) 피크를 먼저 재고 줄인다.
  function wavBlob(ab){
    const ch = ab.numberOfChannels, n = ab.length, sr = ab.sampleRate;
    const data = [];
    for(let c = 0; c < ch; c++) data.push(ab.getChannelData(c));

    let peak = 0;
    for(let c = 0; c < ch; c++){
      const d = data[c];
      for(let i = 0; i < n; i++){ const v = d[i] < 0 ? -d[i] : d[i]; if(v > peak) peak = v; }
    }
    const scale = (peak > 0.999) ? (0.999 / peak) : 1;

    const bytes = 44 + n * ch * 2;
    const buf = new ArrayBuffer(bytes), dv = new DataView(buf);
    const ws = function(o, s){ for(let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF');  dv.setUint32(4, bytes - 8, true);  ws(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);       dv.setUint16(20, 1, true);
    dv.setUint16(22, ch, true);       dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true);
    dv.setUint16(34, 16, true);       ws(36, 'data');  dv.setUint32(40, n * ch * 2, true);

    let off = 44;
    for(let i = 0; i < n; i++){
      for(let c = 0; c < ch; c++){
        let v = data[c][i] * scale;
        if(v < -1) v = -1; else if(v > 1) v = 1;
        dv.setInt16(off, v * 32767, true);
        off += 2;
      }
    }
    return new Blob([buf], { type:'audio/wav' });
  }

  /* ========================= 표시 유틸 ========================= */
  function fmtTime(t){
    if(!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtSize(b){
    if(!isFinite(b) || b <= 0) return '—';
    if(b < 1024 * 1024) return Math.round(b / 1024) + 'KB';
    return (b / 1024 / 1024).toFixed(1) + 'MB';
  }

  /* ========================= CSS ========================= */
  function injectCSS(){
    if(document.getElementById('stem-engine-css')) return;
    const s = document.createElement('style');
    s.id = 'stem-engine-css';
    s.textContent = `
.st-wrap{
  border:1px solid var(--line); border-radius:8px; background:var(--panel);
  padding:9px 10px; font-size:11.5px; color:var(--dim); line-height:1.55;
}
.st-hide{display:none !important}
.st-lead{margin-bottom:7px}
.st-lead b{color:var(--gold); font-weight:700}
.st-btn{
  padding:8px 12px; border-radius:7px; border:1px solid var(--line);
  background:var(--bg); color:var(--text); font-size:12px; font-weight:700;
  cursor:pointer; font-family:inherit;
}
.st-btn:disabled{opacity:.5; cursor:default}
.st-btn.pri{background:var(--gold); border-color:var(--gold); color:#1a1508}
.st-btn.sm{padding:6px 9px; font-size:11px}
.st-tp{display:flex; align-items:center; gap:8px}
.st-play{
  flex:0 0 auto; width:42px; height:34px; border-radius:7px;
  border:1px solid var(--gold); background:var(--gold); color:#1a1508;
  font-size:14px; font-weight:800; cursor:pointer; line-height:1;
}
.st-play:disabled{opacity:.5; cursor:default}
.st-seek{flex:1; min-width:0; accent-color:var(--gold)}
.st-time{
  flex:0 0 auto; font-family:ui-monospace,'SF Mono',Menlo,monospace;
  font-size:11px; color:var(--dim); letter-spacing:.2px;
}
.st-tracks{margin-top:8px}
.st-tr{display:flex; align-items:center; gap:7px; margin-top:5px}
.st-mute{
  flex:0 0 auto; width:30px; height:26px; border-radius:6px;
  border:1px solid var(--line); background:var(--bg); color:var(--dim);
  font-size:11px; font-weight:800; cursor:pointer; line-height:1;
}
.st-mute.off{border-color:var(--brg); color:var(--brg)}
.st-name{
  flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:11.5px; color:var(--text);
}
.st-tr.muted .st-name{color:var(--dim); text-decoration:line-through}
.st-name i{font-style:normal; font-size:9.5px; color:var(--gold); margin-left:4px}
.st-vol{flex:0 0 84px; accent-color:var(--gold); min-width:0}
.st-foot{
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  margin-top:9px; padding-top:8px; border-top:1px solid var(--line);
}
.st-info{flex:1 1 auto; min-width:0; font-size:10px; color:var(--dim); line-height:1.5}
.st-sync{
  flex:0 0 auto; font-size:10px; color:var(--dim);
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
}
.st-sync.lock{color:var(--verse,#7fb4a8)}
.st-msg{margin-top:7px; font-size:10.5px; color:var(--brg,#e07b5f); line-height:1.5}
.st-msg.ok{color:var(--verse,#7fb4a8)}
`;
    document.head.appendChild(s);
  }

  /* ========================= 컨트롤러 ========================= */
  /* opts:
       mount   : 컨테이너 엘리먼트
       songId  : 곡 식별자(= song-core prefix)
       mixKey  : 음소거/볼륨 저장 localStorage 키(선택)
       onReady : 트랙이 붙고 재생 준비가 끝났을 때
       onChange: 패널 높이/상태가 바뀌었을 때(레이아웃 갱신용)          */
  function create(opts){
    injectCSS();
    const mount   = opts.mount;
    const songId  = opts.songId;
    const mixKey  = opts.mixKey || (songId + '_stem_mix');
    const onReady = opts.onReady || function(){};
    const onChange= opts.onChange || function(){};

    let tracks   = [];        // { rec, buffer, audio, url, gain, meSrc, node, muted, volume, seekAt }
    let ctx      = null;      // 재생용 AudioContext (첫 제스처에서 생성)
    let waOK     = waSupported();
    let mode     = 'wa';      // 'wa' 정속 | 'mix' 배속(믹스다운) | 'legacy' Web Audio 없음
    let rate     = 1;
    let mixEl    = null, mixUrl = null, mixSig = '';   // 배속용 믹스다운
    let preparing= false;     // 믹스 렌더 중
    let remixId  = null;
    let lastBuildAt = 0;      // 마지막 소스 재구성 시각(중복 복구 방지)
    let playing  = false, started = false, ended = false;
    let waStartAt= 0, waOffset = 0;      // Web Audio 위치 계산 기준
    let pausedPos= 0;
    let dur      = 0;
    let decodeState = 'idle'; // idle | decoding | done | fail
    let decodeInfo  = '';
    let seeking  = false;
    let listeners= [];
    let driftId  = null, uiId = null;
    let resyncIds= [];
    let lastState= -1;

    /* ---- 마크업 ---- */
    mount.classList.add('st-wrap');
    mount.innerHTML = ''
      + '<div class="st-empty">'
      +   '<div class="st-lead"><b>스템 연습</b> — 이 기기에 저장한 음원으로 연습합니다. '
      +     '파일은 브라우저 안에만 보관되고 어디로도 전송되지 않습니다. '
      +     '오디오 파일을 최대 ' + MAX_TRACKS + '개까지 고르세요(첫 파일이 동기화 기준).</div>'
      +   '<button type="button" class="st-btn pri st-pick">스템 가져오기</button>'
      + '</div>'
      + '<div class="st-main st-hide">'
      +   '<div class="st-tp">'
      +     '<button type="button" class="st-play" disabled>▶</button>'
      +     '<input type="range" class="st-seek" min="0" max="100" step="0.01" value="0" disabled>'
      +     '<span class="st-time">0:00 / 0:00</span>'
      +   '</div>'
      +   '<div class="st-tracks"></div>'
      +   '<div class="st-foot">'
      +     '<span class="st-info"></span>'
      +     '<span class="st-sync"></span>'
      +     '<button type="button" class="st-btn sm st-repick">다시 가져오기</button>'
      +   '</div>'
      + '</div>'
      + '<div class="st-msg st-hide"></div>'
      + '<input type="file" class="st-file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.aiff" multiple hidden>';

    const elEmpty  = mount.querySelector('.st-empty');
    const elMain   = mount.querySelector('.st-main');
    const elPlay   = mount.querySelector('.st-play');
    const elSeek   = mount.querySelector('.st-seek');
    const elTime   = mount.querySelector('.st-time');
    const elTracks = mount.querySelector('.st-tracks');
    const elInfo   = mount.querySelector('.st-info');
    const elSync   = mount.querySelector('.st-sync');
    const elMsg    = mount.querySelector('.st-msg');
    const elFile   = mount.querySelector('.st-file');
    const elRepick = mount.querySelector('.st-repick');
    const elPick   = mount.querySelector('.st-pick');

    /* ---- 메시지 ---- */
    function msg(text, ok){
      elMsg.textContent = text || '';
      elMsg.classList.toggle('ok', !!ok);
      elMsg.classList.toggle('st-hide', !text);
      onChange();
    }

    /* ---- 오디오 컨텍스트 (iOS: 반드시 사용자 제스처 안에서 생성·resume) ---- */
    function ensureCtx(){
      if(ctx || !waOK) return ctx;
      const AC = OnlineCtx();
      try { ctx = new AC(); } catch(e){ waOK = false; return null; }
      // iOS 무음 스위치와 무관하게 미디어 채널로 재생 (Safari 16.4+)
      try { if(navigator.audioSession) navigator.audioSession.type = 'playback'; } catch(e){}
      // 인터럽션(전화·잠금)이 끝나 running으로 돌아오면 소스를 다시 세운다
      ctx.addEventListener('statechange', function(){
        if(ctx && ctx.state === 'running') recover();
      });
      tracks.forEach(ensureGain);
      return ctx;
    }
    function ensureGain(tr){
      if(!ctx || tr.gain) return;
      tr.gain = ctx.createGain();
      tr.gain.connect(ctx.destination);
      applyMix(tr);
    }
    function resumeCtx(){
      const c = ensureCtx();
      if(c && c.state === 'suspended'){ try { c.resume(); } catch(e){} }
      return c;
    }

    /* ---- 믹스(음소거/볼륨) ---- */
    function loadMix(){
      try { return JSON.parse(localStorage.getItem(mixKey) || '{}') || {}; } catch(e){ return {}; }
    }
    function saveMix(){
      const m = {};
      tracks.forEach(function(t){ m[t.rec.name] = { m:t.muted, v:t.volume }; });
      try { localStorage.setItem(mixKey, JSON.stringify(m)); } catch(e){}
    }
    // iOS Safari는 audio.volume 대입을 무시한다(스펙상 하드웨어 볼륨만 사용).
    // 그래서 음량은 GainNode로 건다. Web Audio가 없을 때만 엘리먼트 볼륨 폴백.
    function applyMix(tr){
      const g = tr.muted ? 0 : tr.volume;
      if(tr.gain){ try { tr.gain.gain.value = g; } catch(e){} }
      if(tr.audio){
        tr.audio.muted = false;
        // MediaElementSource로 그래프에 물린 뒤에는 엘리먼트 볼륨이 의미 없다(GainNode 담당).
        // 아직 안 물렸으면 엘리먼트 볼륨이 유일한 수단이므로 그대로 반영한다.
        tr.audio.volume = tr.meSrc ? 1 : g;
      }
    }

    /* ---- 상태 ---- */
    function hasTracks(){ return tracks.length > 0; }
    function duration(){ return dur; }
    function setTime(a, t){ try { a.currentTime = t; } catch(e){} }
    function playable(){
      return hasTracks() && (decodeState === 'done' || decodeState === 'fail' || !waOK);
    }
    // 모드는 캐시하지 않고 그때그때 파생시킨다. 디코딩이 끝나기 전에 들어온
    // setPlaybackRate(1)(속도 컨트롤 초기화) 때문에 폴백으로 굳는 것을 막는다.
    function wantMode(){
      if(!waOK || decodeState !== 'done') return 'legacy';
      return (Math.abs(rate - 1) < 1e-6) ? 'wa' : 'mix';
    }

    function waPos(){
      if(!ctx) return pausedPos;
      const t = waOffset + (ctx.currentTime - waStartAt);
      if(t < waOffset) return waOffset;                  // 아직 start 예약 시각 전
      return dur ? Math.min(t, dur) : t;
    }
    function mePos(){ return tracks.length ? tracks[0].audio.currentTime : pausedPos; }
    function currentTime(){
      if(!hasTracks()) return 0;
      if(!playing || preparing) return pausedPos;
      if(mode === 'wa')  return waPos();
      if(mode === 'mix') return mixEl ? mixEl.currentTime : pausedPos;
      return mePos();
    }
    // 유튜브 규약: -1 미시작 / 0 종료 / 1 재생 / 2 일시정지 / 3 버퍼링
    function playerState(){
      if(!hasTracks() || !started) return -1;
      if(preparing) return 3;                  // 믹스 준비 중 — 루프 폴링이 끼어들지 않게
      if(ended) return 0;
      return playing ? 1 : 2;
    }
    function emitState(){
      const s = playerState();
      if(s === lastState) return;
      lastState = s;
      listeners.slice().forEach(function(fn){ try { fn({ data:s, target:api }); } catch(e){} });
    }
    // 'legacy' 경로에서 트랙 간 최대 시각 차 ('wa'는 샘플 동기, 'mix'는 단일 트랙)
    function spread(){
      if(mode !== 'legacy' || tracks.length < 2) return 0;
      let mn = Infinity, mx = -Infinity;
      tracks.forEach(function(tr){
        const c = tr.audio.currentTime;
        if(c < mn) mn = c;
        if(c > mx) mx = c;
      });
      return mx - mn;
    }

    /* ---- 'wa' 경로: 4트랙 동시 start ---- */
    function waStart(offset){
      const c = resumeCtx();
      if(!c) return false;
      const when = c.currentTime + START_LEAD;    // 전 트랙 공통 기준시각
      let any = false;
      tracks.forEach(function(tr){
        ensureGain(tr);
        if(!tr.buffer) return;
        const n = c.createBufferSource();
        n.buffer = tr.buffer;
        n.connect(tr.gain);
        const off = Math.max(0, Math.min(offset, Math.max(0, tr.buffer.duration - 0.01)));
        try { n.start(when, off); } catch(e){ return; }
        tr.node = n;
        any = true;
      });
      if(!any) return false;
      if(tracks[0].node){
        tracks[0].node.onended = function(){        // 자연 종료(정지 시엔 onended를 떼고 stop)
          if(mode === 'wa' && playing){
            playing = false; ended = true; pausedPos = dur;
            drawTransport(); emitState();
          }
        };
      }
      waStartAt = when; waOffset = offset; lastBuildAt = Date.now();
      return true;
    }
    function waStop(){
      tracks.forEach(function(tr){
        if(!tr.node) return;
        try { tr.node.onended = null; tr.node.stop(); } catch(e){}
        try { tr.node.disconnect(); } catch(e){}
        tr.node = null;
      });
    }

    /* ---- 'mix' 경로: 현재 게인 그대로 한 트랙으로 렌더 → 단일 <audio> ---- */
    function gainSig(){
      return tracks.map(function(t){ return (t.muted ? 0 : t.volume).toFixed(2); }).join(',');
    }
    function renderMix(){
      const OC = OfflineCtx();
      const base = tracks[0] && tracks[0].buffer;
      if(!OC || !base) return Promise.reject(new Error('믹스할 음원이 없습니다'));
      let len = 0, ch = 1;
      tracks.forEach(function(tr){
        if(!tr.buffer) return;
        if(tr.buffer.length > len) len = tr.buffer.length;
        if(tr.buffer.numberOfChannels > ch) ch = tr.buffer.numberOfChannels;
      });
      const oc = new OC(ch, len, base.sampleRate);
      tracks.forEach(function(tr){
        if(!tr.buffer) return;
        const s = oc.createBufferSource(); s.buffer = tr.buffer;
        const g = oc.createGain();         g.gain.value = tr.muted ? 0 : tr.volume;
        s.connect(g); g.connect(oc.destination);
        s.start(0);
      });
      const done = oc.startRendering();
      const p = (done && done.then) ? done : new Promise(function(res){ oc.oncomplete = function(e){ res(e.renderedBuffer); }; });
      return p.then(function(rendered){
        const blob = wavBlob(rendered);     // 렌더 버퍼는 여기서 버려진다(이중 보관 최소화)
        return blob;
      });
    }
    // 게인 구성이 같으면 이미 만든 믹스를 그대로 쓴다
    function ensureMix(){
      const sig = gainSig();
      if(mixEl && mixSig === sig && mixEl.src) return Promise.resolve(mixEl);
      preparing = true;
      msg('배속 재생용 믹스 준비 중… (1~2초)');
      drawTransport();
      return renderMix().then(function(blob){
        if(!mixEl){
          mixEl = new Audio();
          mixEl.playsInline = true;
          mixEl.preload = 'auto';
          if('preservesPitch' in mixEl) mixEl.preservesPitch = true;
          mixEl.webkitPreservesPitch = true;
          mixEl.mozPreservesPitch = true;
          mixEl.addEventListener('ended', function(){
            if(mode === 'mix' && playing){
              playing = false; ended = true; pausedPos = dur;
              drawTransport(); emitState();
            }
          });
        }
        // 게인이 파일에 구워져 있으므로 AudioContext에 물리지 않는다.
        // (컨텍스트가 잠금으로 suspend돼도 이 경로는 영향받지 않는다)
        const old = mixUrl;
        mixUrl = URL.createObjectURL(blob);
        mixEl.src = mixUrl;
        if(old) URL.revokeObjectURL(old);
        mixSig = sig;
        preparing = false;
        msg('');
        drawTransport();
        return mixEl;
      }).catch(function(err){
        preparing = false;
        msg('믹스 준비 실패: ' + (err && err.message ? err.message : err));
        drawTransport();
        throw err;
      });
    }
    function mixStart(pos){
      return ensureMix().then(function(el){
        el.playbackRate = rate;
        if(Math.abs(el.currentTime - pos) > 0.05) setTime(el, pos);
        const p = el.play();
        if(p && p.catch) p.catch(function(){});
        drawTransport(); emitState();
      }).catch(function(){
        playing = false; drawTransport(); emitState();
      });
    }
    function mixStop(){ if(mixEl){ try { mixEl.pause(); } catch(e){} } }
    // 음량을 바꾸면 구워진 믹스가 낡는다 → 잠깐 기다렸다 다시 렌더
    function scheduleRemix(){
      if(mode !== 'mix') return;              // 정속은 GainNode라 실시간 반영
      clearTimeout(remixId);
      remixId = setTimeout(function(){
        const pos = currentTime(), wasPlaying = playing;
        pausedPos = pos;              // 준비 중 표시 위치가 0으로 튀지 않게
        mixStop();
        ensureMix().then(function(el){
          el.playbackRate = rate;
          setTime(el, pos);
          if(wasPlaying){ const p = el.play(); if(p && p.catch) p.catch(function(){}); }
        }).catch(function(){});
      }, REMIX_WAIT);
    }

    /* ---- 'legacy' 경로: Web Audio가 없는 브라우저용 <audio> 4개 ---- */
    function meWire(){
      const c = resumeCtx();
      tracks.forEach(function(tr){
        tr.audio.preload = 'auto';
        if(c && !tr.meSrc && c.createMediaElementSource){
          ensureGain(tr);
          try {
            tr.meSrc = c.createMediaElementSource(tr.audio);
            tr.meSrc.connect(tr.gain);
            applyMix(tr);                        // 음량 담당이 게인으로 넘어간다
          } catch(e){ tr.meSrc = null; }         // 실패하면 엘리먼트 볼륨 유지
        }
      });
    }
    function meStart(offset){
      meWire();
      tracks.forEach(function(tr){
        const a = tr.audio;
        a.playbackRate = rate;
        if(Math.abs(a.currentTime - offset) > 0.03) setTime(a, offset);
        const p = a.play();
        if(p && p.catch) p.catch(function(err){
          msg('재생 실패: ' + (err && err.message ? err.message : err));
        });
      });
      scheduleResync();
    }
    function meStop(){
      tracks.forEach(function(tr){ try { tr.audio.pause(); } catch(e){} });
    }

    /* ---- 공통 재생 제어 ---- */
    function startAt(pos){
      mode = wantMode();
      playing = true; started = true;
      if(mode === 'wa'){
        if(!waStart(pos)){ mode = 'legacy'; meStart(pos); }
      } else if(mode === 'mix'){
        mixStart(pos);
      } else {
        meStart(pos);
      }
      drawTransport(); emitState();
    }
    function play(){
      if(!hasTracks() || !playable()) return;
      const pos = ended ? 0 : pausedPos;
      ended = false;
      const c = ensureCtx();
      // 화면 잠금 뒤에는 컨텍스트가 suspended/interrupted로 남아 있다.
      // 제스처 안에서 resume을 걸고, 깨어난 다음에 시작한다.
      if(c && c.state !== 'running'){
        preparing = true; drawTransport();
        const go = function(){ preparing = false; startAt(pos); };
        let r; try { r = c.resume(); } catch(e){}
        if(r && r.then) r.then(go, go); else go();
        return;
      }
      startAt(pos);
    }
    function pause(){
      if(!playing){ drawTransport(); return; }
      const pos = currentTime();
      if(mode === 'wa') waStop(); else if(mode === 'mix') mixStop(); else meStop();
      pausedPos = pos; playing = false;
      drawTransport(); emitState();
    }
    function toggle(){ if(playing) pause(); else play(); }

    function seekTo(t){
      if(!hasTracks()) return;
      const d = dur || 0;
      t = Math.max(0, d ? Math.min(d - 0.05, t) : t);
      ended = false;
      if(playing){
        if(mode === 'wa'){ waStop(); waStart(t); }
        else if(mode === 'mix'){ if(mixEl) setTime(mixEl, t); }
        else {
          tracks.forEach(function(tr){ setTime(tr.audio, t); tr.audio.playbackRate = rate; });
          scheduleResync();
        }
      } else {
        pausedPos = t;
        if(mode === 'mix' && mixEl) setTime(mixEl, t);
        else if(mode === 'legacy') tracks.forEach(function(tr){ setTime(tr.audio, t); });
      }
      drawTransport(); emitState();
    }

    // 1배속이면 Web Audio(샘플 동기), 그 외에는 음정 유지가 되는 <audio>로 전환
    function setRate(r){
      const nr = Math.max(0.25, Math.min(2, r || 1));
      const prevRate = rate;
      rate = nr;
      const want = wantMode();
      if(nr === prevRate && want === mode) return;
      const pos = currentTime();
      const wasPlaying = playing;
      if(wasPlaying){
        if(mode === 'wa') waStop(); else if(mode === 'mix') mixStop(); else meStop();
      }
      mode = want;
      if(wasPlaying){
        pausedPos = pos;              // 믹스 준비 중에도 표시 위치를 유지
        if(mode === 'wa') waStart(pos);
        else if(mode === 'mix') mixStart(pos);
        else meStart(pos);
      } else {
        pausedPos = pos;
        // 배선·믹스는 실제로 그 경로로 재생할 때만 준비한다.
        if(mode === 'mix' && mixEl){ mixEl.playbackRate = rate; setTime(mixEl, pos); }
        else if(mode === 'legacy'){
          tracks.forEach(function(tr){ setTime(tr.audio, pos); tr.audio.playbackRate = rate; });
        }
      }
      drawTransport();
    }

    /* ---- 드리프트 보정 ('me' 경로 전용) ---- */
    function scheduleResync(){
      resyncIds.forEach(clearTimeout);
      resyncIds = [400, 1000, 1600].map(function(ms){ return setTimeout(correctDrift, ms); });
    }
    function correctDrift(){
      if(mode !== 'legacy' || !playing || tracks.length < 2) return;
      const m = tracks[0].audio;
      if(m.seeking) return;                    // 기준이 이동 중이면 판단을 미룬다
      const ref = m.currentTime;
      const now = Date.now();
      for(let i = 1; i < tracks.length; i++){
        const tr = tracks[i], a = tr.audio;
        // 이동이 끝나기 전에 currentTime을 다시 쓰면 seek가 재시작되어 그 트랙만
        // 계속 멈춰 있게 된다. 이동 중인 트랙은 반드시 건너뛴다.
        if(a.seeking) continue;
        if(a.paused){
          if(now - (tr.seekAt || 0) < SEEK_COOL) continue;
          tr.seekAt = now;
          setTime(a, ref);
          a.playbackRate = rate;
          const p = a.play(); if(p && p.catch) p.catch(function(){});
          continue;
        }
        const d  = a.currentTime - ref;
        const ad = Math.abs(d);
        if(ad > HARD_TOL){
          if(now - (tr.seekAt || 0) < SEEK_COOL) continue;
          tr.seekAt = now;
          setTime(a, ref);
          a.playbackRate = rate;
        } else if(ad > DRIFT_TOL){
          const trim = Math.max(-TRIM_MAX, Math.min(TRIM_MAX, -d / (DRIFT_MS / 1000)));
          a.playbackRate = rate * (1 + trim);
        } else if(Math.abs(a.playbackRate - rate) > 1e-4){
          a.playbackRate = rate;
        }
      }
    }

    /* ---- 그리기 ---- */
    function drawTransport(){
      const t = currentTime();
      elPlay.textContent = playing ? '❚❚' : '▶';
      elPlay.disabled = !playable();
      elSeek.disabled = !playable() || !dur;
      if(dur){ elSeek.max = String(dur); if(!seeking) elSeek.value = String(Math.min(t, dur)); }
      elTime.textContent = fmtTime(seeking ? parseFloat(elSeek.value) : t) + ' / ' + fmtTime(dur);
    }

    function drawTracks(){
      elTracks.innerHTML = '';
      tracks.forEach(function(tr, i){
        const row = document.createElement('div');
        row.className = 'st-tr' + (tr.muted ? ' muted' : '');

        const mb = document.createElement('button');
        mb.type = 'button';
        mb.className = 'st-mute' + (tr.muted ? ' off' : '');
        mb.textContent = tr.muted ? '🔇' : '🔊';
        mb.title = tr.muted ? '음소거 해제' : '음소거';
        mb.addEventListener('click', function(){
          tr.muted = !tr.muted;
          applyMix(tr); saveMix(); drawTracks(); scheduleRemix();
        });

        const nm = document.createElement('span');
        nm.className = 'st-name';
        nm.textContent = tr.rec.name;
        if(i === 0){ const b = document.createElement('i'); b.textContent = '기준'; nm.appendChild(b); }

        const vol = document.createElement('input');
        vol.type = 'range'; vol.className = 'st-vol';
        vol.min = '0'; vol.max = '1'; vol.step = '0.05';
        vol.value = String(tr.volume);
        vol.addEventListener('input', function(){
          tr.volume = parseFloat(vol.value);
          applyMix(tr);
        });
        vol.addEventListener('change', function(){ saveMix(); scheduleRemix(); });

        row.appendChild(mb); row.appendChild(nm); row.appendChild(vol);
        elTracks.appendChild(row);
      });
    }

    function drawInfo(){
      const total = tracks.reduce(function(s, t){ return s + (t.rec.size || 0); }, 0);
      let base = tracks.length + '트랙 · ' + fmtSize(total);
      if(decodeInfo) base += ' · ' + decodeInfo;
      elInfo.textContent = base;
      storageInfo().then(function(si){
        if(!tracks.length) return;
        let s = base;
        if(si.persisted != null) s += ' · 저장 지속 ' + (si.persisted ? 'ON' : 'OFF');
        elInfo.textContent = s;
      });
    }

    function drawSync(){
      if(!hasTracks() || tracks.length < 2){ elSync.textContent = ''; return; }
      if(preparing){ elSync.classList.remove('lock'); elSync.textContent = '믹스 준비 중'; return; }
      if(mode === 'wa'){
        elSync.textContent = playing ? '샘플 동기' : '';
        elSync.classList.toggle('lock', playing);
      } else if(mode === 'mix'){
        elSync.textContent = playing ? '단일 믹스' : '';
        elSync.classList.toggle('lock', playing);
      } else {
        elSync.classList.remove('lock');
        elSync.textContent = playing ? '동기 ±' + Math.round(spread() * 1000) + 'ms' : '';
      }
    }

    function drawAll(){
      const has = hasTracks();
      elEmpty.classList.toggle('st-hide', has);
      elMain.classList.toggle('st-hide', !has);
      elPick.textContent = '스템 가져오기';
      if(has){ drawTracks(); drawInfo(); }
      drawTransport(); drawSync();
      onChange();
    }

    /* ---- 트랙 붙이기 / 디코딩 ---- */
    function teardown(){
      if(driftId){ clearInterval(driftId); driftId = null; }
      if(remixId){ clearTimeout(remixId); remixId = null; }
      resyncIds.forEach(clearTimeout); resyncIds = [];
      waStop();
      if(mixEl){ try { mixEl.pause(); } catch(e){} mixEl.removeAttribute('src'); try { mixEl.load(); } catch(e){} }
      if(mixUrl){ URL.revokeObjectURL(mixUrl); mixUrl = null; }
      mixEl = null; mixSig = ''; preparing = false;
      tracks.forEach(function(tr){
        try { tr.audio.pause(); } catch(e){}
        try { if(tr.meSrc) tr.meSrc.disconnect(); } catch(e){}
        try { if(tr.gain) tr.gain.disconnect(); } catch(e){}
        tr.audio.removeAttribute('src');
        try { tr.audio.load(); } catch(e){}
        URL.revokeObjectURL(tr.url);
        tr.buffer = null;                    // 디코딩 버퍼 해제(수백MB)
      });
      tracks = [];
      playing = false; started = false; ended = false;
      pausedPos = 0; dur = 0;
      decodeState = 'idle'; decodeInfo = '';
      lastState = -1;
    }

    function decodeAll(){
      if(!waOK){ decodeState = 'fail'; mode = 'legacy'; drawAll(); return Promise.resolve(); }
      decodeState = 'decoding';
      const nativeRate = 48000;              // 재생 컨텍스트가 다르면 노드가 리샘플한다
      const plan = decodePlan(dur || 300, tracks.length, nativeRate);
      let bytes = 0;
      let chain = Promise.resolve();
      tracks.forEach(function(tr, i){
        chain = chain.then(function(){
          msg('음원 준비 중… (' + (i + 1) + '/' + tracks.length + ') — 첫 재생부터 정확히 맞추기 위해 미리 디코딩합니다');
          return decodeBlob(tr.rec.blob, plan.rate, plan.ch === 1).then(function(ab){
            tr.buffer = ab;
            bytes += ab.length * ab.numberOfChannels * 4;
            if(i === 0 && isFinite(ab.duration) && ab.duration > 0) dur = ab.duration;
          });
        });
      });
      return chain.then(function(){
        decodeState = 'done';
        decodeInfo = (plan.ch === 1 ? '모노' : '스테레오') + ' '
                   + Math.round(plan.rate / 1000) + 'kHz · 메모리 ' + fmtSize(bytes);
        if(!playing) mode = wantMode();      // 디코딩 완료 → 정속이면 Web Audio 경로로
        msg('');
        drawAll();
      }).catch(function(err){
        decodeState = 'fail'; mode = 'legacy';
        msg('음원 디코딩 실패 — <audio> 방식으로 재생합니다: ' + (err && err.message ? err.message : err));
        drawAll();
      });
    }

    function attach(recs){
      teardown();
      const mix = loadMix();
      tracks = recs.map(function(r){
        const url = URL.createObjectURL(r.blob);
        const a   = new Audio();
        a.preload = 'metadata';              // 길이만 먼저. 배속 폴백을 쓸 때 auto로 올린다
        a.playsInline = true;
        a.src = url;
        if('preservesPitch' in a) a.preservesPitch = true;
        a.webkitPreservesPitch = true;       // 구형 사파리
        a.mozPreservesPitch = true;
        a.muted = false;
        const saved = mix[r.name] || {};
        const tr = {
          rec: r, audio: a, url: url, buffer: null,
          gain: null, meSrc: null, node: null,
          muted: !!saved.m,
          volume: (typeof saved.v === 'number') ? saved.v : 1
        };
        ensureGain(tr);
        applyMix(tr);
        return tr;
      });

      const m = tracks[0].audio;
      m.addEventListener('loadedmetadata', function(){
        if(isFinite(m.duration) && m.duration > 0 && !dur){ dur = m.duration; drawTransport(); onChange(); }
      });
      tracks.forEach(function(tr){
        tr.audio.addEventListener('error', function(){
          msg('“' + tr.rec.name + '” 트랙을 읽지 못했습니다.');
        });
      });

      driftId = setInterval(correctDrift, DRIFT_MS);
      drawAll();
      onReady();

      // 길이를 알아야 디코딩 계획(모노/샘플레이트)을 세울 수 있다
      const waitDur = new Promise(function(res){
        if(dur){ res(); return; }
        let done = false;
        const fin = function(){ if(!done){ done = true; res(); } };
        m.addEventListener('loadedmetadata', fin);
        setTimeout(fin, 4000);                        // 메타데이터가 안 와도 진행
      });
      waitDur.then(function(){
        if(!dur && isFinite(m.duration) && m.duration > 0) dur = m.duration;
        return decodeAll();
      });
    }

    /* ---- 가져오기 ---- */
    function pick(){ elFile.value = ''; elFile.click(); }

    elPick.addEventListener('click', pick);
    elRepick.addEventListener('click', function(){
      if(!window.confirm('저장된 스템을 새 파일로 교체합니다. 계속할까요?')) return;
      pick();
    });

    elFile.addEventListener('change', function(){
      const files = elFile.files;
      if(!files || !files.length) return;
      if(files.length > MAX_TRACKS) msg(MAX_TRACKS + '개까지만 저장합니다. 앞의 ' + MAX_TRACKS + '개를 사용합니다.');
      else msg('가져오는 중…');
      elPick.disabled = elRepick.disabled = true;
      teardown(); drawAll();

      importFiles(songId, files, function(i, n, name){
        msg('가져오는 중… (' + (i + 1) + '/' + n + ') ' + name);
      }).then(function(r){
        return listTracks(songId).then(function(recs){
          attach(recs);
          let s = r.saved + '개 트랙을 이 기기에 저장했습니다.';
          if(r.skipped > 0) s += ' (오디오가 아닌 파일 ' + r.skipped + '개 제외)';
          msg(s, true);
        });
      }).catch(function(err){
        msg('저장 실패: ' + (err && err.message ? err.message : err));
        // 교체가 롤백됐으므로 기존 스템을 되살린다
        return listTracks(songId).then(function(recs){
          if(recs.length) attach(recs); else drawAll();
        }).catch(function(){ drawAll(); });
      }).then(function(){
        elPick.disabled = elRepick.disabled = false;
      });
    });

    /* ---- 화면 잠금 / 인터럽션 복귀 ----
       잠금 중 컨텍스트가 멈추면 소스 노드가 살아 있는지 알 방법이 없다.
       (waPos()는 컨텍스트 클럭 기반이라 소리가 끊겨도 값은 흘러간다)
       그래서 복귀 시 'wa' 경로는 현재 위치에서 무조건 재구성한다. */
    function recover(){
      if(!hasTracks() || !playing || preparing) return;
      // 방금 우리가 시작한 것이라면(예: 재생 버튼의 resume이 statechange를 깨움)
      // 다시 세울 필요가 없다. 그대로 두면 소리가 한 번 끊긴다.
      if(Date.now() - lastBuildAt < 800) return;
      if(mode === 'wa'){
        const pos = waPos();
        const c = ensureCtx();
        waStop();
        const go = function(){ if(playing) waStart(pos); };
        if(c && c.state !== 'running'){
          let r; try { r = c.resume(); } catch(e){}
          if(r && r.then) r.then(go, go); else go();
        } else go();
      } else if(mode === 'mix'){
        if(mixEl && mixEl.paused){ const p = mixEl.play(); if(p && p.catch) p.catch(function(){}); }
      } else {
        tracks.forEach(function(tr){
          if(tr.audio.paused){ const p = tr.audio.play(); if(p && p.catch) p.catch(function(){}); }
        });
      }
    }
    function onVisible(){ if(document.visibilityState === 'visible') recover(); }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);

    /* ---- 트랜스포트 이벤트 ---- */
    elPlay.addEventListener('click', function(){
      msg(''); toggle();           // play() 안에서 제스처를 유지한 채 resume 한다
    });
    elSeek.addEventListener('input', function(){ seeking = true; drawTransport(); });
    elSeek.addEventListener('change', function(){
      seeking = false;
      seekTo(parseFloat(elSeek.value));
    });

    uiId = setInterval(function(){
      if(!tracks.length) return;
      // 'legacy' 경로의 자연 종료 감지('wa'는 node.onended, 'mix'는 ended 이벤트)
      if(mode === 'legacy' && playing && tracks[0].audio.ended){
        playing = false; ended = true; pausedPos = dur;
      }
      if(playing || seeking) drawTransport();
      drawSync();
      emitState();
    }, 250);

    /* ---- 최초 로드 ---- */
    listTracks(songId).then(function(recs){
      if(recs.length) attach(recs);
      else drawAll();
    }).catch(function(err){
      msg('저장소를 열지 못했습니다: ' + (err && err.message ? err.message : err));
      drawAll();
    });

    /* ---- 유튜브 호환 플레이어 인터페이스 ---- */
    const api = {
      /* 조회 */
      getCurrentTime: currentTime,
      getDuration:    duration,
      getPlayerState: playerState,
      getPlaybackRate:function(){ return rate; },
      /* 제어 */
      seekTo:      function(t){ seekTo(t); },
      playVideo:   play,
      pauseVideo:  pause,
      setPlaybackRate: setRate,
      /* 이벤트(practice.js의 속도 방어 로직이 구독) */
      addEventListener: function(type, fn){
        if(type !== 'onStateChange' || typeof fn !== 'function') return;
        if(listeners.indexOf(fn) < 0) listeners.push(fn);
      },
      removeEventListener: function(type, fn){
        const i = listeners.indexOf(fn);
        if(i >= 0) listeners.splice(i, 1);
      },
      /* 컨트롤러 */
      hasTracks: hasTracks,
      trackCount: function(){ return tracks.length; },
      engineMode: function(){ return mode; },
      decodeStatus: function(){ return decodeState; },
      reload: function(){
        return listTracks(songId).then(function(recs){
          if(recs.length) attach(recs); else { teardown(); drawAll(); }
        });
      },
      destroy: function(){
        if(uiId) clearInterval(uiId);
        teardown();
      }
    };
    return api;
  }

  return {
    create: create,
    listTracks: listTracks,
    clearSong: clearSong,
    importFiles: importFiles,
    storageInfo: storageInfo,
    MAX_TRACKS: MAX_TRACKS
  };
})();
