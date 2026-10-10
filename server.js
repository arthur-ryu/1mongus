const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const COLOR_PALETTE = ['#C51111', '#132ED1', '#117F2D', '#ED54BA', '#EF7D0D', '#F5F557', '#3F474E', '#D6E0F0', '#6B2FBC', '#71491E', '#38FEDC', '#50EF39'];
const rooms = {};

const { TASK_DEFS, rng } = require('./public/tasks.js');
const ALL_TASKS = Object.keys(TASK_DEFS);

const SAB_CD = 30000;      // 방해공작 쿨다운 (방 전체 공유)
const DOOR_MS = 10000;     // 문 닫힘 시간
const DOOR_CD = 30000;     // 문 쿨다운 (방마다 따로)
const DOOR_CD_INIT = 10000; // 시작/회의 후 첫 문 쿨다운
const SAB_TIME = 30;       // 원자로/산소 제한시간(초)
const INTRO_MS = 2500;     // 회의 시작 연출 시간 (클라이언트 index.html 의 값과 맞춰야 함)
const EJECT_MS = 5000;     // 추방 결과(타이핑) 화면 시간
const DOOR_ROOMS = ['cafeteria', 'upperEngine', 'lowerEngine', 'security', 'medbay', 'electrical', 'storage']; // 실제 Skeld 문 방
const VIS_KEYS = ['scan', 'asteroids', 'shields', 'garbage'];
const SPAWN = { x: 3480, y: 1330, r: 80 };

const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// 닉네임 정리 + 방 안 중복 검사 (대소문자 무시)
function cleanName(playerName, id) {
  return (playerName && typeof playerName === 'string' && playerName.trim().length >= 2)
    ? playerName.trim().slice(0, 5) : `Crew_${id.substring(0, 4)}`;
}
function nameTaken(room, name) {
  const low = name.toLowerCase();
  return Object.values(room.players).some(p => p.name.toLowerCase() === low);
}

// 인원이 적을수록 미션 많이
function taskCount(n) { return n <= 3 ? 8 : n <= 5 ? 7 : n <= 7 ? 6 : n <= 9 ? 5 : 4; }
function assignTasks(n) {
  return shuffle(ALL_TASKS).slice(0, taskCount(n)).map((key, id) => {
    const seed = Math.floor(Math.random() * 1e9);
    return { id, key, seed, done: false, stage: 0, steps: TASK_DEFS[key].stages(rng(seed)).length };
  });
}
function taskProgress(room) {
  let done = 0, total = 0;
  Object.values(room.players).forEach(p => {
    if (p.role === 'CREWMATE' && p.tasks) { p.tasks.forEach(t => { total += t.steps; done += t.done ? t.steps : t.stage; }); }
  });
  return { done, total };
}

const pub = room => { const { meetingTimer, sabTimer, cams, ...rest } = room; return rest; };

function sabPublic(room) {
  const s = room.sab;
  return {
    type: s ? s.type : null,
    left: s ? s.left || 0 : 0,
    fixed: s ? (s.type === 'reactor' ? [!!s.hold[0], !!s.hold[1]] : s.fixed || []) : [],
    sw: (s && s.sw) || [],
    cd: room.sabCd,
    dcd: Object.fromEntries(Object.entries(room.doorCd).map(([k, v]) => [k, Math.max(0, v - Date.now())])),
    doors: Object.keys(room.doors)
  };
}
function sendSab(room) { io.to(room.id).emit('sabotage_updated', sabPublic(room)); }
function clearSab(room) { room.sab = null; sendSab(room); }
function endGame(room, winner, reason) {
  if (room.state === 'END') return;
  room.state = 'END';
  [room.meetingTimer, room.sabTimer].forEach(t => t && clearInterval(t));
  io.to(room.id).emit('game_over', { winner, reason, players: Object.values(room.players).map(p => ({ name: p.name, color: p.color, role: p.role, isAlive: p.isAlive })) });
}
function sabTick(room) {
  if (room.state !== 'PLAYING') return;
  let changed = false;
  if (room.sab && (room.sab.type === 'reactor' || room.sab.type === 'o2')) {
    if (--room.sab.left <= 0) {
      endGame(room, 'IMPOSTOR', room.sab.type === 'reactor' ? '원자로가 멜트다운되었습니다!' : '산소가 고갈되었습니다!');
      return;
    }
    changed = true;
  } else if (!room.sab && room.sabCd > 0 && Object.keys(room.doors).length === 0) {
    // 방해공작 쿨다운은 다른 방해공작/문이 끝나 있을 때만 줄어듦
    room.sabCd = Math.max(0, room.sabCd - 1000);
    changed = true;
  }
  if (changed) sendSab(room);
}
function sabRoom(socket, type) {
  const r = rooms[socket.roomId];
  if (!r || r.state !== 'PLAYING' || !r.sab || r.sab.type !== type) return null;
  const p = r.players[socket.id];
  return p && p.isAlive ? r : null;
}

io.on('connection', (socket) => {
  socket.emit('room_list', getRoomList());

  socket.on('create_room', ({ roomName, maxPlayers, playerName }) => {
    const parsedMax = Math.max(5, Math.min(15, parseInt(maxPlayers) || 10));
    const roomId = 'room_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    rooms[roomId] = {
      id: roomId, name: roomName || 'THE SKELD', maxPlayers: parsedMax, hostId: socket.id,
      state: 'LOBBY', votes: {}, bodies: [], players: {}, meetingTimer: null, sabTimer: null,
      sab: null, doors: {}, sabCd: 0, doorCd: {}, cams: new Set()
    };
    joinRoom(socket, roomId, playerName);
    io.emit('room_list', getRoomList());
  });

  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', '방이 존재하지 않습니다.');
    if (room.state !== 'LOBBY') return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
    if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit('error_msg', '정원 초과입니다.');
    if (nameTaken(room, cleanName(playerName, socket.id))) {
      return socket.emit('name_taken', '이 방에 같은 닉네임이 이미 있습니다. 다른 닉네임으로 바꿔주세요.');
    }
    joinRoom(socket, roomId, playerName);
    io.emit('room_list', getRoomList());
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if (!room || room.hostId !== socket.id || room.state !== 'LOBBY') return;
    const ids = Object.keys(room.players);
    if (ids.length < 1) return;

    room.state = 'PLAYING';
    room.bodies = [];
    room.sab = null;
    room.doors = {};
    room.sabCd = SAB_CD;
    room.doorCd = Object.fromEntries(DOOR_ROOMS.map(k => [k, Date.now() + DOOR_CD_INIT]));
    room.cams.clear();

    const imposterCount = ids.length >= 7 ? 2 : 1;
    const imposters = new Set(shuffle(ids).slice(0, imposterCount)); // Fisher-Yates 랜덤

    ids.forEach((id, idx) => {
      const angle = (idx / ids.length) * Math.PI * 2;
      const p = room.players[id];
      p.role = imposters.has(id) ? 'IMPOSTOR' : 'CREWMATE';
      p.isAlive = true;
      p.inVent = false;
      p.visual = null;
      p.x = SPAWN.x + Math.cos(angle) * SPAWN.r;
      p.y = SPAWN.y + Math.sin(angle) * SPAWN.r;
      p.lastKillTime = Date.now();
      p.tasks = assignTasks(ids.length);
    });

    if (room.sabTimer) clearInterval(room.sabTimer);
    room.sabTimer = setInterval(() => sabTick(room), 1000);

    io.to(room.id).emit('game_started', { players: room.players, imposterCount });
    io.to(room.id).emit('task_progress', taskProgress(room));
    sendSab(room);
    io.emit('room_list', getRoomList());
  });

  socket.on('player_move', (pos) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id] || (room.state !== 'PLAYING' && room.state !== 'LOBBY')) return;
    const p = room.players[socket.id];
    p.x = pos.x; p.y = pos.y; p.dir = pos.dir; p.isMoving = pos.isMoving;
    socket.to(socket.roomId).emit('player_moved', { id: socket.id, x: pos.x, y: pos.y, dir: pos.dir, isMoving: pos.isMoving });
  });

  socket.on('toggle_vent', ({ inVent, x, y, ventId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || p.role !== 'IMPOSTOR' || !p.isAlive) return;
    p.inVent = inVent;
    if (x && y) { p.x = x; p.y = y; }
    io.to(socket.roomId).emit('player_vented', { id: socket.id, inVent: p.inVent, x: p.x, y: p.y, ventId });
  });

  socket.on('kill_player', ({ targetId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const killer = room.players[socket.id];
    const victim = room.players[targetId];
    if (!killer || killer.role !== 'IMPOSTOR' || !killer.isAlive || killer.inVent) return;
    if (!victim || !victim.isAlive) return;
    if (Math.hypot(killer.x - victim.x, killer.y - victim.y) > 220) return;

    victim.isAlive = false;
    victim.visual = null;
    room.cams.delete(targetId); io.to(room.id).emit('cctv_count', room.cams.size);
    killer.lastKillTime = Date.now();
    const bodyObj = { id: 'body_' + Date.now(), x: victim.x, y: victim.y, color: victim.color };
    room.bodies.push(bodyObj);
    io.to(socket.roomId).emit('player_killed', { victimId: targetId, killerId: socket.id, body: bodyObj });
    checkGameOver(room);
  });

  socket.on('task_complete', ({ taskId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || p.role !== 'CREWMATE' || !p.tasks) return;
    const t = p.tasks.find(x => x.id === taskId);
    if (!t || t.done) return;
    t.done = true;
    const pr = taskProgress(room);
    io.to(room.id).emit('task_progress', pr);
    if (pr.total > 0 && pr.done >= pr.total) endGame(room, 'CREWMATE', '모든 작업을 완료했습니다!');
  });

  socket.on('task_stage', ({ taskId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || p.role !== 'CREWMATE' || !p.tasks) return;
    const t = p.tasks.find(x => x.id === taskId);
    if (!t || t.done || t.stage >= t.steps - 1) return;
    t.stage++;
    io.to(room.id).emit('task_progress', taskProgress(room));
  });

  // 미션 진행 모습 공유 (스캔/소행성/쉴드/쓰레기)
  socket.on('task_visual', ({ key }) => {
    const room = rooms[socket.roomId];
    const p = room && room.players[socket.id];
    if (!p || p.role !== 'CREWMATE' || room.state !== 'PLAYING') return;
    p.visual = VIS_KEYS.includes(key) ? key : null;
    socket.to(room.id).emit('player_visual', { id: socket.id, key: p.visual });
  });

  // ───── 사보타지 ─────
  socket.on('trigger_sabotage', ({ type, door }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || p.role !== 'IMPOSTOR') return;            // 죽은 임포스터도 가능
    const now = Date.now();
    if (type === 'doors') {              // 문 닫기: 자기 쿨다운(10초)만 확인
      if (room.sab && (room.sab.type === 'reactor' || room.sab.type === 'o2')) return; // 원자로/산소 중 문 불가
      if (!DOOR_ROOMS.includes(door) || room.doors[door] || now < (room.doorCd[door] || 0)) return;
      room.doors[door] = 1;
      room.doorCd[door] = now + DOOR_CD;   // 방마다 30초
      setTimeout(() => { delete room.doors[door]; if (rooms[room.id]) sendSab(room); }, DOOR_MS);
    } else if (room.sab || room.sabCd > 0) {   // 방해공작: 문/다른 방해공작이 끝나야만 쿨다운이 줄어듦
      return;
    } else if (type === 'reactor') {
      room.sab = { type, left: SAB_TIME, hold: {} };
    } else if (type === 'o2') {
      room.sab = { type, left: SAB_TIME, fixed: [false, false] };
    } else if (type === 'lights') {
      let sw;
      do { sw = Array.from({ length: 5 }, () => Math.random() < 0.5); } while (sw.every(Boolean));
      room.sab = { type, sw };
    } else if (type === 'comms') {
      room.sab = { type };
    } else return;
    if (type !== 'doors') room.sabCd = SAB_CD;
    sendSab(room);
  });

  socket.on('sab_hold', ({ panel, on }) => {
    const r = sabRoom(socket, 'reactor');
    if (!r || (panel !== 0 && panel !== 1)) return;
    const s = r.sab;
    if (on) s.hold[panel] = socket.id; else if (s.hold[panel] === socket.id) delete s.hold[panel];
    if (s.hold[0] && s.hold[1] && s.hold[0] !== s.hold[1]) clearSab(r); else sendSab(r);
  });

  socket.on('sab_o2', ({ panel }) => {
    const r = sabRoom(socket, 'o2');
    if (!r || (panel !== 0 && panel !== 1)) return;
    r.sab.fixed[panel] = true;
    if (r.sab.fixed.every(Boolean)) clearSab(r); else sendSab(r);
  });

  socket.on('sab_light', ({ i }) => {
    const r = sabRoom(socket, 'lights');
    if (!r || !Number.isInteger(i) || i < 0 || i > 4) return;
    r.sab.sw[i] = !r.sab.sw[i];
    if (r.sab.sw.every(Boolean)) clearSab(r); else sendSab(r);
  });

  socket.on('sab_comms', () => { const r = sabRoom(socket, 'comms'); if (r) clearSab(r); });

  socket.on('cctv', ({ on }) => {
    const r = rooms[socket.roomId];
    const p = r && r.players[socket.id];
    if (!r || r.state !== 'PLAYING' || !p || !p.isAlive) return;
    if (on) r.cams.add(socket.id); else r.cams.delete(socket.id);
    io.to(r.id).emit('cctv_count', r.cams.size);
  });

  // ───── 회의 ─────
  socket.on('call_meeting', () => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || !p.isAlive) return;
    if (room.sab && (room.sab.type === 'reactor' || room.sab.type === 'o2')) return; // 원자로/산소 중 불가
    startMeeting(room, p, 'EMERGENCY', null);
  });

  socket.on('report_body', () => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'PLAYING') return;
    const p = room.players[socket.id];
    if (!p || !p.isAlive) return;
    // 신고 가능 범위 안에서 가장 가까운 시체를 "발견된 시체"로 사용
    const near = room.bodies
      .map(b => ({ b, d: Math.hypot(b.x - p.x, b.y - p.y) }))
      .filter(o => o.d < 300)
      .sort((a, b) => a.d - b.d);
    if (!near.length) return;
    startMeeting(room, p, 'REPORT', near[0].b);
  });

  socket.on('meeting_chat', (msg) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'MEETING' || room.meetingPhase === 'INTRO') return;
    const sender = room.players[socket.id];
    if (!sender || !sender.isAlive) return; // 유령 채팅 불가
    const cleanText = String(msg).trim().slice(0, 100);
    if (!cleanText) return;
    io.to(socket.roomId).emit('new_meeting_chat', {
      senderId: socket.id, senderName: sender.name, senderColor: sender.color,
      isAlive: sender.isAlive, hasVoted: !!room.votes[socket.id], text: cleanText
    });
  });

  socket.on('cast_vote', ({ targetId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'MEETING' || room.meetingPhase !== 'VOTING') return;
    const voter = room.players[socket.id];
    if (!voter || !voter.isAlive || room.votes[socket.id]) return; // 유령 투표 불가
    room.votes[socket.id] = targetId;
    io.to(socket.roomId).emit('vote_status', { voterId: socket.id, voterName: voter.name, totalVoted: Object.keys(room.votes).length });
    const aliveCount = Object.values(room.players).filter(p => p.isAlive).length;
    if (Object.keys(room.votes).length >= aliveCount) {
      if (room.meetingTimer) clearInterval(room.meetingTimer);
      resolveMeeting(room);
    }
  });

  let leaveRoomImpl;
  socket.on('leave_room', () => { const rid = socket.roomId; if (!rid) return; socket.leave(rid); leaveRoomImpl(); socket.roomId = null; });
  socket.on('disconnect', leaveRoomImpl = () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const leaver = room.players[socket.id];
      delete room.players[socket.id];
      room.cams.delete(socket.id);
      if (room.sab && room.sab.hold) for (const k in room.sab.hold) if (room.sab.hold[k] === socket.id) delete room.sab.hold[k];

      if (Object.keys(room.players).length === 0) {
        [room.meetingTimer, room.sabTimer].forEach(t => t && clearInterval(t));
        delete rooms[roomId];
      } else {
        if (room.hostId === socket.id) room.hostId = Object.keys(room.players)[0];
        if (leaver) io.to(roomId).emit('player_left', { id: socket.id, name: leaver.name, color: leaver.color }); // 오른쪽 빨간 알림
        io.to(roomId).emit('room_update', pub(room));
        if (room.state === 'PLAYING') checkGameOver(room);
      }
      io.emit('room_list', getRoomList());
    }
  });

  function joinRoom(sock, roomId, playerName) {
    sock.roomId = roomId;
    sock.join(roomId);
    const room = rooms[roomId];
    const used = Object.values(room.players).map(p => p.color);
    const avail = COLOR_PALETTE.filter(c => !used.includes(c));
    const pool = avail.length ? avail : COLOR_PALETTE;
    const color = pool[Math.floor(Math.random() * pool.length)];
    const finalName = cleanName(playerName, sock.id);

    room.players[sock.id] = {
      id: sock.id, name: finalName, color,
      x: 1200 + (Math.random() * 80 - 40), y: 1100 + (Math.random() * 80 - 40),
      dir: 1, isMoving: false, isAlive: true, inVent: false, role: 'CREWMATE', lastKillTime: 0, visual: null
    };
    sock.emit('room_joined', { roomId, room: pub(room), myId: sock.id });
    io.to(roomId).emit('room_update', pub(room));
  }

  // 누가 눌렀는지(+발견된 시체) 연출 → 토론 시작
  function startMeeting(room, caller, type, body) {
    room.state = 'MEETING';
    room.votes = {};
    room.bodies = [];
    room.meetingPhase = 'INTRO';
    if (room.meetingTimer) clearInterval(room.meetingTimer);
    Object.values(room.players).forEach(p => { p.inVent = false; p.visual = null; });
    room.cams.clear(); io.to(room.id).emit('cctv_count', 0);
    if (room.sab && room.sab.hold) { room.sab.hold = {}; sendSab(room); }

    io.to(room.id).emit('meeting_intro', {
      callerName: caller.name, callerColor: caller.color, type,
      bodyColor: body ? body.color : null
    });

    setTimeout(() => {
      if (room.state !== 'MEETING' || room.meetingPhase !== 'INTRO') return;
      room.meetingPhase = 'DISCUSS';
      room.phaseTime = 10;
      io.to(room.id).emit('meeting_started', { players: room.players, phase: 'DISCUSS', timeLeft: 10 });

      room.meetingTimer = setInterval(() => {
        room.phaseTime--;
        if (room.meetingPhase === 'DISCUSS') {
          if (room.phaseTime <= 0) {
            room.meetingPhase = 'VOTING';
            room.phaseTime = 30;
            io.to(room.id).emit('meeting_phase_change', { phase: 'VOTING', timeLeft: 30 });
          } else io.to(room.id).emit('meeting_timer_tick', { phase: 'DISCUSS', timeLeft: room.phaseTime });
        } else if (room.meetingPhase === 'VOTING') {
          if (room.phaseTime <= 0) { clearInterval(room.meetingTimer); resolveMeeting(room); }
          else io.to(room.id).emit('meeting_timer_tick', { phase: 'VOTING', timeLeft: room.phaseTime });
        }
      }, 1000);
    }, INTRO_MS);
  }

  function resolveMeeting(room) {
    room.meetingPhase = 'REVEAL';
    if (room.meetingTimer) clearInterval(room.meetingTimer);

    const tally = {};
    Object.values(room.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    let maxVotes = 0, ejectedId = null, isTie = false;
    for (const [target, count] of Object.entries(tally)) {
      if (count > maxVotes) { maxVotes = count; ejectedId = target; isTie = false; }
      else if (count === maxVotes) isTie = true;
    }

    let ejectedPlayer = null;
    if (!isTie && ejectedId && ejectedId !== 'SKIP') {
      ejectedPlayer = room.players[ejectedId];
      if (ejectedPlayer) ejectedPlayer.isAlive = false;
    }
    const ej = ejectedPlayer ? { name: ejectedPlayer.name, role: ejectedPlayer.role } : null;
    const impLeft = Object.values(room.players).filter(p => p.isAlive && p.role === 'IMPOSTOR').length;
    const tie = isTie || !ejectedPlayer;
    const reason = isTie ? 'TIE' : (ejectedPlayer ? null : 'SKIP'); // 동점 / 건너뛰기 구분

    io.to(room.id).emit('meeting_reveal', { votes: room.votes, tally, ejectedPlayer: ej, isTie: tie, reason });

    setTimeout(() => {
      if (room.state !== 'MEETING') return;
      io.to(room.id).emit('meeting_ejection', { ejectedPlayer: ej, isTie: tie, reason, impLeft });
      setTimeout(() => {
        if (room.state !== 'MEETING') return;
        if (!checkGameOver(room)) {
          room.state = 'PLAYING';
          const n = Object.keys(room.players).length;
          Object.values(room.players).forEach((p, idx) => {
            const angle = (idx / n) * Math.PI * 2;
            p.x = SPAWN.x + Math.cos(angle) * SPAWN.r;
            p.y = SPAWN.y + Math.sin(angle) * SPAWN.r;
            p.inVent = false;
          });
          room.sabCd = SAB_CD;
          room.doorCd = Object.fromEntries(DOOR_ROOMS.map(k => [k, Date.now() + DOOR_CD_INIT]));
          io.to(room.id).emit('resume_game', { players: room.players });
          sendSab(room);
        }
      }, EJECT_MS);
    }, 5000); // 누가 누구에게 투표했는지 5초간 공개
  }

  function checkGameOver(room) {
    const alive = Object.values(room.players).filter(p => p.isAlive);
    const imps = alive.filter(p => p.role === 'IMPOSTOR').length;
    const crew = alive.filter(p => p.role === 'CREWMATE').length;
    if (imps === 0) { endGame(room, 'CREWMATE', '모든 임포스터를 추방했습니다!'); return true; }
    if (imps >= crew) { endGame(room, 'IMPOSTOR', '임포스터가 우주선을 점령했습니다!'); return true; }
    return false;
  }

  function getRoomList() {
    return Object.values(rooms).map(r => ({ id: r.id, name: r.name, current: Object.keys(r.players).length, max: r.maxPlayers, state: r.state }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`1mongus The Skeld Engine: http://localhost:${PORT}`));
