// Main application
const app = {
  room: null,
  myId: null,
  actionOptions: null,

  init() {
    this.myId = socketClient.id;
    this.bindEvents();
    this.checkURLRoom();

    // Wait for socket connection to get ID
    socketClient.socket.on('connect', () => {
      this.myId = socketClient.socket.id;
    });
  },

  bindEvents() {
    // Room events
    socketClient.on('room-created', ({ room }) => {
      this.room = room;
      this.myId = socketClient.socket.id;
      UI.showPage('page-lobby');
      this.renderLobby();
      // Update URL for sharing
      history.replaceState(null, '', `?room=${room.id}`);
      UI.showToast('房间创建成功！');
    });

    socketClient.on('room-updated', ({ room }) => {
      this.room = room;
      if (this.room.status === 'waiting') {
        this.renderLobby();
      } else {
        this.renderGame();
      }
    });

    socketClient.on('join-success', ({ room }) => {
      this.room = room;
      this.myId = socketClient.socket.id;
      UI.showPage('page-lobby');
      this.renderLobby();
      history.replaceState(null, '', `?room=${room.id}`);
      UI.showToast('加入房间成功！');
    });

    socketClient.on('round-started', ({ room }) => {
      this.room = room;
      this.actionOptions = null;
      UI.showPage('page-game');
      this.renderGame();
      UI.showToast(`第 ${room.round.roundNumber} 轮开始！`);
    });

    socketClient.on('action-required', ({ playerId, options, room }) => {
      if (room) this.room = room;
      if (playerId === socketClient.socket.id) {
        this.actionOptions = options;
        this.renderGame();
        // Vibrate to notify
        if (navigator.vibrate) navigator.vibrate(200);
        UI.showToast('轮到你操作了！', 'warning');
      } else {
        this.actionOptions = null;
        this.renderGame();
      }
    });

    socketClient.on('player-acted', ({ playerName, action, amount, room }) => {
      this.room = room;
      const actionNames = {
        fold: '弃牌', check: '过牌', call: '跟注',
        raise: '加注', allin: 'ALL IN',
      };
      const actionText = actionNames[action] || action;
      const amountText = (action === 'raise' && amount) ? ` ${amount}` : '';
      UI.showToast(`${playerName} ${actionText}${amountText}`);
    });

    socketClient.on('phase-changed', ({ room }) => {
      this.room = room;
      this.actionOptions = null;
      this.renderGame();
      const phaseNames = {
        preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌',
      };
      UI.showToast(`进入 ${phaseNames[room.round.phase]}`, 'info');
    });

    socketClient.on('round-ended', ({ room, pots }) => {
      this.room = room;
      this.actionOptions = null;
      this.renderGame();
    });

    socketClient.on('round-auto-won', ({ room, winner }) => {
      this.room = room;
      this.actionOptions = null;
      this.renderGame();
      UI.showToast(`${winner.name} 赢得 ${winner.amount} 筹码！`, 'success');
    });

    socketClient.on('round-settled', ({ room, winners }) => {
      this.room = room;
      this.actionOptions = null;
      this.renderGame();
      const text = winners.map(w => `${w.name} 赢得 ${w.amount}`).join('，');
      UI.showToast(text, 'success');
    });

    socketClient.on('game-ended', ({ balances, settlements, history }) => {
      UI.showPage('page-settlement');
      document.getElementById('page-settlement').innerHTML =
        UI.renderSettlement(balances, settlements, history);
      // Stop voice recognition
      voiceRecognition.stopListening();
    });

    socketClient.on('app-error', ({ message }) => {
      UI.showToast(message, 'error');
    });

    // Voice recognition
    voiceRecognition.onCommand = (command) => {
      if (!this.room || !this.room.round) return;
      const me = this.room.players.find(p => p.id === socketClient.socket.id);
      if (!me || me.seatIndex !== this.room.round.activePlayerIndex) return;

      UI.showToast(`语音指令: ${command.action}${command.amount ? ' ' + command.amount : ''}`, 'info');
      this.doAction(command.action, command.amount);
    };

    voiceRecognition.onTranscript = (text, isFinal) => {
      const el = document.getElementById('voiceTranscript');
      if (el) {
        el.style.display = 'block';
        el.textContent = isFinal ? `✓ ${text}` : `... ${text}`;
        if (isFinal) {
          setTimeout(() => { el.style.display = 'none'; }, 2000);
        }
      }
    };

    voiceRecognition.onStatus = (status, error) => {
      const indicator = document.getElementById('voiceIndicator');
      const text = document.getElementById('voiceText');
      const btn = document.getElementById('voiceToggle');
      if (!indicator) return;

      switch (status) {
        case 'listening':
          indicator.classList.add('active');
          if (text) text.textContent = '语音监听中...';
          if (btn) btn.textContent = '关闭语音';
          break;
        case 'stopped':
          indicator.classList.remove('active');
          if (text) text.textContent = '语音已暂停';
          break;
        case 'error':
          indicator.classList.remove('active');
          if (text) text.textContent = `语音错误: ${error}`;
          break;
      }
    };
  },

  checkURLRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    if (roomId) {
      document.getElementById('joinRoomId').value = roomId;
      UI.showPage('page-home');
    }
  },

  // Page actions
  createRoom() {
    const name = document.getElementById('createName').value.trim();
    if (!name) { UI.showToast('请输入昵称', 'error'); return; }
    const chips = parseInt(document.getElementById('initialChips').value) || 1000;
    const sb = parseInt(document.getElementById('smallBlind').value) || 5;
    const bb = parseInt(document.getElementById('bigBlind').value) || 10;

    socketClient.createRoom(name, { initialChips: chips, smallBlind: sb, bigBlind: bb });
  },

  joinRoom() {
    const roomId = document.getElementById('joinRoomId').value.trim();
    const name = document.getElementById('joinName').value.trim();
    if (!roomId) { UI.showToast('请输入房间号', 'error'); return; }
    if (!name) { UI.showToast('请输入昵称', 'error'); return; }
    socketClient.joinRoom(roomId, name);
  },

  renderLobby() {
    if (!this.room) return;
    const lobby = document.getElementById('page-lobby');
    const isHost = this.room.hostId === socketClient.socket.id;

    lobby.innerHTML = `
      <div class="lobby-header">
        <h2>房间 <span class="room-code">${this.room.id}</span></h2>
        <button class="btn btn-small btn-secondary" onclick="app.copyRoomLink()">复制邀请链接</button>
      </div>
      <div class="lobby-settings">
        <span>初始筹码: ${this.room.settings.initialChips}</span>
        <span>盲注: ${this.room.settings.smallBlind}/${this.room.settings.bigBlind}</span>
      </div>
      <div class="lobby-players">
        <h3>玩家 (${this.room.players.length}/10)</h3>
        ${UI.renderPlayerList(this.room.players, this.room.hostId, socketClient.socket.id)}
      </div>
      ${isHost ? `
        <div class="lobby-actions">
          <button class="btn btn-primary btn-large" onclick="app.startRound()" ${this.room.players.length < 2 ? 'disabled' : ''}>
            开始游戏 ${this.room.players.length < 2 ? '(至少2人)' : ''}
          </button>
        </div>
      ` : '<div class="lobby-waiting">等待房主开始游戏...</div>'}
    `;
  },

  renderGame() {
    if (!this.room) return;
    const game = document.getElementById('page-game');
    game.innerHTML = UI.renderGameTable(this.room, socketClient.socket.id, this.actionOptions);
  },

  startRound() {
    socketClient.startRound();
  },

  doAction(action, amount) {
    socketClient.playerAction(action, amount ? parseInt(amount) : undefined);
    this.actionOptions = null;
  },

  confirmWinners() {
    const checks = document.querySelectorAll('.winner-check:checked');
    const winnerIds = Array.from(checks).map(c => c.value);
    if (winnerIds.length === 0) {
      UI.showToast('请选择至少一个赢家', 'error');
      return;
    }
    socketClient.selectWinner(winnerIds);
  },

  showBuyIn() {
    UI.showModal('买入筹码', `
      <input type="number" id="buyInAmount" class="modal-input" value="${this.room.settings.initialChips}" inputmode="numeric">
    `, () => {
      const amount = parseInt(document.getElementById('buyInAmount').value);
      if (amount > 0) {
        socketClient.buyIn(amount);
        UI.showToast(`买入 ${amount} 筹码`);
      }
    });
  },

  endGame() {
    UI.showModal('结束游戏', '<p>确定要结束游戏并进行最终结算吗？</p>', () => {
      socketClient.endGame();
    });
  },

  toggleVoice() {
    const enabled = voiceRecognition.toggle();
    const btn = document.getElementById('voiceToggle');
    const text = document.getElementById('voiceText');
    if (btn) btn.textContent = enabled ? '关闭语音' : '开启语音';
    if (text) text.textContent = enabled ? '语音启动中...' : '语音已关闭';
  },

  copyRoomLink() {
    const url = `${window.location.origin}?room=${this.room.id}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => UI.showToast('链接已复制！'));
    } else {
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      UI.showToast('链接已复制！');
    }
  },

  backToHome() {
    this.room = null;
    this.actionOptions = null;
    history.replaceState(null, '', window.location.pathname);
    UI.showPage('page-home');
  },
};

// Initialize when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
