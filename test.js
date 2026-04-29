const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3001';
const INITIAL_CHIPS = 1000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const NUM_PLAYERS = 4;

let totalErrors = 0;
let totalChecks = 0;

function assert(condition, msg) {
  totalChecks++;
  if (!condition) {
    totalErrors++;
    console.error(`  ❌ FAIL: ${msg}`);
  } else {
    console.log(`  ✅ PASS: ${msg}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

// Player wrapper with event buffering
function createPlayer(name) {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, { forceNew: true });
    const player = {
      socket, name, id: null,
      lastRoom: null, autoWon: null, actionRequired: null,
      settled: null, gameEnded: null,
    };

    socket.on('connect', () => {
      player.id = socket.id;

      // Set up ALL persistent listeners immediately
      socket.on('room-updated', (data) => { player.lastRoom = data.room; });
      socket.on('player-acted', (data) => { player.lastRoom = data.room; });
      socket.on('phase-changed', (data) => { player.lastRoom = data.room; });
      socket.on('round-started', (data) => { player.lastRoom = data.room; });
      socket.on('round-auto-won', (data) => {
        player.lastRoom = data.room;
        player.autoWon = data.winner;
      });
      socket.on('round-ended', (data) => {
        player.lastRoom = data.room;
        player.roundEnded = data;
      });
      socket.on('round-settled', (data) => {
        player.lastRoom = data.room;
        player.settled = data;
      });
      socket.on('action-required', (data) => {
        player.actionRequired = data;
      });
      socket.on('game-ended', (data) => {
        player.gameEnded = data;
      });
      socket.on('app-error', (data) => {
        console.error(`  ⚠️ ${name} 收到错误: ${data.message}`);
      });

      resolve(player);
    });
  });
}

function getTotalChips(room) {
  return room.players.reduce((sum, p) => sum + p.chips + (p.currentBet || 0), 0);
}

function resetPlayerState(players) {
  players.forEach(p => {
    p.autoWon = null;
    p.actionRequired = null;
    p.roundEnded = null;
    p.settled = null;
  });
}

// Wait until a player has actionRequired set
async function waitForAction(players, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = players.find(p => p.actionRequired && p.actionRequired.playerId === p.socket.id);
    if (p) return p;
    await sleep(50);
  }
  return null;
}

// Wait until any player gets autoWon
async function waitForAutoWon(players, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = players.find(p => p.autoWon);
    if (p) return p;
    await sleep(50);
  }
  return null;
}

// Wait until roundEnded (showdown)
async function waitForRoundEnd(players, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = players.find(p => p.roundEnded);
    if (p) return p;
    await sleep(50);
  }
  return null;
}

async function waitForSettled(players, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = players.find(p => p.settled);
    if (p) return p;
    await sleep(50);
  }
  return null;
}

async function runTests() {
  console.log('\n🃏 德州扑克计分器 - 自动化测试\n');
  console.log('='.repeat(50));

  const expectedTotal = INITIAL_CHIPS * NUM_PLAYERS;

  // ===== Setup: Create room and join =====
  console.log('\n📋 测试1: 创建房间 & 玩家加入');

  const players = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    players.push(await createPlayer(`玩家${i + 1}`));
  }

  const host = players[0];
  host.socket.emit('create-room', {
    name: host.name,
    settings: { initialChips: INITIAL_CHIPS, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND },
  });
  const createResult = await waitFor(host.socket, 'room-created');
  const roomId = createResult.room.id;

  console.log(`  房间号: ${roomId}`);
  assert(roomId.length === 4 && /^\d{4}$/.test(roomId), `房间号是4位数字: ${roomId}`);
  assert(createResult.room.players.length === 1, '创建后有1个玩家');

  for (let i = 1; i < NUM_PLAYERS; i++) {
    players[i].socket.emit('join-room', { roomId, name: players[i].name });
    await waitFor(players[i].socket, 'join-success');
    await sleep(100);
  }
  console.log(`  ${NUM_PLAYERS} 个玩家已加入房间`);

  // ===== Test 2: Everyone folds → BB wins =====
  console.log('\n📋 测试2: 筹码守恒 - 所有人弃牌，大盲赢盲注');
  resetPlayerState(players);

  const rs1Promises = players.map(p => waitFor(p.socket, 'round-started'));
  host.socket.emit('start-round');
  const rs1 = await Promise.all(rs1Promises);
  // wait a tick for action-required to arrive
  await sleep(200);

  const room1 = rs1[0].room;
  const t1Before = getTotalChips(room1);
  assert(t1Before === expectedTotal, `开局总筹码 = ${expectedTotal} (实际: ${t1Before})`);

  // Fold everyone until auto-won
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const active = await waitForAction(players);
    if (!active) break;
    active.actionRequired = null;
    active.socket.emit('player-action', { action: 'fold' });
    await sleep(200);

    const winner = players.find(p => p.autoWon);
    if (winner) break;
  }

  const winner1 = await waitForAutoWon(players);
  if (winner1) {
    const t1After = getTotalChips(winner1.lastRoom);
    assert(t1After === expectedTotal, `弃牌后总筹码守恒 = ${expectedTotal} (实际: ${t1After})`);
    console.log(`  赢家: ${winner1.autoWon.name}, 赢得: ${winner1.autoWon.amount}`);
    assert(winner1.autoWon.amount === SMALL_BLIND + BIG_BLIND,
      `赢家赢得盲注总和 ${SMALL_BLIND + BIG_BLIND} (实际: ${winner1.autoWon.amount})`);
  } else {
    assert(false, '应该有自动赢家');
  }

  // ===== Test 3: All call → showdown → select winner =====
  console.log('\n📋 测试3: 筹码守恒 - 全员跟注到摊牌');
  resetPlayerState(players);

  host.socket.emit('start-round');
  await Promise.all(players.map(p => waitFor(p.socket, 'round-started')));
  await sleep(200);

  // Play through all phases: call/check
  for (let phase = 0; phase < 4; phase++) {
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const active = await waitForAction(players, 2000);
      if (!active) break;
      const opts = active.actionRequired.options;
      active.actionRequired = null;

      if (opts.options.includes('check')) {
        active.socket.emit('player-action', { action: 'check' });
      } else if (opts.options.includes('call')) {
        active.socket.emit('player-action', { action: 'call' });
      }
      await sleep(100);
    }
    await sleep(200);
  }

  const ended = await waitForRoundEnd(players);
  if (ended) {
    const showdownRoom = ended.roundEnded.room;
    const pots = showdownRoom.round.pots;
    const potTotal = pots.reduce((s, p) => s + p.amount, 0);
    const chipsOnTable = showdownRoom.players.reduce((s, p) => s + p.chips, 0);
    console.log(`  摊牌底池: ${potTotal}, 玩家持有: ${chipsOnTable}`);
    assert(potTotal + chipsOnTable === expectedTotal,
      `底池+玩家筹码 = ${expectedTotal} (实际: ${potTotal + chipsOnTable})`);

    // Select first eligible as winner
    const winnerId = pots[0].eligible[0];
    host.socket.emit('select-winner', { winnerIds: [winnerId] });

    const settledP = await waitForSettled(players);
    if (settledP) {
      const t3After = getTotalChips(settledP.settled.room);
      assert(t3After === expectedTotal, `结算后总筹码守恒 = ${expectedTotal} (实际: ${t3After})`);
      console.log(`  赢家: ${settledP.settled.winners.map(w => `${w.name}(+${w.amount})`).join(', ')}`);
    } else {
      assert(false, '应该收到结算事件');
    }
  } else {
    assert(false, '应该到达摊牌');
  }

  // ===== Test 4: Raise round =====
  console.log('\n📋 测试4: 加注50 + 全员跟注');
  resetPlayerState(players);

  host.socket.emit('start-round');
  await Promise.all(players.map(p => waitFor(p.socket, 'round-started')));
  await sleep(200);

  // First player raises 50
  let raiser = await waitForAction(players);
  if (raiser) {
    raiser.actionRequired = null;
    raiser.socket.emit('player-action', { action: 'raise', amount: 50 });
    await sleep(200);
  }

  // Rest call
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const active = await waitForAction(players, 2000);
    if (!active) break;
    active.actionRequired = null;
    active.socket.emit('player-action', { action: 'call' });
    await sleep(100);
  }

  // Check through remaining phases
  for (let phase = 0; phase < 3; phase++) {
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const active = await waitForAction(players, 2000);
      if (!active) break;
      const opts = active.actionRequired.options;
      active.actionRequired = null;
      if (opts.options.includes('check')) {
        active.socket.emit('player-action', { action: 'check' });
      } else if (opts.options.includes('call')) {
        active.socket.emit('player-action', { action: 'call' });
      }
      await sleep(100);
    }
    await sleep(200);
  }

  const ended4 = await waitForRoundEnd(players);
  if (ended4) {
    const pots = ended4.roundEnded.room.round.pots;
    const potTotal = pots.reduce((s, p) => s + p.amount, 0);
    assert(potTotal === 60 * NUM_PLAYERS, `加注轮底池 = ${60 * NUM_PLAYERS} (实际: ${potTotal})`);

    const winnerId = pots[0].eligible[0];
    host.socket.emit('select-winner', { winnerIds: [winnerId] });
    const settledP = await waitForSettled(players);
    if (settledP) {
      const t4After = getTotalChips(settledP.settled.room);
      assert(t4After === expectedTotal, `加注轮结算后守恒 = ${expectedTotal} (实际: ${t4After})`);
    }
  }

  // ===== Test 5: ALL IN =====
  console.log('\n📋 测试5: ALL IN → 其余弃牌');
  resetPlayerState(players);

  host.socket.emit('start-round');
  await Promise.all(players.map(p => waitFor(p.socket, 'round-started')));
  await sleep(200);

  // First player all-in
  let allInP = await waitForAction(players);
  if (allInP) {
    console.log(`  ${allInP.name} ALL IN`);
    allInP.actionRequired = null;
    allInP.socket.emit('player-action', { action: 'allin' });
    await sleep(200);
  }

  // Everyone else folds
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const active = await waitForAction(players, 2000);
    if (!active) break;
    active.actionRequired = null;
    active.socket.emit('player-action', { action: 'fold' });
    await sleep(200);
    if (players.find(p => p.autoWon)) break;
  }

  const winner5 = await waitForAutoWon(players);
  if (winner5) {
    const t5After = getTotalChips(winner5.lastRoom);
    assert(t5After === expectedTotal, `ALL IN后守恒 = ${expectedTotal} (实际: ${t5After})`);
    console.log(`  赢家: ${winner5.autoWon.name}, 赢得: ${winner5.autoWon.amount}`);
  } else {
    assert(false, 'ALL IN后应有赢家');
  }

  // ===== Test 6: Multiple rounds =====
  console.log('\n📋 测试6: 连续5轮筹码追踪');

  for (let round = 0; round < 5; round++) {
    resetPlayerState(players);
    host.socket.emit('start-round');

    const started = await Promise.all(
      players.map(p => waitFor(p.socket, 'round-started', 5000).catch(() => null))
    );
    if (!started.find(s => s)) {
      console.log(`  第${round + 1}轮: 跳过（无法开始）`);
      continue;
    }
    await sleep(200);

    const tBefore = getTotalChips(started.find(s => s).room);
    assert(tBefore === expectedTotal, `第${round + 1}轮开局守恒 (${tBefore})`);

    // Everyone folds
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const active = await waitForAction(players, 2000);
      if (!active) break;
      active.actionRequired = null;
      active.socket.emit('player-action', { action: 'fold' });
      await sleep(150);
      if (players.find(p => p.autoWon)) break;
    }

    const w = await waitForAutoWon(players);
    if (w) {
      const tAfter = getTotalChips(w.lastRoom);
      assert(tAfter === expectedTotal, `第${round + 1}轮结束守恒 (${tAfter})`);
    }
  }

  // ===== Test 7: Split pot (multiple winners) =====
  console.log('\n📋 测试7: 多人平分底池');
  resetPlayerState(players);

  host.socket.emit('start-round');
  await Promise.all(players.map(p => waitFor(p.socket, 'round-started')));
  await sleep(200);

  // Everyone calls/checks through all phases
  for (let phase = 0; phase < 4; phase++) {
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const active = await waitForAction(players, 2000);
      if (!active) break;
      const opts = active.actionRequired.options;
      active.actionRequired = null;
      if (opts.options.includes('check')) {
        active.socket.emit('player-action', { action: 'check' });
      } else if (opts.options.includes('call')) {
        active.socket.emit('player-action', { action: 'call' });
      }
      await sleep(100);
    }
    await sleep(200);
  }

  const ended7 = await waitForRoundEnd(players);
  if (ended7) {
    const pots = ended7.roundEnded.room.round.pots;
    const potTotal = pots.reduce((s, p) => s + p.amount, 0);

    // Select 2 winners (split pot)
    const eligible = pots[0].eligible;
    const splitWinners = eligible.slice(0, 2);
    host.socket.emit('select-winner', { winnerIds: splitWinners });

    const settledP = await waitForSettled(players);
    if (settledP) {
      const t7After = getTotalChips(settledP.settled.room);
      assert(t7After === expectedTotal, `平分后守恒 = ${expectedTotal} (实际: ${t7After})`);
      const totalWon = settledP.settled.winners.reduce((s, w) => s + w.amount, 0);
      assert(totalWon === potTotal, `赢家获得总额 = 底池 ${potTotal} (实际: ${totalWon})`);
      console.log(`  底池 ${potTotal} 平分给 ${settledP.settled.winners.map(w => w.name).join(', ')}`);
    }
  }

  // ===== Test 8: Disconnect during waiting - reconnect =====
  console.log('\n📋 测试8: 等待阶段断线重连');
  resetPlayerState(players);

  // Record chips before disconnect
  const p2ChipsBefore = players[1].lastRoom
    ? players[1].lastRoom.players.find(p => p.name === '玩家2')?.chips
    : null;

  // Player 2 disconnects
  const p2Name = players[1].name;
  players[1].socket.disconnect();
  await sleep(500);

  // Check player 2 is marked as disconnected
  const roomAfterDc = players[0].lastRoom;
  const p2State = roomAfterDc.players.find(p => p.name === p2Name);
  assert(p2State && p2State.status === 'disconnected', `${p2Name} 状态为 disconnected`);
  assert(roomAfterDc.players.length === NUM_PLAYERS, `玩家数仍为 ${NUM_PLAYERS}（未被移除）`);

  // Player 2 reconnects with new socket, same name
  const p2New = await createPlayer(p2Name);
  p2New.socket.emit('join-room', { roomId, name: p2Name });
  const joinResult = await waitFor(p2New.socket, 'join-success');
  assert(joinResult.reconnected === true, '收到 reconnected=true 标记');

  const p2After = joinResult.room.players.find(p => p.name === p2Name);
  assert(p2After && p2After.status !== 'disconnected', `${p2Name} 重连后状态恢复`);
  if (p2ChipsBefore !== null) {
    assert(p2After.chips === p2ChipsBefore, `筹码保留: ${p2After.chips} === ${p2ChipsBefore}`);
  }

  // Replace player reference
  players[1] = p2New;
  console.log(`  ${p2Name} 断线重连成功，筹码: ${p2After.chips}`);

  // ===== Test 9: Disconnect during game - auto fold, then reconnect =====
  console.log('\n📋 测试9: 游戏中断线 → 自动弃牌 → 重连保留筹码');
  resetPlayerState(players);

  // Start a round
  const rs9Promises = players.map(p => waitFor(p.socket, 'round-started'));
  host.socket.emit('start-round');
  await Promise.all(rs9Promises);
  await sleep(300);

  // Find who is active and will disconnect
  // Let's disconnect a player who is NOT currently active (so they get auto-folded when their turn comes)
  const active9 = await waitForAction(players);
  // We want to disconnect a DIFFERENT player, so the game can continue
  const dcPlayer = players.find(p => p !== active9 && p !== host);
  const dcName = dcPlayer.name;
  const dcChipsBefore = dcPlayer.lastRoom
    ? dcPlayer.lastRoom.players.find(p => p.name === dcName)?.chips
    : null;

  dcPlayer.socket.disconnect();
  await sleep(300);

  // The game should continue - remaining players act
  for (let i = 0; i < NUM_PLAYERS * 4; i++) {
    const ap = await waitForAction(players, 1500);
    if (!ap) break;
    ap.actionRequired = null;
    ap.socket.emit('player-action', { action: 'fold' });
    await sleep(150);
    if (players.find(p => p.autoWon)) break;
  }

  const winner9 = await waitForAutoWon(players);
  if (winner9) {
    // Verify chips conserved (disconnected player's chips are still counted)
    const t9Room = winner9.lastRoom;
    const t9Total = getTotalChips(t9Room);
    // Disconnected player's chips won't show in currentBet, but their chips should be intact
    const dcInRoom = t9Room.players.find(p => p.name === dcName);
    assert(dcInRoom !== undefined, `${dcName} 仍在房间中`);
    assert(dcInRoom.status === 'disconnected' || dcInRoom.status === 'folded',
      `${dcName} 状态为 disconnected/folded (实际: ${dcInRoom.status})`);
    console.log(`  ${dcName} 断线后被自动弃牌，筹码: ${dcInRoom.chips}`);
  }

  // Reconnect the disconnected player
  const dcNew = await createPlayer(dcName);
  dcNew.socket.emit('join-room', { roomId, name: dcName });
  const dcJoinResult = await waitFor(dcNew.socket, 'join-success');
  assert(dcJoinResult.reconnected === true, `${dcName} 重连成功`);

  const dcAfter = dcJoinResult.room.players.find(p => p.name === dcName);
  assert(dcAfter.status !== 'disconnected', `${dcName} 重连后状态恢复`);

  // Replace player reference
  const dcIdx = players.indexOf(dcPlayer);
  players[dcIdx] = dcNew;
  console.log(`  ${dcName} 重连成功，筹码: ${dcAfter.chips}`);

  // Verify total chips still conserved
  const allChips = dcJoinResult.room.players.reduce((s, p) => s + p.chips, 0);
  assert(allChips === expectedTotal, `重连后总筹码守恒 = ${expectedTotal} (实际: ${allChips})`);

  // ===== Test 10: Final settlement =====
  console.log('\n📋 测试10: 最终结算 - 盈亏总和为零');
  resetPlayerState(players);

  host.socket.emit('end-game');
  await sleep(500);

  const endData = players.find(p => p.gameEnded);
  if (endData) {
    const { balances, settlements } = endData.gameEnded;

    const totalProfit = balances.reduce((sum, b) => sum + b.profit, 0);
    assert(totalProfit === 0, `盈亏总和 = 0 (实际: ${totalProfit})`);

    const totalFinalChips = balances.reduce((sum, b) => sum + b.chips, 0);
    const totalBuyIn = balances.reduce((sum, b) => sum + b.buyIn, 0);
    assert(totalFinalChips === totalBuyIn, `筹码总和 = 总买入 (${totalFinalChips} vs ${totalBuyIn})`);

    console.log('\n  盈亏详情:');
    balances.forEach(b => {
      const sign = b.profit > 0 ? '+' : '';
      console.log(`    ${b.name}: 买入${b.buyIn} → 剩余${b.chips} (${sign}${b.profit})`);
    });

    if (settlements.length > 0) {
      console.log('\n  转账方案:');
      settlements.forEach(s => console.log(`    ${s.from} → ${s.to}: ${s.amount}`));

      // Verify settlements match profits
      let correct = true;
      balances.forEach(b => {
        const paid = settlements.filter(s => s.from === b.name).reduce((s, t) => s + t.amount, 0);
        const received = settlements.filter(s => s.to === b.name).reduce((s, t) => s + t.amount, 0);
        const net = received - paid;
        if (net !== b.profit) {
          correct = false;
          console.error(`    ❌ ${b.name} 转账净额${net} ≠ 盈亏${b.profit}`);
        }
      });
      assert(correct, '转账方案与盈亏一致');
    }
  } else {
    assert(false, '应该收到结算数据');
  }

  // ===== Summary =====
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 测试结果: ${totalChecks - totalErrors}/${totalChecks} 通过`);
  if (totalErrors > 0) {
    console.log(`❌ ${totalErrors} 个测试失败\n`);
  } else {
    console.log('✅ 全部通过！\n');
  }

  players.forEach(p => p.socket.disconnect());
  process.exit(totalErrors > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
