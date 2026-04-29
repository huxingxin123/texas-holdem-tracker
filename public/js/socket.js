// Socket.IO client wrapper
class SocketClient {
  constructor() {
    this.socket = io();
    this.listeners = {};
  }

  on(event, callback) {
    this.socket.on(event, callback);
  }

  emit(event, data) {
    this.socket.emit(event, data);
  }

  get id() {
    return this.socket.id;
  }

  createRoom(name, settings) {
    this.emit('create-room', { name, settings });
  }

  joinRoom(roomId, name) {
    this.emit('join-room', { roomId: roomId.trim(), name });
  }

  startRound() {
    this.emit('start-round');
  }

  playerAction(action, amount) {
    this.emit('player-action', { action, amount });
  }

  selectWinner(winnerIds) {
    this.emit('select-winner', { winnerIds });
  }

  buyIn(amount) {
    this.emit('buy-in', { amount });
  }

  endGame() {
    this.emit('end-game');
  }
}

const socketClient = new SocketClient();
