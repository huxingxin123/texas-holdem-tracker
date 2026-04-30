// UI rendering module
const UI = {
  showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById(pageId);
    if (page) page.classList.add('active');
  },

  renderPlayerList(players, hostId, myId) {
    return players.map(p => {
      const isHost = p.id === hostId;
      const isMe = p.id === myId;
      return `
        <div class="player-item ${isMe ? 'is-me' : ''} ${p.status}">
          <div class="player-avatar">${p.name[0]}</div>
          <div class="player-info">
            <span class="player-name">${p.name}${isHost ? ' <span class="badge host">房主</span>' : ''}${isMe ? ' <span class="badge me">我</span>' : ''}</span>
            <span class="player-chips">${p.chips} 筹码</span>
          </div>
          ${p.status === 'folded' ? '<span class="status-badge folded">已弃牌</span>' : ''}
          ${p.status === 'allin' ? '<span class="status-badge allin">ALL IN</span>' : ''}
          ${p.status === 'out' ? '<span class="status-badge out">出局</span>' : ''}
          ${p.status === 'disconnected' ? '<span class="status-badge disconnected">离线</span>' : ''}
        </div>
      `;
    }).join('');
  },

  renderGameTable(room, myId, actionOptions) {
    const me = room.players.find(p => p.id === myId);
    const isHost = room.hostId === myId;
    const round = room.round;
    const isMyTurn = round && me && me.seatIndex === round.activePlayerIndex;

    const phaseNames = {
      preflop: '翻牌前',
      flop: '翻牌',
      turn: '转牌',
      river: '河牌',
      showdown: '摊牌',
    };

    // Calculate total pot
    const totalBets = room.players.reduce((sum, p) => sum + (p.currentBet || 0), 0);
    const pot = (round ? round.pot || 0 : 0) + totalBets;

    // Determine how many cards are revealed based on phase
    const revealedCount = !round ? 0 : { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 }[round.phase] || 0;

    let cardsHtml = '';
    for (let i = 0; i < 5; i++) {
      const isRevealed = i < revealedCount;
      cardsHtml += `<div class="community-card ${isRevealed ? 'revealed' : 'facedown'}">
        ${isRevealed ? '<div class="card-face">🂠</div>' : '<div class="card-back"></div>'}
      </div>`;
    }

    let html = `
      <div class="game-header">
        <div class="room-info">
          <span class="room-id">房间 ${room.id}</span>
          <span class="round-num">第 ${round ? round.roundNumber : 0} 轮</span>
        </div>
        <div class="phase-indicator ${round ? round.phase : ''}">${round ? phaseNames[round.phase] || '' : ''}</div>
      </div>

      <div class="community-cards">
        ${cardsHtml}
      </div>

      <div class="pot-display">
        <div class="pot-label">底池</div>
        <div class="pot-amount">${pot}</div>
      </div>

      <div class="players-list">
    `;

    room.players.forEach((p, i) => {
      const isActive = round && p.seatIndex === round.activePlayerIndex;
      const isDealer = p.isDealer;

      let badges = '';
      if (isDealer) badges += '<span class="seat-badge dealer">D</span>';
      if (round && round.sbIndex === p.seatIndex) badges += '<span class="seat-badge sb">SB</span>';
      if (round && round.bbIndex === p.seatIndex) badges += '<span class="seat-badge bb">BB</span>';

      let statusText = '';
      if (p.status === 'folded') statusText = '<span class="player-status folded">弃牌</span>';
      else if (p.status === 'allin') statusText = '<span class="player-status allin">ALL IN</span>';
      else if (p.status === 'disconnected') statusText = '<span class="player-status disconnected">离线</span>';
      else if (p.status === 'out') statusText = '<span class="player-status out">出局</span>';
      else if (isActive) statusText = '<span class="player-status thinking">思考中...</span>';

      html += `
        <div class="table-player-row ${p.status} ${isActive ? 'active-turn' : ''} ${p.id === myId ? 'is-me' : ''}">
          <div class="tp-avatar ${isActive ? 'pulse' : ''}">${p.name[0]}</div>
          <div class="tp-info">
            <div class="tp-name-row">
              <span class="tp-name">${p.name}</span>
              ${badges}
              ${p.id === myId ? '<span class="seat-badge me">我</span>' : ''}
            </div>
            <div class="tp-chips-row">
              <span class="tp-chips">${p.chips}</span>
              ${p.currentBet > 0 ? `<span class="tp-bet">下注 ${p.currentBet}</span>` : ''}
              ${statusText}
            </div>
          </div>
        </div>
      `;
    });

    html += '</div>';

    // Voice status
    html += `
      <div class="voice-status" id="voiceStatus">
        <div class="voice-indicator" id="voiceIndicator">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </div>
        <span id="voiceText">语音已关闭</span>
        <button class="voice-toggle" id="voiceToggle" onclick="app.toggleVoice()">开启语音</button>
      </div>
      <div class="voice-transcript" id="voiceTranscript" style="display:none;"></div>
    `;

    // Timer bar
    if (round && round.phase !== 'showdown' && room.actionDeadline) {
      html += `<div class="timer-bar" id="timerBar"><div class="timer-fill" id="timerFill"></div></div>`;
    }

    // Action area
    if (round && round.phase === 'showdown') {
      html += this.renderShowdown(room, isHost, myId);
    } else if (isMyTurn && actionOptions) {
      html += this.renderActions(actionOptions, me);
    } else if (round && round.phase !== 'showdown') {
      const activePlayer = room.players.find(p => p.seatIndex === round.activePlayerIndex);
      html += `
        <div class="waiting-action">
          <div class="waiting-text">等待 <strong>${activePlayer ? activePlayer.name : '...'}</strong> 操作</div>
        </div>
      `;
    }

    // Host controls
    if (isHost && (!round || round.phase === 'showdown')) {
      html += `
        <div class="host-controls">
          ${!round || round.winners ? `<button class="btn btn-primary btn-large" onclick="app.startRound()">开始新一轮</button>` : ''}
          <button class="btn btn-danger" onclick="app.endGame()">结束游戏</button>
        </div>
      `;
    }

    // My info
    if (me) {
      html += `
        <div class="my-info">
          <div class="my-chips">
            <span>我的筹码</span>
            <strong>${me.chips}</strong>
          </div>
          <button class="btn btn-small btn-secondary" onclick="app.showBuyIn()">买入</button>
        </div>
      `;
    }

    return html;
  },

  renderActions(options, me) {
    const toCall = options.toCall || 0;
    const minRaise = options.minRaise || 10;

    let html = '<div class="action-area">';

    // Row 1: Primary actions (check/call) — the safe, common actions
    html += '<div class="action-row action-row-primary">';
    if (options.options.includes('check')) {
      html += `<button class="btn btn-check" onclick="app.doAction('check')">
        <span class="btn-icon">✓</span> 过牌
      </button>`;
    }
    if (options.options.includes('call') && toCall > 0) {
      html += `<button class="btn btn-call" onclick="app.doAction('call')">
        <span class="btn-icon">→</span> 跟注 <span class="btn-amount">${toCall}</span>
      </button>`;
    }
    html += '</div>';

    // Row 2: Raise — quick buttons + custom input
    if (options.options.includes('raise')) {
      const currentPot = options.currentPot || 0;
      const halfPot = Math.max(minRaise, Math.floor(currentPot / 2));
      const fullPot = Math.max(minRaise, currentPot);
      const x2 = minRaise * 2;
      const x3 = minRaise * 3;

      html += `
        <div class="action-row action-row-raise">
          <div class="raise-shortcuts">
            <button class="btn btn-shortcut" onclick="document.getElementById('raiseAmount').value=${minRaise}">最小</button>
            <button class="btn btn-shortcut" onclick="document.getElementById('raiseAmount').value=${x2}">2x</button>
            <button class="btn btn-shortcut" onclick="document.getElementById('raiseAmount').value=${x3}">3x</button>
            <button class="btn btn-shortcut" onclick="document.getElementById('raiseAmount').value=${halfPot}">½底池</button>
            <button class="btn btn-shortcut" onclick="document.getElementById('raiseAmount').value=${fullPot}">底池</button>
          </div>
          <div class="raise-control">
            <input type="number" id="raiseAmount" class="raise-input" value="${minRaise}" min="${minRaise}" step="${minRaise}" inputmode="numeric" placeholder="加注金额">
            <button class="btn btn-raise" onclick="app.doAction('raise', document.getElementById('raiseAmount').value)">
              <span class="btn-icon">↑</span> 加注
            </button>
          </div>
        </div>
      `;
    }

    // Row 3: Dangerous actions — fold and all-in, require confirmation
    html += '<div class="action-row action-row-danger">';
    if (options.options.includes('fold')) {
      html += `<button class="btn btn-fold" onclick="app.confirmAction('fold', '确定弃牌？', '弃牌后本轮无法继续')">
        <span class="btn-icon">✕</span> 弃牌
      </button>`;
    }
    if (options.options.includes('allin')) {
      html += `<button class="btn btn-allin" onclick="app.confirmAction('allin', 'ALL IN？', '将押上全部 ${me.chips} 筹码')">ALL IN</button>`;
    }
    html += '</div>';

    html += '</div>';
    return html;
  },

  renderShowdown(room, isHost, myId) {
    if (room.round.winners) {
      const winnersText = room.round.winners.map(w => `${w.name} 赢得 ${w.amount}`).join('，');
      return `<div class="showdown-result"><div class="winner-text">${winnersText}</div></div>`;
    }

    if (!isHost) {
      return '<div class="showdown-waiting">等待房主选择赢家...</div>';
    }

    const eligible = room.players.filter(p => p.status !== 'folded' && p.status !== 'waiting' && p.status !== 'out' && p.status !== 'disconnected');

    let html = `
      <div class="showdown-select">
        <h3>选择赢家</h3>
        <p class="showdown-hint">可选择多个赢家平分底池</p>
        <div class="winner-options">
    `;
    eligible.forEach(p => {
      html += `
        <label class="winner-option">
          <input type="checkbox" value="${p.id}" class="winner-check">
          <span class="winner-label">${p.name}</span>
        </label>
      `;
    });
    html += `
        </div>
        <button class="btn btn-primary btn-large" onclick="app.confirmWinners()">确认赢家</button>
      </div>
    `;
    return html;
  },

  renderSettlement(balances, settlements, history) {
    let html = `
      <div class="settlement-page">
        <h2>游戏结算</h2>

        <div class="settlement-section">
          <h3>盈亏排行</h3>
          <div class="balance-list">
    `;

    const sorted = [...balances].sort((a, b) => b.profit - a.profit);
    sorted.forEach(b => {
      const profitClass = b.profit > 0 ? 'profit-positive' : b.profit < 0 ? 'profit-negative' : 'profit-zero';
      html += `
        <div class="balance-item">
          <div class="balance-avatar">${b.name[0]}</div>
          <div class="balance-info">
            <div class="balance-name">${b.name}</div>
            <div class="balance-detail">买入 ${b.buyIn} / 剩余 ${b.chips}</div>
          </div>
          <div class="balance-profit ${profitClass}">
            ${b.profit > 0 ? '+' : ''}${b.profit}
          </div>
        </div>
      `;
    });

    html += '</div></div>';

    if (settlements.length > 0) {
      html += `
        <div class="settlement-section">
          <h3>转账方案</h3>
          <div class="transfer-list">
      `;
      settlements.forEach(s => {
        html += `
          <div class="transfer-item">
            <span class="transfer-from">${s.from}</span>
            <span class="transfer-arrow">→</span>
            <span class="transfer-to">${s.to}</span>
            <span class="transfer-amount">${s.amount}</span>
          </div>
        `;
      });
      html += '</div></div>';
    }

    html += `
        <div class="ad-container">
          <ins class="adsbygoogle"
            style="display:block"
            data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"
            data-ad-slot="SETTLEMENT_AD_SLOT"
            data-ad-format="auto"
            data-full-width-responsive="true"></ins>
        </div>
        <div class="settlement-actions">
          <button class="btn btn-primary" onclick="app.backToHome()">返回首页</button>
        </div>
      </div>
    `;

    return html;
  },

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  },

  showModal(title, content, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>${title}</h3>
        <div class="modal-body">${content}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary modal-cancel">取消</button>
          <button class="btn btn-primary modal-confirm">确认</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    overlay.querySelector('.modal-cancel').onclick = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };
    overlay.querySelector('.modal-confirm').onclick = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
      if (onConfirm) onConfirm();
    };
  },
};
