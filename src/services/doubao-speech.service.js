const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const zlib = require('zlib');
const tls = require('tls');
const WebSocket = require('ws');
const logger = require('../core/logger').createServiceLogger('DOUBAO');

// 火山引擎流式语音识别二进制协议常量
const PROTOCOL_VERSION = 0x01;
const HEADER_SIZE = 0x01;
const MSG_FULL_CLIENT = 0x01;
const MSG_AUDIO_ONLY = 0x02;
const MSG_FULL_SERVER = 0x09;
const MSG_SERVER_ERROR = 0x0f;
const FLAG_NONE = 0x00;
const FLAG_LAST = 0x02;
const SERIALIZATION_JSON = 0x01;
const COMPRESSION_GZIP = 0x01;
const COMPRESSION_NONE = 0x00;

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';
// 协议建议单包 100~200ms；16kHz/16bit 单声道下 5120 字节约为 160ms
const AUDIO_FRAME_BYTES = 5120;
// 断线期间最多缓存 5 秒音频；重连后超过 3 秒的旧音频直接丢弃，
// 避免把过期语音补发给服务端造成结果滞后。
const MAX_QUEUE_BYTES = 16000 * 2 * 5;
const MAX_QUEUE_AGE_MS = 3000;
// 重连退避：0.5s、1s、2s、4s
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 500;

class DoubaoSpeechService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      endpoint: DEFAULT_ENDPOINT,
      resourceId: DEFAULT_RESOURCE_ID,
      enableNonstream: true,
      ...options
    };
    this.ws = null;
    this.ready = false;
    this.finishing = false;
    this.closedEmitted = false;
    this.audioQueue = [];
    this.queuedBytes = 0;
    this.droppedBytes = 0;
    this.latestText = '';
    this.finalizedCount = 0;
    this.finalizedTexts = [];
    this.closeTimer = null;
    this.connectTimer = null;
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.hasConnectedBefore = false;
    this.queueOverflowReported = false;
  }

  /**
   * 预热 DNS/TCP/TLS，减少首次录音时的建连耗时。
   * 不发起 WebSocket 握手，因此不会创建计费会话。
   */
  static prewarm(endpoint = DEFAULT_ENDPOINT) {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_) {
      return;
    }
    if (!url.hostname) {
      return;
    }
    try {
      const socket = tls.connect({
        host: url.hostname,
        port: Number(url.port) || 443,
        servername: url.hostname
      });
      socket.setTimeout(5000, () => socket.destroy());
      socket.once('secureConnect', () => {
        logger.debug('Doubao TLS prewarm ready', { host: url.hostname });
        socket.destroy();
      });
      socket.once('error', (error) => {
        logger.debug('Doubao TLS prewarm failed', { error: error.message });
        socket.destroy();
      });
    } catch (error) {
      logger.debug('Doubao TLS prewarm skipped', { error: error.message });
    }
  }

  isConfigured() {
    const { apiKey, appId, accessToken } = this.options;
    return !!apiKey || (!!appId && !!accessToken);
  }

  start() {
    if (!this.isConfigured()) {
      this.emit('error', '豆包语音识别未配置，请填写 API Key 或 APP ID + Access Token');
      return;
    }
    if (this.ws) {
      return;
    }

    // 每次（重）连都是一个新的识别会话，需要重置会话内状态。
    this.ready = false;
    this.finishing = false;
    this.closedEmitted = false;
    this.latestText = '';
    this.finalizedCount = 0;
    this.shouldReconnect = true;

    const headers = {
      'X-Api-Resource-Id': this.options.resourceId || DEFAULT_RESOURCE_ID,
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Request-Id': randomUUID()
    };
    if (this.options.apiKey) {
      headers['X-Api-Key'] = this.options.apiKey;
    } else {
      headers['X-Api-App-Key'] = this.options.appId;
      headers['X-Api-Access-Key'] = this.options.accessToken;
    }

    logger.info('Connecting to Doubao streaming ASR', {
      endpoint: this.options.endpoint,
      resourceId: headers['X-Api-Resource-Id'],
      authMode: this.options.apiKey ? 'apiKey' : 'appIdToken'
    });

    try {
      this.ws = new WebSocket(this.options.endpoint, { headers });
    } catch (error) {
      this.emit('error', `豆包语音连接失败: ${error.message}`);
      return;
    }

    this.ws.binaryType = 'nodebuffer';

    this.connectTimer = setTimeout(() => {
      if (!this.ready) {
        logger.warn('Doubao WebSocket connect timeout');
        this._teardownSocket();
        this._scheduleReconnect('连接超时');
      }
    }, 10000);

    this.ws.on('open', () => {
      this._sendFullClientRequest();
    });

    this.ws.on('message', (data) => this._handleMessage(data));

    this.ws.on('error', (error) => {
      // 连接级错误通常后跟 close，由 close 统一决定重连；
      // 这里只记录，避免 UI 被每条重试日志刷屏。
      logger.error('Doubao WebSocket error', { error: error.message });
    });

    this.ws.on('unexpected-response', (request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        const detail = body ? `: ${body.slice(0, 300)}` : '';
        logger.error('Doubao handshake rejected', {
          statusCode: response.statusCode,
          body: body.slice(0, 300)
        });
        // 鉴权/参数错误重试没有意义，直接终止并上报。
        this.shouldReconnect = false;
        this.emit('error', `豆包语音鉴权失败（HTTP ${response.statusCode}）${detail}`);
      });
      response.on('error', () => {});
      try {
        request.destroy();
      } catch (_) {
        // ignore
      }
      this.close();
    });

    this.ws.on('close', () => {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.ws = null;
      this.ready = false;
      logger.info('Doubao WebSocket closed');
      if (this.shouldReconnect && !this.finishing) {
        this._scheduleReconnect('连接断开');
      } else {
        this._emitClosed();
      }
    });
  }

  /**
   * 断开当前 socket，但不触发 close 回调（用于连接超时后主动重建）。
   */
  _teardownSocket() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    this.ready = false;
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.terminate();
      } catch (_) {
        // ignore
      }
    }
  }

  _scheduleReconnect(reason) {
    if (this.reconnectTimer || !this.shouldReconnect || this.finishing) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.shouldReconnect = false;
      logger.error('Doubao reconnect attempts exhausted', {
        attempts: this.reconnectAttempts,
        reason
      });
      this.emit(
        'error',
        `豆包语音连接中断（${reason}），已重试 ${this.reconnectAttempts} 次仍失败，请检查网络`
      );
      this._emitClosed();
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      8000
    );
    this.reconnectAttempts += 1;
    logger.warn('Scheduling Doubao reconnect', {
      attempt: this.reconnectAttempts,
      delay,
      reason
    });
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delay,
      reason
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || this.finishing) {
        return;
      }
      this.start();
    }, delay);
  }

  sendAudio(chunk) {
    if (!chunk || !chunk.length) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._enqueueAudio(buffer);
      return;
    }

    for (let offset = 0; offset < buffer.length; offset += AUDIO_FRAME_BYTES) {
      this._sendAudioFrame(buffer.slice(offset, offset + AUDIO_FRAME_BYTES), false);
    }
  }

  /**
   * 连接建立前/断线期间缓存音频，超限时丢弃最旧的块并记录一次告警。
   */
  _enqueueAudio(buffer) {
    this.audioQueue.push({ buffer, at: Date.now() });
    this.queuedBytes += buffer.length;

    while (this.queuedBytes > MAX_QUEUE_BYTES && this.audioQueue.length > 1) {
      const dropped = this.audioQueue.shift();
      this.queuedBytes -= dropped.buffer.length;
      this.droppedBytes += dropped.buffer.length;
    }

    if (this.droppedBytes > 0 && !this.queueOverflowReported) {
      this.queueOverflowReported = true;
      logger.warn('Doubao audio queue overflow, dropping oldest audio', {
        droppedSeconds: Math.round(this.droppedBytes / (16000 * 2) * 10) / 10
      });
    }
  }

  finish() {
    if (this.finishing) {
      return;
    }
    this.finishing = true;
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.close();
      return;
    }

    // 发送负包（最后一包），服务端会返回最终识别结果
    this._sendAudioFrame(Buffer.alloc(0), true);
    this.closeTimer = setTimeout(() => this.close(), 4000);
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ready = false;
    this.finishing = false;

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.removeAllListeners();
        socket.terminate();
      } catch (_) {
        // ignore
      }
      this._emitClosed();
    } else {
      this._emitClosed();
    }
  }

  _emitClosed() {
    if (this.closedEmitted) {
      return;
    }
    this.closedEmitted = true;
    this.emit('closed');
  }

  _sendFullClientRequest() {
    const payload = {
      user: {
        uid: 'opencluely',
        platform: process.platform
      },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: 16000,
        bits: 16,
        channel: 1
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        enable_ddc: true,
        enable_nonstream: !!this.options.enableNonstream,
        show_utterances: true,
        result_type: 'full',
        end_window_size: 800
      }
    };

    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const compressed = zlib.gzipSync(raw);
    const header = Buffer.from([
      (PROTOCOL_VERSION << 4) | HEADER_SIZE,
      (MSG_FULL_CLIENT << 4) | FLAG_NONE,
      (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP,
      0x00
    ]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(compressed.length, 0);

    this.ws.send(Buffer.concat([header, size, compressed]), (error) => {
      if (error) {
        this.emit('error', `豆包语音初始化请求发送失败: ${error.message}`);
        return;
      }
      const reconnected = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectAttempts = 0;
      this.ready = true;
      if (reconnected) {
        logger.info('Doubao WebSocket reconnected');
        this.emit('reconnected');
      }
      this.emit('ready');
      this._flushQueuedAudio();
    });
  }

  _flushQueuedAudio() {
    if (!this.ready || this.audioQueue.length === 0) {
      return;
    }
    const queued = this.audioQueue;
    this.audioQueue = [];
    this.queuedBytes = 0;

    const now = Date.now();
    let staleBytes = 0;
    queued.forEach((entry) => {
      if (now - entry.at > MAX_QUEUE_AGE_MS) {
        staleBytes += entry.buffer.length;
        return;
      }
      for (let offset = 0; offset < entry.buffer.length; offset += AUDIO_FRAME_BYTES) {
        this._sendAudioFrame(entry.buffer.slice(offset, offset + AUDIO_FRAME_BYTES), false);
      }
    });

    if (staleBytes > 0) {
      logger.warn('Dropped stale audio queued during reconnect', {
        staleSeconds: Math.round(staleBytes / (16000 * 2) * 10) / 10
      });
    }
    this.droppedBytes = 0;
    this.queueOverflowReported = false;
  }

  _sendAudioFrame(buffer, isLast) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!isLast && buffer.length > 0) {
        this._enqueueAudio(buffer);
      }
      return;
    }
    const header = Buffer.from([
      (PROTOCOL_VERSION << 4) | HEADER_SIZE,
      (MSG_AUDIO_ONLY << 4) | (isLast ? FLAG_LAST : FLAG_NONE),
      (0x00 << 4) | COMPRESSION_NONE,
      0x00
    ]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(buffer.length, 0);
    try {
      this.ws.send(Buffer.concat([header, size, buffer]));
    } catch (error) {
      logger.warn('Failed to send Doubao audio frame', { error: error.message });
      if (!isLast && buffer.length > 0) {
        this._enqueueAudio(buffer);
      }
    }
  }

  _handleMessage(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length < 4) {
      return;
    }

    const headerSize = (buffer[0] & 0x0f) * 4;
    const messageType = buffer[1] >> 4;
    const flags = buffer[1] & 0x0f;
    const compression = buffer[2] & 0x0f;

    let offset = headerSize;
    if (flags & 0x01) {
      offset += 4; // sequence
    }

    if (messageType === MSG_SERVER_ERROR) {
      if (buffer.length < offset + 8) {
        this.emit('error', '豆包语音返回了无法解析的错误响应');
        return;
      }
      const code = buffer.readUInt32BE(offset);
      offset += 4;
      const size = buffer.readUInt32BE(offset);
      offset += 4;
      let payload = buffer.slice(offset, offset + size);
      payload = this._decompress(payload, compression);
      this.emit('error', `豆包语音错误 ${code}: ${payload.toString('utf8').slice(0, 300)}`);
      return;
    }

    if (messageType !== MSG_FULL_SERVER) {
      return;
    }

    if (buffer.length < offset + 4) {
      return;
    }
    const size = buffer.readUInt32BE(offset);
    offset += 4;
    let payload = buffer.slice(offset, offset + size);
    payload = this._decompress(payload, compression);

    let json;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      logger.warn('Failed to parse Doubao response JSON', { error: error.message });
      return;
    }

    this._handleResult(json, !!(flags & FLAG_LAST));
  }

  _decompress(payload, compression) {
    if (compression !== COMPRESSION_GZIP) {
      return payload;
    }
    try {
      return zlib.gunzipSync(payload);
    } catch (error) {
      logger.warn('Failed to gunzip Doubao payload', { error: error.message });
      return payload;
    }
  }

  _handleResult(json, isLast) {
    const result = json && json.result ? json.result : {};
    const text = typeof result.text === 'string' ? result.text : '';
    const utterances = Array.isArray(result.utterances) ? result.utterances : [];

    if (text) {
      this.latestText = text;
      this.emit('interim', text);
    }

    // 除最后一句外，前面出现过的分句都视为已完成；最后一句在 definite
    // 或会话结束时收尾。开启二遍识别时 definite 由服务端给出。
    const lastUtterance = utterances[utterances.length - 1];
    const lastIsFinal = isLast || !!(lastUtterance && lastUtterance.definite === true);
    const boundary = lastIsFinal ? utterances.length : Math.max(0, utterances.length - 1);
    for (let i = this.finalizedCount; i < boundary; i += 1) {
      this._emitUtterance(utterances[i]);
    }
    if (boundary > this.finalizedCount) {
      this.finalizedCount = boundary;
    }

    if (isLast) {
      if (utterances.length === 0 && text) {
        this._emitFinal(text);
      }
      setTimeout(() => this.close(), 200);
    }
  }

  _emitUtterance(utterance) {
    if (!utterance) {
      return;
    }
    const text = String(utterance.text || '').trim();
    if (text) {
      this._emitFinal(text);
    }
  }

  _emitFinal(text) {
    const clean = String(text || '').trim();
    if (!clean) {
      return;
    }
    if (this.finalizedTexts[this.finalizedTexts.length - 1] === clean) {
      return;
    }
    this.finalizedTexts.push(clean);
    this.emit('final', clean);
  }
}

module.exports = DoubaoSpeechService;
