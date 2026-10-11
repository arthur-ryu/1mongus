// public/tasks.js — 서버(require)와 브라우저(<script>) 양쪽에서 쓰는 The Skeld 미션 시스템
// 좌표는 The_Skeld_map.png 원본(2576x1442) 기준입니다. 위치가 어색하면 S(...) 숫자만 고치세요.
const S = (n, x, y) => ({ n, p: [x, y] });
const pick = (r, a, n) => [...a].sort(() => r() - 0.5).slice(0, n);
const rng = s => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const TASK_DEFS = {
  wiring: { name: '전선 수리', type: 'wiring', stages: r => pick(r, [
    S('카페테리아', 1200, 300), S('관리실', 1630, 905), S('전기실', 1100, 1000),
    S('조종실', 2380, 520), S('보안실', 800, 530), S('창고', 1500, 1250)], 3) },
  swipe: { name: '카드 긁기', type: 'swipe', stages: () => [S('관리실', 1840, 770)] },
  upload: { name: '데이터 업로드', type: 'data', opts: { sec: 8, label: ['다운로드', '업로드'] }, stages: r => [
    pick(r, [S('카페테리아', 1730, 395), S('무기고', 1960, 190), S('조종실', 2380, 720), S('통신실', 1800, 1180), S('전기실', 1190, 800)], 1)[0],
    S('관리실', 1700, 760)] },
  garbage: { name: '쓰레기 비우기', type: 'hold', opts: { sec: 4 }, stages: r => pick(r, [
    S('카페테리아', 1600, 590), S('산소실', 1900, 600), S('창고', 1420, 900)], 1) },
  filter: { name: '산소 필터 청소', type: 'sequence', opts: { count: 6, ordered: false }, stages: () => [S('산소실', 1820, 520)] },
  align: { name: '엔진 출력 정렬', type: 'needle', opts: { count: 1 }, stages: r => pick(r, [
    S('위쪽 엔진', 640, 330), S('아래쪽 엔진', 640, 1000)], 1) },
  calibrate: { name: '분배기 보정', type: 'needle', opts: { count: 3 }, stages: () => [S('전기실', 1000, 900)] },
  divert: { name: '전력 우회', type: 'data', opts: { sec: 2, label: ['스위치 켜기', '스위치 켜기'] }, stages: r => [
    S('전기실', 1170, 790),
    pick(r, [S('무기고', 2000, 200), S('쉴드', 2000, 1000), S('조종실', 2420, 600), S('통신실', 1700, 1180),
      S('산소실', 1820, 520), S('보안실', 780, 650)], 1)[0]] },
  shields: { name: '쉴드 활성화', type: 'sequence', opts: { count: 7, ordered: false }, stages: () => [S('쉴드', 2000, 1050)] },
  asteroids: { name: '소행성 파괴', type: 'sequence', opts: { count: 10, ordered: false }, stages: () => [S('무기고', 1990, 280)] },
  chart: { name: '항로 설정', type: 'sequence', opts: { count: 4, ordered: true }, stages: () => [S('조종실', 2480, 560)] },
  steer: { name: '조향 안정화', type: 'needle', opts: { count: 1 }, stages: () => [S('조종실', 2500, 690)] },
  sample: { name: '샘플 검사', type: 'data', opts: { sec: 7, label: ['검사 시작'] }, stages: () => [S('의무실', 1000, 480)] },
  scan: { name: '스캔 제출', type: 'data', opts: { sec: 6, label: ['스캔 시작'] }, stages: () => [S('의무실', 1085, 640)] },
  reactor: { name: '원자로 시동', type: 'memory', stages: () => [S('원자로', 330, 650)] },
  manifold: { name: '매니폴드 잠금 해제', type: 'sequence', opts: { count: 10, ordered: true }, stages: () => [S('원자로', 280, 700)] },
  fuel: { name: '엔진 연료 주입', type: 'hold', opts: { sec: 3 }, stages: () => [
    S('창고', 1300, 1100), S('위쪽 엔진', 560, 420), S('창고', 1300, 1100), S('아래쪽 엔진', 560, 1100)] }
};

if (typeof module !== 'undefined') module.exports = { TASK_DEFS, rng };

if (typeof window !== 'undefined') window.TaskSys = (() => {
  const USE_DIST = 170;
  // 사보타지 수리 패널 위치 (REF 좌표)
  const SAB_PANELS = { reactor: [[300, 475], [300, 830]], o2: [[1890, 610], [1850, 830]], lights: [[1100, 990]], comms: [[1610, 1150]] };
  const VIS = new Set(['scan', 'asteroids', 'shields', 'garbage']); // 하는 모습이 보이는 미션
  let mine = [], prog = { done: 0, total: 0 }, hooked = false, ui = null, overlay = null;
  let curVis = false, curSab = null, holding = false, sabUI = null;
  let listOpen = true; // 미션 목록 펼침/접힘
  const el = (tag, css, html) => { const e = document.createElement(tag); e.style.cssText = css || ''; if (html) e.innerHTML = html; return e; };
  const BTN = 'padding:10px 20px;border-radius:12px;border:3px solid #0f172a;background:#0284c7;color:#fff;font-size:16px;cursor:pointer;';
  const wp = q => ({ x: q[0] * REF_SX, y: q[1] * REF_SY });

  const G = {
    wiring(b, done) {
      const C = ['#ef4444', '#3b82f6', '#eab308', '#ec4899'], R = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      let sel = null, n = 0;
      const row = el('div', 'display:flex;justify-content:space-between;width:260px;'), L = el('div', 'display:flex;flex-direction:column;gap:14px;'), Rt = el('div', 'display:flex;flex-direction:column;gap:14px;');
      const mk = c => el('div', `width:56px;height:34px;border-radius:8px;border:3px solid #000;background:${c};cursor:pointer;`);
      C.forEach((c, i) => { const d = mk(c); d.onclick = () => { sel = i; L.childNodes.forEach(x => x.style.outline = ''); d.style.outline = '4px solid #0f172a'; }; L.appendChild(d); });
      R.forEach(i => { const d = mk(C[i]); d.onclick = () => {
        if (sel === i) { d.style.opacity = L.childNodes[i].style.opacity = 0.3; d.style.pointerEvents = L.childNodes[i].style.pointerEvents = 'none'; L.childNodes[i].style.outline = ''; sel = null; if (++n === 4) done(); }
        else { sel = null; L.childNodes.forEach(x => x.style.outline = ''); } }; Rt.appendChild(d); });
      row.append(L, Rt); b.appendChild(row);
    },
    swipe(b, done) {
      const track = el('div', 'position:relative;width:300px;height:60px;background:#cbd5e1;border-radius:12px;border:3px solid #64748b;touch-action:none;');
      const card = el('div', 'position:absolute;left:4px;top:8px;width:70px;height:40px;background:#22c55e;border:3px solid #0f172a;border-radius:6px;cursor:grab;', '💳');
      const msg = el('div', 'margin-top:12px;height:20px;color:#ef4444;');
      let t0 = 0, drag = false;
      card.onpointerdown = e => { drag = true; t0 = Date.now(); card.setPointerCapture(e.pointerId); };
      card.onpointermove = e => { if (!drag) return; const r = track.getBoundingClientRect(); card.style.left = Math.max(4, Math.min(220, e.clientX - r.left - 35)) + 'px'; };
      card.onpointerup = () => { if (!drag) return; drag = false; const dt = Date.now() - t0, x = parseInt(card.style.left);
        if (x < 215) msg.innerText = '끝까지 긁으세요';
        else if (dt < 400) msg.innerText = '너무 빨라요!'; else if (dt > 1100) msg.innerText = '너무 느려요!'; else return done();
        card.style.left = '4px'; };
      track.appendChild(card); b.append(track, msg);
    },
    data(b, done, o, stage) {
      const bar = el('div', 'width:260px;height:20px;background:#e2e8f0;border:3px solid #64748b;border-radius:10px;overflow:hidden;margin-bottom:14px;');
      const fill = el('div', 'height:100%;width:0;background:#22c55e;'); bar.appendChild(fill);
      const btn = el('button', BTN, o.label[stage] || o.label[0]);
      btn.onclick = () => { btn.disabled = true; const t0 = Date.now(); const iv = setInterval(() => {
        if (!b.isConnected) return clearInterval(iv);
        const p = Math.min(1, (Date.now() - t0) / (o.sec * 1000)); fill.style.width = p * 100 + '%'; if (p >= 1) { clearInterval(iv); done(); } }, 50); };
      b.append(bar, btn);
    },
    hold(b, done, o) {
      const bar = el('div', 'width:260px;height:20px;background:#e2e8f0;border:3px solid #64748b;border-radius:10px;overflow:hidden;margin-bottom:14px;');
      const fill = el('div', 'height:100%;width:0;background:#f59e0b;'); bar.appendChild(fill);
      const btn = el('button', BTN + 'touch-action:none;', '누르고 있기'); let iv = null, t0 = 0;
      const stop = () => { clearInterval(iv); iv = null; fill.style.width = 0; };
      btn.onpointerdown = () => { t0 = Date.now(); iv = setInterval(() => {
        if (!b.isConnected) return stop();
        const p = Math.min(1, (Date.now() - t0) / (o.sec * 1000)); fill.style.width = p * 100 + '%'; if (p >= 1) { stop(); done(); } }, 50); };
      btn.onpointerup = btn.onpointerleave = stop; b.append(bar, btn);
    },
    sequence(b, done, o) {
      const area = el('div', 'position:relative;width:320px;height:256px;background:#0f172a;border-radius:12px;');
      const cells = [...Array(20).keys()].sort(() => Math.random() - 0.5).slice(0, o.count);
      let next = 1, left = o.count;
      cells.forEach((c, i) => {
        const n = i + 1, d = el('div', `position:absolute;left:${(c % 5) * 64 + 8}px;top:${((c / 5) | 0) * 64 + 8}px;width:48px;height:48px;border-radius:50%;background:#38fedc;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#0f172a;cursor:pointer;`, o.ordered ? n : '');
        d.onclick = () => {
          if (o.ordered && n !== next) { next = 1; area.childNodes.forEach(x => { x.style.visibility = 'visible'; }); left = o.count; return; }
          d.style.visibility = 'hidden'; next++; if (--left === 0) done(); };
        area.appendChild(d); });
      b.appendChild(area);
    },
    needle(b, done, o) {
      const bar = el('div', 'position:relative;width:300px;height:36px;background:#334155;border:3px solid #0f172a;border-radius:8px;overflow:hidden;');
      const zone = el('div', 'position:absolute;top:0;height:100%;width:50px;background:#22c55e;'), nd = el('div', 'position:absolute;top:0;height:100%;width:6px;background:#fff;');
      const place = () => zone.style.left = 20 + Math.random() * 220 + 'px'; place(); bar.append(zone, nd);
      const btn = el('button', BTN + 'margin-top:14px;', 'STOP'); let x = 0, dir = 1, ok = 0;
      (function loop() { if (!b.isConnected) return; x += dir * 4; if (x > 294 || x < 0) dir *= -1; nd.style.left = x + 'px'; requestAnimationFrame(loop); })();
      btn.onclick = () => { const z = parseInt(zone.style.left); if (x >= z - 3 && x <= z + 50) { if (++ok >= o.count) return done(); place(); } else ok = 0; };
      b.append(bar, btn);
    },
    memory(b, done) {
      const C = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
      const seq = Array.from({ length: 5 }, () => Math.floor(Math.random() * C.length));
      const grid = el('div', 'display:grid;grid-template-columns:repeat(2,90px);gap:12px;');
      const hint = el('div', 'min-height:22px;text-align:center;font-size:14px;color:#475569;', '색깔 순서를 기억하세요.');
      let pos = 0, accepting = false, finished = false;
      const pads = [];
      const later = (fn, ms) => setTimeout(() => {
        // 패널을 닫았거나 미션을 끝낸 뒤에는 예약된 동작을 무시합니다.
        if (!b.isConnected || finished) return;
        fn();
      }, ms);
      const flash = (i, duration = 300) => {
        const pad = pads[i];
        if (!pad) return;
        pad.style.opacity = '1';
        later(() => { pad.style.opacity = '.35'; }, duration);
      };
      const showSequence = (step = 0) => {
        if (!b.isConnected || finished) return;
        accepting = false;
        if (step === 0) pos = 0;
        if (step >= seq.length) {
          accepting = true;
          hint.innerText = '이제 같은 순서로 눌러주세요!';
          return;
        }
        later(() => {
          flash(seq[step], 350);
          later(() => showSequence(step + 1), 560);
        }, step === 0 ? 350 : 180);
      };
      C.forEach((color, i) => {
        const pad = el('div', `width:90px;height:70px;border-radius:12px;border:3px solid #000;background:${color};opacity:.35;cursor:pointer;touch-action:manipulation;`);
        pad.setAttribute('role', 'button');
        pad.setAttribute('aria-label', `색상 ${i + 1}`);
        pad.onclick = () => {
          if (!accepting || finished || !b.isConnected) return;
          flash(i, 180);
          if (i !== seq[pos]) {
            accepting = false;
            hint.innerText = '틀렸어요. 순서를 다시 보여줄게요.';
            later(() => showSequence(0), 450);
            return;
          }
          pos++;
          if (pos >= seq.length) {
            finished = true;
            accepting = false;
            hint.innerText = '완료!';
            done();
          }
        };
        pads.push(pad);
        grid.appendChild(pad);
      });
      b.append(grid, hint);
      showSequence();
    }
  };

  function setVis(k) {
    socket.emit('task_visual', { key: k });
    const me = currentRoom && currentRoom.players[myId];
    if (me) me.visual = k;
  }

  function complete(t) {
    t.stage++;
    if (t.stage >= t.spots.length) { t.done = true; if (role === 'CREWMATE') socket.emit('task_complete', { taskId: t.id }); }
    else if (role === 'CREWMATE') socket.emit('task_stage', { taskId: t.id });
    close(); render();
  }

  function shell(title) {
    close();
    overlay = el('div', 'position:fixed;inset:0;z-index:450;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;');
    const box = el('div', 'background:#fff;border:4px solid #64748b;border-radius:20px;padding:22px;display:flex;flex-direction:column;align-items:center;gap:14px;position:relative;min-width:340px;');
    const x = el('button', 'position:absolute;top:8px;right:8px;width:34px;height:34px;border-radius:50%;background:#ef4444;color:#fff;border:3px solid #0f172a;cursor:pointer;', '✕'); x.onclick = close;
    const body = el('div', 'display:flex;flex-direction:column;align-items:center;gap:12px;');
    box.append(x, el('div', 'font-size:20px;color:#0f172a;', title), body);
    overlay.appendChild(box); document.body.appendChild(overlay);
    return body;
  }

  function open(t) {
    const body = shell(t.def.name + (t.spots.length > 1 ? ` (${t.stage + 1}/${t.spots.length})` : ''));
    if (VIS.has(t.key)) { curVis = true; setVis(t.key); }
    G[t.def.type](body, () => complete(t), t.def.opts || {}, t.stage);
  }

  function openSab(p) {
    const body = shell({ reactor: '☢️ 원자로 안정화', o2: '💨 산소 공급 복구', lights: '💡 전등 복구', comms: '📡 통신 복구' }[p.kind]);
    curSab = p; holding = false; sabUI = {};
    if (p.kind === 'reactor') {
      const st = el('div', 'color:#ef4444;text-align:center;');
      const b = el('button', BTN + 'touch-action:none;padding:24px 40px;', '누르고 있기');
      const set = on => { if (holding === on) return; holding = on; socket.emit('sab_hold', { panel: p.idx, on }); };
      b.onpointerdown = () => set(true); b.onpointerup = b.onpointerleave = () => set(false);
      body.append(st, b);
      sabUI.upd = () => { const f = sabotageState.fixed || []; st.innerText = `패널 ${f[0] ? '✔' : '✖'} / ${f[1] ? '✔' : '✖'} — 두 곳을 동시에 누르세요`; };
    } else if (p.kind === 'o2') {
      const code = String((Math.random() * 1e5) | 0).padStart(5, '0'); let ent = '';
      const inp = el('div', 'font-size:28px;letter-spacing:6px;height:36px;color:#0284c7;');
      const pad = el('div', 'display:grid;grid-template-columns:repeat(3,64px);gap:8px;');
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0].forEach(k => {
        const d = el('button', BTN + 'padding:12px 0;', String(k));
        d.onclick = () => {
          if (k === 'C') ent = ''; else ent += k;
          inp.innerText = ent;
          if (ent.length >= 5) {
            if (ent === code) { socket.emit('sab_o2', { panel: p.idx }); close(); }
            else { ent = ''; inp.innerText = '❌'; }
          }
        };
        pad.appendChild(d);
      });
      body.append(el('div', 'font-size:28px;letter-spacing:6px;color:#0f172a;', '코드: ' + code), inp, pad);
    } else if (p.kind === 'comms') {
      body.append(el('div', 'font-size:13px;', '주파수를 3번 맞추세요'));
      G.needle(body, () => { socket.emit('sab_comms'); close(); }, { count: 3 });
    } else {
      const row = el('div', 'display:flex;gap:10px;');
      body.append(row, el('div', 'font-size:13px;', '모든 스위치를 켜세요'));
      sabUI.upd = () => {
        row.innerHTML = '';
        (sabotageState.sw || []).forEach((on, i) => {
          const d = el('div', `width:44px;height:90px;border-radius:8px;border:3px solid #000;background:${on ? '#22c55e' : '#475569'};cursor:pointer;display:flex;align-items:${on ? 'flex-start' : 'flex-end'};justify-content:center;font-size:20px;color:#fff;`, on ? '▲' : '▼');
          d.onclick = () => socket.emit('sab_light', { i });
          row.appendChild(d);
        });
      };
    }
    if (sabUI.upd) sabUI.upd();
  }

  function close() {
    if (holding && curSab) socket.emit('sab_hold', { panel: curSab.idx, on: false });
    holding = false; curSab = null; sabUI = null;
    if (curVis) { curVis = false; setVis(null); }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function world(t) { return wp(t.spots[t.stage].p); }
  function nearestSab() {
    const s = sabotageState;
    if (overlay || !s || !s.type || !currentRoom) return null;
    const me = currentRoom.players[myId];
    if (!me || !me.isAlive) return null;
    const L = SAB_PANELS[s.type];
    for (let i = 0; i < L.length; i++) {
      if (s.type === 'o2' && (s.fixed || [])[i]) continue;
      const w = wp(L[i]);
      if (Math.hypot(w.x - localPlayer.x, w.y - localPlayer.y) < USE_DIST) return { sab: true, kind: s.type, idx: i };
    }
    return null;
  }
  function nearest() {
    if (overlay) return null;
    const s = nearestSab();
    if (s) return s;
    if (role === 'IMPOSTOR' || !mine.length) return null; // 임포스터는 가짜 미션만 (실제 수행 불가)
    return mine.find(t => { if (t.done) return false; const w = world(t); return Math.hypot(w.x - localPlayer.x, w.y - localPlayer.y) < USE_DIST; }) || null;
  }

  // 미션 목록: 화면 크기에 맞춰 글자/너비가 자동으로 줄고 늘어나며, 제목줄을 눌러 접고 펼 수 있음
  function render() {
    if (!ui) {
      ui = el('div', 'position:absolute;top:clamp(8px,2vh,18px);left:16px;width:clamp(150px,24vw,250px);z-index:55;pointer-events:none;font-size:clamp(10px,min(1.6vw,2.8vh),14px);color:#0f172a;');
      document.getElementById('in-game-ui').appendChild(ui);
    }
    if (sabotageState.type === 'comms') {
      ui.innerHTML = '<div style="padding:.7em;background:rgba(15,23,42,.9);color:#ef4444;border:3px solid #ef4444;border-radius:12px;">📡 통신 장애<br>미션 목록을 볼 수 없습니다</div>';
      return;
    }
    const pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
    const list = mine.map(t => `<div style="${t.done ? 'color:#16a34a;text-decoration:line-through;' : ''}">${t.done ? '✔' : '☐'} ${t.def.name}${t.done ? '' : ' — ' + t.spots[t.stage].n}</div>`).join('');
    ui.innerHTML = `
      <div style="position:relative;height:1.7em;background:#e2e8f0;border:3px solid #64748b;border-radius:10px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:#22c55e;transition:width .3s;"></div>
        <div style="position:absolute;inset:0;text-align:center;line-height:1.4em;font-size:.95em;color:#0f172a;">${pct}%</div>
      </div>
      <div id="task-toggle" style="pointer-events:auto;cursor:pointer;margin-top:6px;padding:.45em .8em;background:rgba(255,255,255,.92);border:3px solid #64748b;border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:.6em;">
        <span>📋 미션 목록</span><span style="color:#0284c7;">${listOpen ? '▲ 접기' : '▼ 펼치기'}</span>
      </div>
      ${listOpen ? `<div style="margin-top:4px;padding:.6em .8em;background:rgba(255,255,255,.85);border:3px solid #64748b;border-radius:12px;line-height:1.5;">${list}</div>` : ''}`;
    const tg = ui.querySelector('#task-toggle');
    if (tg) tg.onclick = () => { listOpen = !listOpen; render(); };
  }

  return {
    init(tasks) {
      mine = (tasks || []).map(t => { const d = TASK_DEFS[t.key]; return { id: t.id, key: t.key, def: d, stage: 0, done: false, spots: d.stages(rng(t.seed)) }; });
      prog = { done: 0, total: 0 };
      if (!hooked) { hooked = true; socket.on('task_progress', p => { prog = p; render(); }); }
      close(); render();
    },
    nearest, close,
    isOpen: () => !!overlay,
    sabTargets() {
      const s = sabotageState;
      if (!s || !s.type || !SAB_PANELS[s.type]) return [];
      return SAB_PANELS[s.type].map((q, i) => ({ q, i })).filter(o => !(s.type === 'o2' && (s.fixed || [])[o.i])).map(o => wp(o.q));
    },
    onSab() {
      render();
      if (!overlay || !curSab) return;
      if (sabotageState.type !== curSab.kind) { close(); return; }
      if (sabUI && sabUI.upd) sabUI.upd();
    },
    tryUse() {
      const t = nearest();
      if (!t || !currentRoom || currentRoom.state !== 'PLAYING' || isVented) return false;
      t.sab ? openSab(t) : open(t);
      return true;
    },
    draw(c, tick) {
      const r = 26 + Math.sin(tick * 0.12) * 4;
      mine.forEach(t => { if (t.done) return; const w = world(t);
        c.save(); c.globalAlpha = 0.9; c.fillStyle = '#facc15'; c.strokeStyle = '#000'; c.lineWidth = 4;
        c.beginPath(); c.arc(w.x, w.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#000'; c.font = '30px sans-serif'; c.textAlign = 'center'; c.fillText('!', w.x, w.y + 10); c.restore(); });
      const s = sabotageState;
      if (s && s.type && SAB_PANELS[s.type]) SAB_PANELS[s.type].forEach((q, i) => {
        if (s.type === 'o2' && (s.fixed || [])[i]) return;
        const w = wp(q);
        c.save(); c.fillStyle = '#ef4444'; c.strokeStyle = '#fff'; c.lineWidth = 5;
        c.beginPath(); c.arc(w.x, w.y, r + 6, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.font = '34px sans-serif'; c.textAlign = 'center'; c.fillText('!', w.x, w.y + 12); c.restore();
      });
    }
  };
})();
