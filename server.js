const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage
const rooms = new Map();

function generateRoomId() {
  let id;
  do {
    id = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (rooms.has(id));
  return id;
}

function getRoomState(room, forPlayerId) {
  return {
    id: room.id,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      buyIn: p.buyIn,
      status: p.status,
      currentBet: p.currentBet,
      seatIndex: p.seatIndex,
      isDealer: room.round ? room.round.dealerIndex === p.seatIndex : false,
    })),
    settings: room.settings,
    round: room.round,
    status: room.status, // 'waiting' | 'playing' | 'finished'
  };
}

function getActivePlayers(room) {
  return room.players.filter(p => p.status === 'active' || p.status === 'allin');
}

function getActionablePlayers(room) {
  return room.players.filter(p => p.status === 'active');
}

function nextActivePlayerIndex(room, fromSeat) {
  const players = room.players;
  const totalSeats = players.length;
  for (let i = 1; i <= totalSeats; i++) {
    const idx = (fromSeat + i) % totalSeats;
    const p = players.find(pl => pl.seatIndex === idx);
    if (p && p.status === 'active') return idx;
  }
  return -1;
}

function calculatePots(room) {
  // Include ALL players who bet this round (including folded) for pot total
  const allBettors = room.players.filter(p => (p.roundBet || 0) > 0);
  if (allBettors.length === 0) return [];

  // Only non-folded players are eligible to WIN
  const eligiblePlayers = room.players.filter(p =>
    p.status !== 'folded' && p.status !== 'waiting' && p.status !== 'out' && p.status !== 'disconnected'
  );

  const playerBets = allBettors.map(p => ({
    id: p.id,
    totalBet: p.roundBet || 0,
    isEligible: eligiblePlayers.some(ep => ep.id === p.id),
  })).sort((a, b) => a.totalBet - b.totalBet);

  const pots = [];
  let processed = 0;

  for (let i = 0; i < playerBets.length; i++) {
    const level = playerBets[i].totalBet;
    if (level <= processed) continue;

    const contribution = level - processed;
    const contributors = playerBets.filter(p => p.totalBet > processed);
    const potAmount = contribution * contributors.length;

    // Only eligible (non-folded) players who bet at least this level can win this pot
    const potEligible = playerBets
      .filter(p => p.isEligible && p.totalBet >= level)
      .map(p => p.id);

    if (potAmount > 0) {
      pots.push({
        amount: potAmount,
        eligible: potEligible.length > 0 ? potEligible : eligiblePlayers.map(p => p.id),
      });
    }
    processed = level;
  }

  return pots;
}

function advancePhase(room) {
  const phases = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const currentIdx = phases.indexOf(room.round.phase);

  // Reset current bets for the new phase
  room.players.forEach(p => {
    p.currentBet = 0;
  });
  room.round.currentBet = 0;

  if (currentIdx < 4) {
    room.round.phase = phases[currentIdx + 1];
  }

  if (room.round.phase === 'showdown') {
    room.round.pots = calculatePots(room);
    room.round.activePlayerIndex = -1;
    io.to(room.id).emit('round-ended', {
      room: getRoomState(room),
      pots: room.round.pots,
    });
    return;
  }

  // Set first player after dealer
  const firstActive = nextActivePlayerIndex(room, room.round.dealerIndex);
  room.round.activePlayerIndex = firstActive;

  io.to(room.id).emit('phase-changed', {
    room: getRoomState(room),
  });

  if (firstActive >= 0) {
    const player = room.players.find(p => p.seatIndex === firstActive);
    io.to(room.id).emit('action-required', {
      playerId: player.id,
      seatIndex: firstActive,
      options: getPlayerOptions(room, player),
    });
  }
}

function getPlayerOptions(room, player) {
  const options = ['fold'];
  const toCall = room.round.currentBet - player.currentBet;

  if (toCall === 0) {
    options.push('check');
  } else {
    options.push('call');
  }
  options.push('raise');
  options.push('allin');

  return { options, toCall, minRaise: room.settings.bigBlind, currentBet: room.round.currentBet };
}

function checkRoundEnd(room) {
  const actionable = getActionablePlayers(room);
  const active = getActivePlayers(room);

  // Only one player left (everyone else folded)
  if (active.length === 1) {
    room.round.phase = 'showdown';
    room.round.pots = calculatePots(room);
    room.round.activePlayerIndex = -1;
    // Auto-award to last standing
    const winner = active[0];
    const totalPot = room.round.pots.reduce((sum, p) => sum + p.amount, 0);
    winner.chips += totalPot;
    room.round.winners = [{ id: winner.id, name: winner.name, amount: totalPot }];

    // Reset for next round (preserve disconnected status)
    room.players.forEach(p => {
      p.roundBet = 0;
      p.currentBet = 0;
      if (p.status === 'disconnected') return;
      if (p.chips > 0) p.status = 'waiting';
      else p.status = 'out';
    });

    io.to(room.id).emit('round-auto-won', {
      room: getRoomState(room),
      winner: { id: winner.id, name: winner.name, amount: totalPot },
    });
    return true;
  }

  // All actionable players have matched the current bet (or are all-in)
  if (actionable.length === 0) {
    advancePhase(room);
    return true;
  }

  // Check if all active players have acted and bets are equal
  const allMatched = actionable.every(p => p.currentBet === room.round.currentBet && p.hasActed);
  if (allMatched) {
    advancePhase(room);
    return true;
  }

  return false;
}

function startNewRound(room) {
  // Advance dealer
  if (room.round) {
    room.round.dealerIndex = nextActivePlayerIndex(room, room.round.dealerIndex);
  }

  const dealerIdx = room.round ? room.round.dealerIndex : 0;
  // Only online players with chips can play
  const playersInRound = room.players.filter(p => p.chips > 0 && p.status !== 'disconnected');

  if (playersInRound.length < 2) {
    io.to(room.id).emit('app-error', { message: '可参与的玩家不足，无法开始新一轮' });
    return;
  }

  playersInRound.forEach(p => {
    p.status = 'active';
    p.currentBet = 0;
    p.roundBet = 0;
    p.hasActed = false;
  });
  room.players.filter(p => p.chips <= 0 && p.status !== 'disconnected').forEach(p => {
    p.status = 'out';
  });
  // Disconnected players stay disconnected, don't participate
  room.players.filter(p => p.status === 'disconnected').forEach(p => {
    p.currentBet = 0;
    p.roundBet = 0;
    p.hasActed = false;
  });

  const sbIndex = nextActivePlayerIndex(room, dealerIdx);
  const bbIndex = nextActivePlayerIndex(room, sbIndex);

  const sbPlayer = room.players.find(p => p.seatIndex === sbIndex);
  const bbPlayer = room.players.find(p => p.seatIndex === bbIndex);

  // Post blinds
  const sbAmount = Math.min(room.settings.smallBlind, sbPlayer.chips);
  sbPlayer.chips -= sbAmount;
  sbPlayer.currentBet = sbAmount;
  sbPlayer.roundBet = sbAmount;

  const bbAmount = Math.min(room.settings.bigBlind, bbPlayer.chips);
  bbPlayer.chips -= bbAmount;
  bbPlayer.currentBet = bbAmount;
  bbPlayer.roundBet = bbAmount;

  if (sbPlayer.chips === 0) sbPlayer.status = 'allin';
  if (bbPlayer.chips === 0) bbPlayer.status = 'allin';

  const firstToAct = nextActivePlayerIndex(room, bbIndex);

  room.round = {
    phase: 'preflop',
    pot: 0,
    currentBet: bbAmount,
    dealerIndex: dealerIdx,
    sbIndex,
    bbIndex,
    activePlayerIndex: firstToAct,
    pots: [],
    winners: null,
    roundNumber: (room.round ? room.round.roundNumber || 0 : 0) + 1,
  };

  room.status = 'playing';

  io.to(room.id).emit('round-started', {
    room: getRoomState(room),
  });

  if (firstToAct >= 0) {
    const player = room.players.find(p => p.seatIndex === firstToAct);
    io.to(room.id).emit('action-required', {
      playerId: player.id,
      seatIndex: firstToAct,
      options: getPlayerOptions(room, player),
    });
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name, settings }) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name,
        chips: settings.initialChips || 1000,
        buyIn: settings.initialChips || 1000,
        status: 'waiting',
        currentBet: 0,
        roundBet: 0,
        seatIndex: 0,
        hasActed: false,
      }],
      settings: {
        initialChips: settings.initialChips || 1000,
        smallBlind: settings.smallBlind || 5,
        bigBlind: settings.bigBlind || 10,
      },
      round: null,
      status: 'waiting',
      history: [],
    };
    rooms.set(roomId, room);
    currentRoom = roomId;
    socket.join(roomId);
    socket.emit('room-created', { room: getRoomState(room) });
  });

  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('app-error', { message: '房间不存在' });
      return;
    }

    // Check if this is a reconnection (same name, disconnected)
    const disconnected = room.players.find(p => p.name === name && p.status === 'disconnected');
    if (disconnected) {
      // Reconnect: restore player identity
      const oldId = disconnected.id;
      disconnected.id = socket.id;
      disconnected.status = room.status === 'playing' ? 'active' : 'waiting';
      // If they were folded this round, keep folded
      if (room.round && disconnected._statusBeforeDisconnect) {
        disconnected.status = disconnected._statusBeforeDisconnect;
        delete disconnected._statusBeforeDisconnect;
      }
      currentRoom = roomId;
      socket.join(roomId);

      // Transfer host back if they were host
      if (disconnected._wasHost) {
        room.hostId = socket.id;
        delete disconnected._wasHost;
      }

      const roomState = getRoomState(room);
      socket.emit('join-success', { room: roomState, reconnected: true });
      socket.to(roomId).emit('room-updated', { room: roomState });

      // If it's their turn, send action-required
      if (room.round && room.round.activePlayerIndex === disconnected.seatIndex && disconnected.status === 'active') {
        socket.emit('action-required', {
          playerId: socket.id,
          seatIndex: disconnected.seatIndex,
          options: getPlayerOptions(room, disconnected),
          room: roomState,
        });
      }
      return;
    }

    // Normal join
    if (room.players.filter(p => p.status !== 'disconnected').length >= 10) {
      socket.emit('app-error', { message: '房间已满（最多10人）' });
      return;
    }
    if (room.status === 'playing') {
      socket.emit('app-error', { message: '牌局进行中，无法加入' });
      return;
    }
    if (room.players.find(p => p.name === name)) {
      socket.emit('app-error', { message: '昵称已被使用' });
      return;
    }

    const seatIndex = room.players.length;
    room.players.push({
      id: socket.id,
      name,
      chips: room.settings.initialChips,
      buyIn: room.settings.initialChips,
      status: 'waiting',
      currentBet: 0,
      roundBet: 0,
      seatIndex,
      hasActed: false,
    });

    currentRoom = roomId;
    socket.join(roomId);
    const roomState = getRoomState(room);
    socket.emit('join-success', { room: roomState });
    socket.to(roomId).emit('room-updated', { room: roomState });
  });

  socket.on('start-round', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('app-error', { message: '只有房主可以开始牌局' });
      return;
    }
    const eligible = room.players.filter(p => p.chips > 0);
    if (eligible.length < 2) {
      socket.emit('app-error', { message: '至少需要2名有筹码的玩家' });
      return;
    }
    startNewRound(room);
  });

  socket.on('player-action', ({ action, amount }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.round) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (player.seatIndex !== room.round.activePlayerIndex) {
      socket.emit('app-error', { message: '还没轮到你操作' });
      return;
    }

    if (player.status !== 'active') {
      socket.emit('app-error', { message: '你已经弃牌或全下' });
      return;
    }

    switch (action) {
      case 'fold':
        player.status = 'folded';
        break;

      case 'check':
        if (player.currentBet < room.round.currentBet) {
          socket.emit('app-error', { message: '无法过牌，需要跟注' });
          return;
        }
        break;

      case 'call': {
        const toCall = room.round.currentBet - player.currentBet;
        const actualCall = Math.min(toCall, player.chips);
        player.chips -= actualCall;
        player.currentBet += actualCall;
        player.roundBet += actualCall;
        if (player.chips === 0) player.status = 'allin';
        break;
      }

      case 'raise': {
        const raiseAmount = parseInt(amount);
        if (isNaN(raiseAmount) || raiseAmount <= 0) {
          socket.emit('app-error', { message: '请输入有效的加注金额' });
          return;
        }
        const totalBet = room.round.currentBet + raiseAmount;
        const needed = totalBet - player.currentBet;
        if (needed > player.chips) {
          socket.emit('app-error', { message: '筹码不足' });
          return;
        }
        player.chips -= needed;
        player.currentBet = totalBet;
        player.roundBet += needed;
        room.round.currentBet = totalBet;
        // Reset hasActed for other active players since bet increased
        room.players.forEach(p => {
          if (p.id !== player.id && p.status === 'active') {
            p.hasActed = false;
          }
        });
        if (player.chips === 0) player.status = 'allin';
        break;
      }

      case 'allin': {
        const allInAmount = player.chips;
        player.currentBet += allInAmount;
        player.roundBet += allInAmount;
        player.chips = 0;
        player.status = 'allin';
        if (player.currentBet > room.round.currentBet) {
          room.round.currentBet = player.currentBet;
          room.players.forEach(p => {
            if (p.id !== player.id && p.status === 'active') {
              p.hasActed = false;
            }
          });
        }
        break;
      }

      default:
        socket.emit('app-error', { message: '无效操作' });
        return;
    }

    player.hasActed = true;

    // Broadcast action
    io.to(room.id).emit('player-acted', {
      playerId: player.id,
      playerName: player.name,
      action,
      amount: amount || 0,
      room: getRoomState(room),
    });

    // Check if round/phase should advance
    if (!checkRoundEnd(room)) {
      // Move to next player
      const nextSeat = nextActivePlayerIndex(room, player.seatIndex);
      if (nextSeat >= 0) {
        room.round.activePlayerIndex = nextSeat;
        const nextPlayer = room.players.find(p => p.seatIndex === nextSeat);
        io.to(room.id).emit('action-required', {
          playerId: nextPlayer.id,
          seatIndex: nextSeat,
          options: getPlayerOptions(room, nextPlayer),
          room: getRoomState(room),
        });
      }
    }
  });

  socket.on('select-winner', ({ winnerIds }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.round) return;
    if (socket.id !== room.hostId) {
      socket.emit('app-error', { message: '只有房主可以选择赢家' });
      return;
    }
    if (room.round.phase !== 'showdown') {
      socket.emit('app-error', { message: '还未到结算阶段' });
      return;
    }

    const pots = room.round.pots;
    const winners = [];

    // Distribute pots
    for (const pot of pots) {
      const potWinners = winnerIds.filter(id => pot.eligible.includes(id));
      if (potWinners.length === 0) continue;
      const share = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount - share * potWinners.length;
      potWinners.forEach((id, idx) => {
        const player = room.players.find(p => p.id === id);
        if (player) {
          const award = share + (idx === 0 ? remainder : 0);
          player.chips += award;
          const existing = winners.find(w => w.id === id);
          if (existing) existing.amount += award;
          else winners.push({ id, name: player.name, amount: award });
        }
      });
    }

    room.round.winners = winners;

    // Save to history
    room.history.push({
      roundNumber: room.round.roundNumber,
      winners: winners.map(w => ({ ...w })),
      pots: pots.map(p => ({ ...p })),
    });

    // Reset players (preserve disconnected status)
    room.players.forEach(p => {
      p.currentBet = 0;
      p.roundBet = 0;
      p.hasActed = false;
      if (p.status === 'disconnected') return; // keep disconnected
      if (p.chips > 0) p.status = 'waiting';
      else p.status = 'out';
    });

    room.status = 'waiting';

    io.to(room.id).emit('round-settled', {
      room: getRoomState(room),
      winners,
    });
  });

  socket.on('buy-in', ({ amount }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const buyAmount = parseInt(amount) || room.settings.initialChips;
    player.chips += buyAmount;
    player.buyIn += buyAmount;
    if (player.status === 'out') player.status = 'waiting';

    io.to(room.id).emit('room-updated', { room: getRoomState(room) });
  });

  socket.on('end-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('app-error', { message: '只有房主可以结束游戏' });
      return;
    }

    // Calculate settlements
    const settlements = [];
    const balances = room.players.map(p => ({
      id: p.id,
      name: p.name,
      buyIn: p.buyIn,
      chips: p.chips,
      profit: p.chips - p.buyIn,
    }));

    // Calculate optimal transfers (minimize number of transactions)
    const debtors = balances.filter(b => b.profit < 0).map(b => ({ ...b, owe: -b.profit }));
    const creditors = balances.filter(b => b.profit > 0).map(b => ({ ...b, receive: b.profit }));

    debtors.sort((a, b) => b.owe - a.owe);
    creditors.sort((a, b) => b.receive - a.receive);

    let di = 0, ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const amount = Math.min(debtors[di].owe, creditors[ci].receive);
      if (amount > 0) {
        settlements.push({
          from: debtors[di].name,
          to: creditors[ci].name,
          amount,
        });
      }
      debtors[di].owe -= amount;
      creditors[ci].receive -= amount;
      if (debtors[di].owe === 0) di++;
      if (creditors[ci].receive === 0) ci++;
    }

    room.status = 'finished';

    io.to(room.id).emit('game-ended', {
      balances,
      settlements,
      history: room.history,
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Save current status for reconnection
    if (player.status !== 'disconnected') {
      player._statusBeforeDisconnect = player.status;
    }

    // Transfer host if needed
    if (socket.id === room.hostId) {
      player._wasHost = true;
      const onlinePlayers = room.players.filter(p => p.id !== socket.id && p.status !== 'disconnected');
      if (onlinePlayers.length > 0) {
        room.hostId = onlinePlayers[0].id;
      }
    }

    player.status = 'disconnected';

    // If ALL players are disconnected, clean up the room
    if (room.players.every(p => p.status === 'disconnected')) {
      rooms.delete(currentRoom);
      return;
    }

    io.to(room.id).emit('room-updated', { room: getRoomState(room) });

    // If it was the active player's turn during a round, auto-fold and advance
    if (room.round && room.round.activePlayerIndex === player.seatIndex) {
      player.status = 'folded';
      player._statusBeforeDisconnect = 'folded';
      if (!checkRoundEnd(room)) {
        const nextSeat = nextActivePlayerIndex(room, player.seatIndex);
        if (nextSeat >= 0) {
          room.round.activePlayerIndex = nextSeat;
          const nextPlayer = room.players.find(p => p.seatIndex === nextSeat);
          io.to(room.id).emit('action-required', {
            playerId: nextPlayer.id,
            seatIndex: nextSeat,
            options: getPlayerOptions(room, nextPlayer),
            room: getRoomState(room),
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  console.log(`\n🃏 德州扑克计分器已启动！`);
  console.log(`   本机访问: http://localhost:${PORT}`);
  console.log(`   手机访问: http://${localIP}:${PORT}\n`);
});
