/* stem-engine.js — 로컬 음원(스템) 연습 엔진
   곡별로 오디오 파일 1~4개를 기기(IndexedDB)에 저장해 두고, 트랙별 <audio>를
   동기 재생한다. 서버에 음원을 올리지 않으므로 사이트를 공개해도 안전하다.

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

   ── 동기화 ──────────────────────────────────────────────────────
   0번 트랙이 기준. 2초 주기로 나머지 트랙의 currentTime을 검사한다.
     · 0.05초 이상 어긋남 → 미세 배속(±10% 이내)으로 부드럽게 수렴
     · 0.5초 이상 어긋남  → seek로 회수(연속 seek 금지 간격 2.5초)
   재생 중 seek는 그 트랙만 잠깐 멈춰 되레 뒤처지므로(≈0.2초) 작은 차이는
   배속으로 메운다. 이동(seeking) 중인 트랙에 currentTime을 다시 쓰면 seek가
   재시작돼 그 트랙만 정지하므로 반드시 건너뛴다. 여러 트랙을 함께 맞출 때는
   기준 트랙까지 포함해 대칭으로 seek해야 한쪽만 앞서지 않는다.
   ──────────────────────────────────────────────────────────────── */
window.StemEngine = (function(){
  'use strict';

  const DB_NAME = 'guitar-stems';
  const DB_VER  = 1;
  const STORE   = 'tracks';
  const MAX_TRACKS = 4;
  const DRIFT_TOL  = 0.05;    // 초 — 이 이상 어긋나면 보정 시작
  const HARD_TOL   = 0.5;     // 초 — 이 이상 벌어지면 배속으로 못 메우므로 seek
  const TRIM_MAX   = 0.10;    // 보정용 배속 가감 한도(±10%)
  const DRIFT_MS   = 2000;    // 드리프트 검사 주기
  const SEEK_COOL  = 2500;    // 같은 트랙을 연속 seek하지 않는 최소 간격

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
  // File → ArrayBuffer (Safari 14 미만 대비 FileReader 폴백)
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
        return chain.then(function(){
          // 2) 기존 삭제 + 새 저장을 한 트랜잭션으로 (실패 시 기존 스템 유지)
          return replaceTracks(songId, recs).then(function(){
            return { saved: recs.length, skipped: all.length - list.length };
          });
        });
      });
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

    let tracks   = [];        // { rec, audio, url, muted, volume }
    let rate     = 1;
    let started  = false;     // 한 번이라도 재생했는가(getPlayerState -1 판별)
    let seeking  = false;     // 사용자가 seek 슬라이더를 잡고 있는가
    let listeners= [];
    let driftId  = null, uiId = null;
    let resyncIds= [];        // seek·배속 변경 직후 조기 재정렬 타이머
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

    /* ---- 믹스(음소거/볼륨) 저장 ---- */
    function loadMix(){
      try { return JSON.parse(localStorage.getItem(mixKey) || '{}') || {}; } catch(e){ return {}; }
    }
    function saveMix(){
      const m = {};
      tracks.forEach(function(t){ m[t.rec.name] = { m:t.muted, v:t.volume }; });
      try { localStorage.setItem(mixKey, JSON.stringify(m)); } catch(e){}
    }
    // muted 속성을 켜면 브라우저가 그 트랙의 재생을 정지시켜(자원 절약) 동기가 깨진다.
    // 음소거는 반드시 볼륨 0으로 구현한다 — 트랙은 계속 돌아가고 소리만 빠진다.
    function applyMix(t){
      t.audio.muted  = false;
      t.audio.volume = t.muted ? 0 : t.volume;
    }

    /* ---- 상태 ---- */
    function master(){ return tracks.length ? tracks[0].audio : null; }
    function hasTracks(){ return tracks.length > 0; }
    function duration(){
      const m = master();
      return (m && isFinite(m.duration)) ? m.duration : 0;
    }
    // 유튜브 규약: -1 미시작 / 0 종료 / 1 재생 / 2 일시정지
    function playerState(){
      const m = master();
      if(!m) return -1;
      if(!started) return -1;
      if(m.ended) return 0;
      return m.paused ? 2 : 1;
    }
    function emitState(){
      const s = playerState();
      if(s === lastState) return;
      lastState = s;
      listeners.slice().forEach(function(fn){ try { fn({ data:s, target:api }); } catch(e){} });
    }

    /* ---- 재생 제어 ---- */
    function setTime(a, t){ try { a.currentTime = t; } catch(e){} }
    // 트랙 간 최대 시각 차(동기 상태 표시·정렬 판단용)
    function spread(){
      if(tracks.length < 2) return 0;
      let mn = Infinity, mx = -Infinity;
      tracks.forEach(function(tr){
        const c = tr.audio.currentTime;
        if(c < mn) mn = c;
        if(c > mx) mx = c;
      });
      return mx - mn;
    }

    function play(){
      const m = master();
      if(!m) return;
      started = true;
      // 일시정지 중에는 트랙 간 간격이 그대로 유지된다. 어긋남이 작으면 건드리지 않는다.
      // (기준만 빼고 seek하면 seek 지연만큼 기준이 앞서 나가 되레 어긋난다)
      if(spread() > DRIFT_TOL){
        let mx = 0;
        tracks.forEach(function(tr){ if(tr.audio.currentTime > mx) mx = tr.audio.currentTime; });
        const t = mx + 0.02;                 // 기준 트랙까지 함께 앞으로 → 대칭 seek
        tracks.forEach(function(tr){ setTime(tr.audio, t); });
      }
      // 제스처 안에서 전 트랙을 동시에 시작
      tracks.forEach(function(tr){
        tr.audio.playbackRate = rate;
        const p = tr.audio.play();
        if(p && p.catch) p.catch(function(err){ msg('재생 실패: ' + (err && err.message ? err.message : err)); });
      });
      scheduleResync();
      drawTransport(); emitState();
    }
    function pause(){
      tracks.forEach(function(tr){ try { tr.audio.pause(); } catch(e){} });
      drawTransport(); emitState();
    }
    function toggle(){ if(playerState() === 1) pause(); else play(); }

    function seekTo(t){
      const d = duration();
      if(!tracks.length) return;
      t = Math.max(0, d ? Math.min(d - 0.05, t) : t);
      tracks.forEach(function(tr){
        setTime(tr.audio, t);
        tr.audio.playbackRate = rate;         // 보정용 배속 가감 초기화
      });
      // 끝까지 재생돼 멈춘 뒤 되감으면 다시 굴려준다
      if(started && playerState() === 0){
        tracks.forEach(function(tr){ const p = tr.audio.play(); if(p && p.catch) p.catch(function(){}); });
      }
      scheduleResync();
      drawTransport(); emitState();
    }

    function setRate(r){
      rate = Math.max(0.25, Math.min(2, r || 1));
      tracks.forEach(function(tr){ tr.audio.playbackRate = rate; });
      scheduleResync();
    }

    // seek·배속 변경은 트랙마다 반영 시점이 조금씩 달라 0.1초 안팎이 어긋난다.
    // 2초 주기를 기다리지 않고 곧바로 몇 번 더 보정해 빨리 수렴시킨다.
    function scheduleResync(){
      resyncIds.forEach(clearTimeout);
      resyncIds = [400, 1000, 1600].map(function(ms){ return setTimeout(correctDrift, ms); });
    }

    /* ---- 드리프트 보정 (2초 주기, 기준 = 0번 트랙) ---- */
    function correctDrift(){
      if(playerState() !== 1 || tracks.length < 2) return;
      const m = master();
      if(m.seeking) return;                    // 기준이 이동 중이면 판단을 미룬다
      const ref = m.currentTime;
      const now = Date.now();
      for(let i = 1; i < tracks.length; i++){
        const tr = tracks[i], a = tr.audio;
        // 이동이 끝나기 전에 currentTime을 다시 쓰면 seek가 재시작되어 그 트랙만
        // 계속 멈춰 있게 된다. 이동 중인 트랙은 반드시 건너뛴다.
        if(a.seeking) continue;
        if(a.paused){                          // 어떤 이유로든 멈춘 트랙은 되살린다
          if(now - (tr.seekAt || 0) < SEEK_COOL) continue;
          tr.seekAt = now;
          setTime(a, ref);
          a.playbackRate = rate;
          const p = a.play(); if(p && p.catch) p.catch(function(){});
          continue;
        }
        const d  = a.currentTime - ref;        // + 앞섬 / − 뒤처짐
        const ad = Math.abs(d);
        if(ad > HARD_TOL){                     // 크게 벌어졌을 때만 seek로 회수
          if(now - (tr.seekAt || 0) < SEEK_COOL) continue;
          tr.seekAt = now;
          setTime(a, ref);
          a.playbackRate = rate;
        } else if(ad > DRIFT_TOL){             // 미세 차이: 배속으로 부드럽게 수렴
          const trim = Math.max(-TRIM_MAX, Math.min(TRIM_MAX, -d / (DRIFT_MS / 1000)));
          a.playbackRate = rate * (1 + trim);
        } else if(Math.abs(a.playbackRate - rate) > 1e-4){
          a.playbackRate = rate;               // 정렬 완료 → 설정 배속 복귀
        }
      }
    }

    /* ---- 그리기 ---- */
    function drawTransport(){
      const d = duration(), m = master();
      const t = m ? m.currentTime : 0;
      elPlay.textContent = (playerState() === 1) ? '❚❚' : '▶';
      elPlay.disabled = !m;
      elSeek.disabled = !m || !d;
      if(d){ elSeek.max = String(d); if(!seeking) elSeek.value = String(Math.min(t, d)); }
      elTime.textContent = fmtTime(seeking ? parseFloat(elSeek.value) : t) + ' / ' + fmtTime(d);
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
          applyMix(tr); saveMix(); drawTracks();
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
        vol.addEventListener('change', saveMix);

        row.appendChild(mb); row.appendChild(nm); row.appendChild(vol);
        elTracks.appendChild(row);
      });
    }

    function drawInfo(){
      const total = tracks.reduce(function(s, t){ return s + (t.rec.size || 0); }, 0);
      const base  = tracks.length + '트랙 · ' + fmtSize(total);
      elInfo.textContent = base;
      storageInfo().then(function(si){
        if(!tracks.length) return;
        let s = base;
        if(si.persisted != null) s += ' · 저장 지속 ' + (si.persisted ? 'ON' : 'OFF');
        elInfo.textContent = s;
      });
    }

    function drawAll(){
      const has = hasTracks();
      elEmpty.classList.toggle('st-hide', has);
      elMain.classList.toggle('st-hide', !has);
      elPick.textContent = '스템 가져오기';
      if(has){ drawTracks(); drawInfo(); }
      drawTransport();
      onChange();
    }

    /* ---- 트랙 붙이기 ---- */
    function teardown(){
      if(driftId){ clearInterval(driftId); driftId = null; }
      resyncIds.forEach(clearTimeout); resyncIds = [];
      tracks.forEach(function(tr){
        try { tr.audio.pause(); } catch(e){}
        tr.audio.removeAttribute('src');
        try { tr.audio.load(); } catch(e){}
        URL.revokeObjectURL(tr.url);
      });
      tracks = [];
      started = false; lastState = -1;
    }

    function attach(recs){
      teardown();
      const mix = loadMix();
      tracks = recs.map(function(r){
        const url = URL.createObjectURL(r.blob);
        const a   = new Audio();
        a.preload = 'auto';
        a.playsInline = true;
        a.src = url;
        if('preservesPitch' in a) a.preservesPitch = true;
        a.webkitPreservesPitch = true;      // 구형 사파리
        a.mozPreservesPitch = true;
        a.muted = false;
        const saved = mix[r.name] || {};
        const tr = {
          rec: r, audio: a, url: url,
          muted: !!saved.m,
          volume: (typeof saved.v === 'number') ? saved.v : 1
        };
        applyMix(tr);
        return tr;
      });

      const m = master();
      if(m){
        m.addEventListener('play',  function(){ started = true; drawTransport(); emitState(); });
        m.addEventListener('pause', function(){ drawTransport(); emitState(); });
        m.addEventListener('ended', function(){ pause(); emitState(); });
        m.addEventListener('loadedmetadata', function(){ drawTransport(); onChange(); });
        m.addEventListener('error', function(){
          msg('첫 트랙을 재생할 수 없습니다(코덱 미지원일 수 있음).');
        });
      }
      tracks.forEach(function(tr){
        tr.audio.addEventListener('error', function(){
          msg('“' + tr.rec.name + '” 트랙을 읽지 못했습니다.');
        });
      });

      driftId = setInterval(correctDrift, DRIFT_MS);
      drawAll();
      onReady();
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

    /* ---- 트랜스포트 이벤트 ---- */
    elPlay.addEventListener('click', function(){ msg(''); toggle(); });
    elSeek.addEventListener('input', function(){ seeking = true; drawTransport(); });
    elSeek.addEventListener('change', function(){
      seeking = false;
      seekTo(parseFloat(elSeek.value));
    });

    uiId = setInterval(function(){
      if(!tracks.length) return;
      if(playerState() === 1 || seeking) drawTransport();
      // 트랙 간 어긋남을 그대로 보여준다(동기 확인용)
      if(tracks.length > 1 && playerState() === 1){
        elSync.textContent = '동기 ±' + Math.round(spread() * 1000) + 'ms';
      }
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
      getCurrentTime: function(){ const m = master(); return m ? m.currentTime : 0; },
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
