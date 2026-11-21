const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const DoubaoSpeechService = require('./doubao-speech.service');

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.sessionStartTime = null;
    this.available = false;
    this.provider = 'doubao';
    this.runtimeSettings = {};
    this.doubaoClient = null;
    this.doubaoConfig = null;
    this.isProcessingAudio = false;
    this.useRendererCapture = false;

    this.initializeClient();
  }

  initializeClient() {
    this._cleanup();
    this.available = false;
    this.doubaoConfig = null;

    this._initializeDoubaoClient();
  }

  _initializeDoubaoClient() {
    try {
      const doubaoConfig = this._getDoubaoConfig();
      if (!doubaoConfig.apiKey && !(doubaoConfig.appId && doubaoConfig.accessToken)) {
        const reason = 'Doubao Speech credentials not found. Speech recognition disabled.';
        logger.warn('Speech service disabled (missing Doubao credentials)');
        this.emit('status', reason);
        return;
      }

      this.doubaoConfig = doubaoConfig;
      this.available = true;
      // 预热 DNS/TCP/TLS，缩短首次录音的建连时间（不创建计费会话）。
      DoubaoSpeechService.prewarm(doubaoConfig.endpoint);
      logger.info('Doubao Speech service initialized successfully', {
        endpoint: doubaoConfig.endpoint,
        resourceId: doubaoConfig.resourceId,
        authMode: doubaoConfig.apiKey ? 'apiKey' : 'appIdToken',
        enableNonstream: doubaoConfig.enableNonstream
      });
      this.emit('status', 'Doubao Speech ready');
    } catch (error) {
      logger.error('Failed to initialize Doubao Speech client', {
        error: error.message,
        stack: error.stack
      });
      this.available = false;
      this.emit('status', 'Doubao Speech unavailable');
    }
  }

  startRecording() {
    try {
      if (this.isRecording) {
        logger.warn('Recording already in progress');
        return;
      }

      if (this.isProcessingAudio) {
        this.emit('status', 'Please wait for the current transcription to finish');
        return;
      }

      this.sessionStartTime = Date.now();

      if (!this.doubaoConfig) {
        throw new Error('Doubao Speech is not configured');
      }

      this._startDoubaoRecording();
    } catch (error) {
      logger.error('Critical error in startRecording', { error: error.message, stack: error.stack });
      this.emit('error', `Speech recognition failed to start: ${error.message}`);
      this.isRecording = false;
    }
  }

  _startDoubaoRecording() {
    if (!this.doubaoConfig) {
      this.emit('error', 'Doubao Speech is not configured');
      return;
    }

    this._cleanup();
    this.isRecording = true;
    // 全平台统一由渲染进程用 Web Audio 采集 16kHz PCM
    this.useRendererCapture = true;

    this.doubaoClient = new DoubaoSpeechService(this.doubaoConfig);

    this.doubaoClient.on('ready', () => {
      logger.info('Doubao streaming ASR ready');
    });

    this.doubaoClient.on('interim', (text) => {
      if (text) {
        this.emit('interim-transcription', text);
      }
    });

    this.doubaoClient.on('final', (text) => {
      if (text) {
        this.emit('transcription', text);
      }
    });

    this.doubaoClient.on('error', (message) => {
      logger.error('Doubao speech recognition error', { error: message });
      this.emit('error', `Doubao speech error: ${message}`);
      if (this.isRecording) {
        try {
          this.stopRecording();
        } catch (_) {
          // ignore
        }
      }
    });

    // 连接级断线由客户端内部重连，不中断录音；只有重试耗尽才会触发 error。
    this.doubaoClient.on('reconnecting', ({ attempt, maxAttempts, reason }) => {
      logger.warn('Doubao reconnecting', { attempt, maxAttempts, reason });
      this.emit('status', `Doubao reconnecting (${attempt}/${maxAttempts})…`);
    });

    this.doubaoClient.on('reconnected', () => {
      logger.info('Doubao reconnected');
      this.emit('status', 'Doubao reconnected');
    });

    this.emit('recording-started');
    this.emit('status', 'Doubao recording started');
    this.doubaoClient.start();
  }

  /**
   * Receive raw 16kHz mono 16-bit PCM audio captured by the renderer's Web
   * Audio API and forward it to the Doubao streaming client.
   */
  handleAudioChunkFromRenderer(chunk) {
    if (!this.isRecording || !this.useRendererCapture) {
      return;
    }
    if (!chunk || !chunk.length) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.doubaoClient) {
      this.doubaoClient.sendAudio(buffer);
    }
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    const sessionDuration = this.sessionStartTime ? Date.now() - this.sessionStartTime : 0;
    logger.info('Stopping speech recognition session', {
      provider: this.provider,
      sessionDuration: `${sessionDuration}ms`
    });

    this.isProcessingAudio = true;
    this.emit('recording-stopped');
    this.emit('status', 'Processing Doubao speech…');

    const client = this.doubaoClient;
    if (!client) {
      this._finalizeStop('Recording stopped');
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      this._finalizeStop('Recording stopped');
    };
    // 等待服务端返回最后一段结果，超时则直接收尾
    const timer = setTimeout(settle, 4000);
    client.once('closed', settle);
    client.finish();
  }

  _finalizeStop(statusMessage) {
    this._cleanup();
    this.emit('status', statusMessage);
  }

  _cleanup() {
    if (this.doubaoClient) {
      try {
        this.doubaoClient.close();
      } catch (error) {
        logger.error('Error closing Doubao client', { error: error.message });
      }
      this.doubaoClient = null;
    }

    this.isProcessingAudio = false;
    this.useRendererCapture = false;
  }

  async testConnection() {
    return this.doubaoConfig
      ? { success: true, message: 'Doubao Speech is configured' }
      : { success: false, message: 'Doubao Speech credentials not found' };
  }

  getStatus() {
    return {
      provider: this.provider,
      isRecording: this.isRecording,
      isProcessingAudio: this.isProcessingAudio,
      isInitialized: !!this.doubaoConfig,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      effectiveSettings: {
        speechProvider: this.provider,
        doubaoResourceId: this.doubaoConfig ? this.doubaoConfig.resourceId : '',
        doubaoEndpoint: this.doubaoConfig ? this.doubaoConfig.endpoint : '',
        doubaoEnableNonstream: this.doubaoConfig ? this.doubaoConfig.enableNonstream : false
      }
    };
  }

  isAvailable() {
    return !!this.doubaoConfig && !!this.available;
  }

  shutdown() {
    this.isRecording = false;
    this.isProcessingAudio = false;
    this._cleanup();
  }

  updateSettings(settings = {}) {
    const speechKeys = [
      'doubaoApiKey',
      'doubaoAppId',
      'doubaoAccessToken',
      'doubaoResourceId',
      'doubaoEnableNonstream'
    ];
    let changed = false;

    for (const key of speechKeys) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        this.runtimeSettings[key] = settings[key];
        changed = true;
      }
    }

    if (changed) {
      this.initializeClient();
    }

    return this.getStatus();
  }

  _getDoubaoConfig() {
    const apiKey = String(this._getSetting('doubaoApiKey') || process.env.DOUBAO_API_KEY || '').trim();
    const appId = String(this._getSetting('doubaoAppId') || process.env.DOUBAO_APP_ID || '').trim();
    const accessToken = String(this._getSetting('doubaoAccessToken') || process.env.DOUBAO_ACCESS_TOKEN || '').trim();
    const resourceId = String(this._getSetting('doubaoResourceId') || process.env.DOUBAO_RESOURCE_ID || '').trim() ||
      'volc.seedasr.sauc.duration';
    const enableNonstreamRaw = this._getSetting('doubaoEnableNonstream') ?? process.env.DOUBAO_ENABLE_NONSTREAM;
    const enableNonstream = enableNonstreamRaw === undefined || enableNonstreamRaw === null || enableNonstreamRaw === ''
      ? true
      : !['false', '0', 'off', 'no'].includes(String(enableNonstreamRaw).toLowerCase());

    return {
      apiKey,
      appId,
      accessToken,
      resourceId,
      endpoint: process.env.DOUBAO_ENDPOINT || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      enableNonstream
    };
  }

  _getSetting(key) {
    const value = this.runtimeSettings[key];
    return value === '' ? null : value;
  }
}

module.exports = new SpeechService();
