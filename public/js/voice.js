// Voice recognition module - continuous auto-listening
class VoiceRecognition {
  constructor() {
    this.recognition = null;
    this.isSupported = false;
    this.isListening = false;
    this.onCommand = null;
    this.onStatus = null;
    this.onTranscript = null;
    this.restartTimeout = null;
    this.enabled = false;
    this.init();
  }

  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Speech Recognition not supported');
      return;
    }

    this.isSupported = true;
    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 3;

    this.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();

        if (this.onTranscript) {
          this.onTranscript(transcript, result.isFinal);
        }

        if (result.isFinal) {
          this.parseCommand(transcript);
        }
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      if (this.onStatus) this.onStatus('stopped');
      // Auto-restart if enabled
      if (this.enabled) {
        this.restartTimeout = setTimeout(() => {
          this.startListening();
        }, 300);
      }
    };

    this.recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        // Normal, just restart
        return;
      }
      console.error('Speech recognition error:', event.error);
      if (this.onStatus) this.onStatus('error', event.error);
    };

    this.recognition.onstart = () => {
      this.isListening = true;
      if (this.onStatus) this.onStatus('listening');
    };
  }

  startListening() {
    if (!this.isSupported || this.isListening) return;
    try {
      this.recognition.start();
    } catch (e) {
      // Already started
    }
  }

  stopListening() {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.enabled = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {}
    }
    this.isListening = false;
  }

  toggle() {
    if (this.enabled) {
      this.stopListening();
    } else {
      this.enabled = true;
      this.startListening();
    }
    return this.enabled;
  }

  parseCommand(text) {
    const normalized = text.replace(/\s+/g, '');
    let command = null;

    // Check for fold
    if (/弃牌|不要|不玩/.test(normalized)) {
      command = { action: 'fold' };
    }
    // Check for check
    else if (/过牌|让牌|过/.test(normalized) && !/加/.test(normalized)) {
      command = { action: 'check' };
    }
    // Check for all-in
    else if (/全下|梭哈|全押|[aA][lL]{2}\s*[iI][nN]|allin/.test(normalized)) {
      command = { action: 'allin' };
    }
    // Check for call
    else if (/跟注|跟|跟上/.test(normalized) && !/加/.test(normalized)) {
      command = { action: 'call' };
    }
    // Check for raise with amount
    else if (/下注|加注|加|raise|bet/.test(normalized)) {
      const amount = this.extractNumber(normalized);
      if (amount > 0) {
        command = { action: 'raise', amount };
      }
    }
    // Try to extract just a number (implicit raise)
    else {
      const amount = this.extractNumber(normalized);
      if (amount > 0) {
        command = { action: 'raise', amount };
      }
    }

    if (command && this.onCommand) {
      this.onCommand(command);
    }
  }

  extractNumber(text) {
    // Try Arabic numerals first
    const arabicMatch = text.match(/(\d+)/);
    if (arabicMatch) {
      return parseInt(arabicMatch[1]);
    }

    // Chinese number conversion
    const chineseNums = {
      '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    };
    const chineseUnits = {
      '十': 10, '百': 100, '千': 1000, '万': 10000,
    };

    let result = 0;
    let current = 0;
    let hasChineseNum = false;

    for (const char of text) {
      if (chineseNums[char] !== undefined) {
        current = chineseNums[char];
        hasChineseNum = true;
      } else if (chineseUnits[char]) {
        if (current === 0 && char === '十') current = 1;
        current *= chineseUnits[char];
        result += current;
        current = 0;
        hasChineseNum = true;
      }
    }
    result += current;

    return hasChineseNum ? result : 0;
  }
}

const voiceRecognition = new VoiceRecognition();
