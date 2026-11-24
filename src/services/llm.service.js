const https = require('https');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const profileService = require('./profile.service');
const { promptLoader } = require('../../prompt-loader');

// 全局共享的 keep-alive 连接池：以前每次请求都新建 Agent，
// 等于每次都重新做一遍 DNS/TCP/TLS 握手。复用 socket 可以省掉这部分固定延迟。
const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  keepAliveMsecs: 30000
});

/**
 * LLM service backed by DeepSeek's OpenAI-compatible Chat Completions API.
 *
 * Public surface (method names + return shapes) is unchanged so the rest of
 * the app (main.js, overlay, chat window) does not need to know which
 * provider is behind it.
 *
 * Note: deepseek-flash accepts image input through the OpenAI-compatible
 * `image_url` content part, so screenshot analysis uses the same transport
 * as text, just with a multimodal user message.
 */
class LLMService {
  constructor() {
    this.model = null;
    this.baseUrl = null;
    this.apiKey = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;

    this.initializeClient();
  }

  initializeClient() {
    const apiKey = config.getApiKey('DEEPSEEK');
    this.apiKey = apiKey || null;

    if (!apiKey || apiKey === 'your_deepseek_api_key_here') {
      logger.warn('DeepSeek API key not configured', {
        keyExists: !!apiKey,
        isPlaceholder: apiKey === 'your_deepseek_api_key_here'
      });
      this.isInitialized = false;
      return;
    }

    this.model = process.env.DEEPSEEK_MODEL || config.get('llm.deepseek.model');
    this.baseUrl = String(
      process.env.DEEPSEEK_BASE_URL || config.get('llm.deepseek.baseUrl') || 'https://api.deepseek.com'
    ).replace(/\/+$/, '');
    this.isInitialized = true;

    logger.info('DeepSeek client initialized successfully', {
      model: this.model,
      baseUrl: this.baseUrl
    });
  }

  /** 质量优先 / 速度优先。速度优先关闭推理思考，显著降低首 token 延迟。 */
  getPriority() {
    const raw = String(
      process.env.LLM_PRIORITY || config.get('llm.deepseek.priority') || 'speed'
    ).trim().toLowerCase();
    return raw === 'quality' ? 'quality' : 'speed';
  }

  /** Translate the app's generation settings into Chat Completions fields. */
  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.deepseek.generation') || {};
    const merged = {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 4096,
      ...defaults,
      ...overrides
    };

    const body = {};
    if (merged.temperature !== undefined && merged.temperature !== null) body.temperature = merged.temperature;
    if (merged.topP !== undefined && merged.topP !== null) body.top_p = merged.topP;
    if (merged.maxOutputTokens !== undefined && merged.maxOutputTokens !== null) body.max_tokens = merged.maxOutputTokens;
    // Reasoning models emit hidden reasoning tokens that count against
    // max_tokens. For pure transcription that budget must go to the text, so
    // the caller can switch thinking off. 速度优先模式下，所有回答链路也默认关闭思考。
    if (merged.disableThinking || this.getPriority() === 'speed') {
      body.thinking = { type: 'disabled' };
    }
    return body;
  }

  // ── Image ────────────────────────────────────────────────────────

  async processImageWithSkill(imageBuffer, mimeType = 'image/png', activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }
    if (!imageBuffer || !imageBuffer.length) {
      throw new Error('No image data provided for analysis.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Processing screenshot with LLM', {
        activeSkill,
        mimeType,
        imageBytes: imageBuffer.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const chatRequest = this.buildImageChatRequest(
        imageBuffer,
        mimeType,
        activeSkill,
        sessionMemory,
        programmingLanguage
      );
      const response = await this.executeRequest(chatRequest);

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM image processing', startTime, {
        activeSkill,
        imageBytes: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isImageAnalysis: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM image processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });
      throw error;
    }
  }

  async processImageWithSkillStream(imageBuffer, mimeType = 'image/png', activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }
    if (!imageBuffer || !imageBuffer.length) {
      throw new Error('No image data provided for analysis.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      // Pass 1: transcribe the screenshot with a near-deterministic
      // temperature, so the model writes down exactly what it sees. This is
      // streamed so the user sees text immediately instead of waiting for the
      // whole transcription to finish.
      const transcriptionHeading = '【题目转写】\n';
      if (typeof onDelta === 'function') {
        onDelta(transcriptionHeading);
      }

      const transcription = await this.transcribeScreenshot(imageBuffer, mimeType, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      if (!transcription || !transcription.trim()) {
        throw new Error('Empty transcription from screenshot');
      }

      const answerHeading = '\n\n【解答】\n';
      if (typeof onDelta === 'function') {
        onDelta(answerHeading);
      }

      // Pass 2: answer strictly from the transcription, with no conversation
      // history so previous questions cannot leak into this one.
      const answerRequest = this.buildAnswerFromTranscriptionRequest(
        transcription.trim(),
        activeSkill,
        programmingLanguage
      );

      const answerText = await this.executeStreamingRequest(answerRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalAnswer = programmingLanguage
        ? this.enforceProgrammingLanguage(answerText, programmingLanguage)
        : answerText;
      const finalResponse = `${transcriptionHeading}${transcription}${answerHeading}${finalAnswer}`;

      logger.logPerformance('LLM image streaming', startTime, {
        activeSkill,
        imageBytes: imageBuffer.length,
        transcriptionLength: transcription.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true
        }
      };
    } catch (error) {
      // Do not fall back to a second, full non-streaming request here: that
      // doubles the wait for a result that is likely to fail the same way.
      // Let the caller surface the error instead.
      logger.warn('Image analysis failed', {
        error: error.message,
        requestId: this.requestCount
      });
      throw error;
    }
  }

  /**
   * Pass 1 of screenshot analysis: verbatim transcription only, streamed.
   * Uses a low temperature because this step must copy, not interpret, and a
   * tight output cap so it finishes as soon as the question is written down.
   */
  async transcribeScreenshot(imageBuffer, mimeType = 'image/png', onDelta = null) {
    const dataUrl = `data:${mimeType || 'image/png'};base64,${imageBuffer.toString('base64')}`;
    const instruction = `Transcription only — do NOT solve or explain anything.

Read the screenshot and transcribe the question text exactly as it appears, character by character, including all numbers, variable names, constraints, sample input/output, multiple-choice options (A/B/C/D) and code.

Rules:
- Do not paraphrase, correct, translate, summarize or infer.
- Do not add headings, comments or answers.
- If a part is blurry or cut off, write [无法看清] for that part instead of guessing.
- Output only the transcribed text.`;

    return this.executeStreamingRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      generation: { temperature: 0.15, maxOutputTokens: 1200, disableThinking: true }
    }, (delta) => {
      if (typeof onDelta === 'function' && delta) {
        onDelta(delta);
      }
    });
  }

  /**
   * Pass 2 of screenshot analysis: answer from the transcription only.
   * Conversation history is deliberately excluded so each question is
   * answered independently.
   */
  buildAnswerFromTranscriptionRequest(transcription, activeSkill, programmingLanguage = null) {
    const sessionManager = require('../managers/session.manager');
    const messages = [];

    const skillContext = sessionManager && typeof sessionManager.getSkillContext === 'function'
      ? sessionManager.getSkillContext(activeSkill, programmingLanguage)
      : null;
    if (skillContext && skillContext.skillPrompt) {
      messages.push({ role: 'system', content: skillContext.skillPrompt });
    }

    messages.push({
      role: 'user',
      content: `The following is a verbatim transcription of a screenshot taken during a live interview:

"""
${transcription}
"""

Answer the question in the transcription. If it is a coding or DSA problem, provide a complete, runnable solution in a properly tagged code block. If it is a multiple-choice question, state the correct option letter first, then a brief justification. Base every detail strictly on the transcription above and never invent constraints, numbers or options that are not written there. Be concise and directly useful in a live interview.`
    });

    return { messages, generation: { temperature: 0.5 } };
  }

  // ── Text ─────────────────────────────────────────────────────────

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const chatRequest = this.buildChatRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const response = await this.executeRequest(chatRequest);

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.deepseek.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const chatRequest = this.buildChatRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const streamMetrics = {};

      const fullText = await this.executeStreamingRequest(chatRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      }, streamMetrics);

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM text streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        firstTokenMs: streamMetrics.firstTokenMs,
        promptChars: streamMetrics.promptChars,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          firstTokenMs: streamMetrics.firstTokenMs ?? null,
          promptChars: streamMetrics.promptChars ?? null
        }
      };
    } catch (error) {
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const chatRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const response = await this.executeRequest(chatRequest);

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.deepseek.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check DeepSeek API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const chatRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const streamMetrics = {};

      const fullText = await this.executeStreamingRequest(chatRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      }, streamMetrics);

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM transcription streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        firstTokenMs: streamMetrics.firstTokenMs,
        promptChars: streamMetrics.promptChars,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true,
          firstTokenMs: streamMetrics.firstTokenMs ?? null,
          promptChars: streamMetrics.promptChars ?? null
        }
      };
    } catch (error) {
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  /**
   * Normalize all triple-backtick code fences to the selected programming language tag.
   * Does not alter the inner code; only ensures fence language tags are correct.
   */
  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript', go: 'go', dart: 'dart' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      // Replace all triple-backtick fences' language token with the selected tag
      const replacedBackticks = text.replace(/```([^\n]*)\n/g, (match, info) => {
        const current = (info || '').trim();
        // If already the desired fenceTag as the first token, keep as is
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return match;
        return '```' + fenceTag + '\n';
      });

      // Optionally normalize tildes fences to backticks with correct tag
      const normalizedTildes = replacedBackticks.replace(/~~~([^\n]*)\n/g, () => '```' + fenceTag + '\n');

      return normalizedTildes;
    } catch (_) {
      return text;
    }
  }

  /**
   * 调用方在请求前已经把当前输入写入 session memory，随后又会把它作为
   * 新消息追加一次。这里把历史里最后一条相同的 user 输入去掉，避免同一句话
   * 在 prompt 里出现两遍（既浪费 token，也拉高首 token 延迟）。
   */
  _dropPendingUserEcho(events, text) {
    const needle = String(text || '').trim();
    if (!needle) return events;

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.role === 'user' && typeof event.content === 'string' && event.content.trim() === needle) {
        return events.slice(0, i).concat(events.slice(i + 1));
      }
    }
    return events;
  }

  /**
   * 历史上下文预算：最近几轮完整保留，更早的内容按字符预算截断，
   * 过长 assistant 回答只保留开头部分，防止旧答案挤占每次请求。
   */
  _applyHistoryBudget(events, budget = null, keepRecent = 4, assistantCap = 1500) {
    if (!Array.isArray(events) || events.length === 0) return [];

    const maxChars = budget || Number(process.env.CHAT_HISTORY_CHAR_BUDGET) || 6000;
    const keepCount = Math.min(keepRecent, events.length);
    const boundary = events.length - keepCount;
    const recent = events.slice(boundary);
    const older = events.slice(0, boundary);

    const keptOlder = [];
    let used = 0;

    for (let i = older.length - 1; i >= 0; i--) {
      const event = older[i];
      if (event.role === 'system') continue;
      if (!event.content || typeof event.content !== 'string') continue;

      let content = event.content.trim();
      if (!content) continue;

      if (event.role === 'model' && content.length > assistantCap) {
        content = content.slice(0, assistantCap) + '…';
      }
      if (used + content.length > maxChars) break;

      used += content.length;
      keptOlder.unshift({ ...event, content });
    }

    return keptOlder.concat(recent);
  }

  buildChatRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    const sessionManager = require('../managers/session.manager');
    const messages = [];

    let conversationHistory = [];
    let systemPrompt = '';

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      conversationHistory = sessionManager.getConversationHistory(15);
      conversationHistory = this._dropPendingUserEcho(conversationHistory, text);
      conversationHistory = this._applyHistoryBudget(conversationHistory);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      systemPrompt = skillContext.skillPrompt || '';
    } else {
      const requestComponents = promptLoader.getRequestComponents(
        activeSkill,
        text,
        sessionMemory,
        programmingLanguage
      );
      if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
        systemPrompt = requestComponents.skillPrompt;
      }
    }

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    const hasProfileContext = this._appendProfileContext(messages);

    for (const event of conversationHistory) {
      if (event.role === 'system') continue;
      if (!event.content || typeof event.content !== 'string') continue;
      const content = event.content.trim();
      if (!content) continue;
      messages.push({
        role: event.role === 'model' ? 'assistant' : 'user',
        content
      });
    }

    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || !formattedMessage.trim()) {
      throw new Error('Failed to format user message or message is empty');
    }
    messages.push({ role: 'user', content: formattedMessage });

    logger.debug('Built DeepSeek chat request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalMessages: messages.length,
      hasSystemMessage: !!systemPrompt,
      hasProfileContext,
      hasLanguageInjection: !!programmingLanguage
    });

    return { messages };
  }

  buildImageChatRequest(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage) {
    const sessionManager = require('../managers/session.manager');
    const messages = [];

    let conversationHistory = [];
    let systemPrompt = '';

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      systemPrompt = skillContext.skillPrompt || '';
    }

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const event of conversationHistory) {
      if (event.role === 'system') continue;
      if (!event.content || typeof event.content !== 'string') continue;
      const content = event.content.trim();
      if (!content) continue;
      messages.push({
        role: event.role === 'model' ? 'assistant' : 'user',
        content
      });
    }

    const dataUrl = `data:${mimeType || 'image/png'};base64,${imageBuffer.toString('base64')}`;
    const instruction = `Context: ${activeSkill.toUpperCase()} analysis request

Step 1 — TRANSCRIBE FIRST (mandatory): Before answering, read the screenshot and transcribe the question text exactly as it appears. Output it under the heading "【题目转写】". Copy the wording character by character, including all numbers, variable names, constraints, sample input/output, options (A/B/C/D) and code. Do not paraphrase, correct, translate or infer anything at this step. If some text is blurry or cut off, write "[无法看清]" for that part instead of guessing.
Step 2 — ANSWER: Only after the transcription, provide the answer under the heading "【解答】".

Answering rules: if it is a coding or DSA problem, provide a complete, runnable solution in a properly tagged code block. If it is a multiple-choice question, state the correct option letter first, then a brief justification. Base every answer detail strictly on the transcription from Step 1, never on the conversation history. Be concise and directly useful in a live interview.`;

    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    });

    logger.debug('Built DeepSeek vision request', {
      skill: activeSkill,
      mimeType,
      imageBytes: imageBuffer.length,
      historyLength: conversationHistory.length,
      totalMessages: messages.length
    });

    return { messages };
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    const sessionManager = require('../managers/session.manager');
    const messages = [
      { role: 'system', content: this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) }
    ];

    const hasProfileContext = this._appendProfileContext(messages);

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      let conversationHistory = sessionManager.getConversationHistory(10);
      conversationHistory = this._dropPendingUserEcho(conversationHistory, cleanText);
      conversationHistory = this._applyHistoryBudget(conversationHistory);
      for (const event of conversationHistory) {
        if (event.role === 'system') continue;
        if (!event.content || typeof event.content !== 'string') continue;
        const content = event.content.trim();
        if (!content) continue;
        messages.push({
          role: event.role === 'model' ? 'assistant' : 'user',
          content
        });
      }
    }

    messages.push({ role: 'user', content: cleanText });

    if (messages.length < 2) {
      throw new Error('No valid content to send to DeepSeek API');
    }

    logger.debug('Built intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      totalMessages: messages.length,
      hasProfileContext,
      cleanTextLength: cleanText.length
    });

    return { messages };
  }

  /**
   * 把岗位 / JD / 简历作为独立的 system 消息加入请求。
   * 未配置或用户关闭开关时不产生任何内容。
   */
  _appendProfileContext(messages) {
    try {
      const block = profileService.getContextBlock();
      if (!block) return false;
      messages.push({ role: 'system', content: block });
      return true;
    } catch (error) {
      logger.warn('Failed to build profile context', { error: error.message });
      return false;
    }
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Intelligent Transcription Response System

Assume you are asked a question in ${activeSkill.toUpperCase()} mode. Your job is to intelligently respond to question/message with appropriate brevity.
Assume you are in an interview and you need to perform best in ${activeSkill.toUpperCase()} mode.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.
Always respond in Simplified Chinese (简体中文) for all explanations, reasoning, steps, acknowledgments and notes, even if the transcription is in English. Keep code identifiers, keywords and library names in the selected programming language; do not translate code into Chinese.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      const lang = String(programmingLanguage).toLowerCase();
      const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript', go: 'Go', dart: 'Dart' };
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript', go: 'go', dart: 'dart' };
      const languageTitle = languageMap[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      const fenceTag = fenceTagMap[lang] || lang || 'text';
      prompt += `\n\nCODING CONTEXT: All prose (explanations, reasoning, complexity notes) must be written in Simplified Chinese (简体中文). All code must be written ONLY in ${languageTitle}, in triple-backtick blocks tagged \`\`\`${fenceTag}\`\`\`. Do not include other languages unless explicitly asked.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Reply naturally and briefly in Simplified Chinese, like a normal conversation (1-2 sentences).
- Do not use fixed phrases such as "好的，我在听，请提出与 ${activeSkill} 相关的问题。" or "我在，你的 ${activeSkill} 问题是什么？"
- Do not force the conversation back to ${activeSkill}.

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a comprehensive, detailed response
- Use bullet points, examples, and explanations
- Focus on actionable insights and complete answers
- Do not truncate or shorten your response

### Examples of casual/irrelevant messages:
- "Hello", "Hi there", "How are you?"
- "What's the weather like?"
- "I'm just testing this"
- Random conversations not related to ${activeSkill}

### Examples of relevant messages:
- Actual questions about ${activeSkill} concepts
- Follow-up questions to previous responses
- Requests for clarification on ${activeSkill} topics
- Problem-solving requests related to ${activeSkill}

## Response Format:
- Keep responses detailed
- Use bullet points for structured answers
- Be encouraging and helpful
- Stay focused on ${activeSkill}

If the user's input is a coding or DSA problem statement and contains no code, produce a complete, runnable solution in the selected programming language without asking for more details. Always include the final implementation in a properly tagged code block.

Remember: Be intelligent about filtering - only provide detailed responses when the user actually needs help with ${activeSkill}.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  // ── Transport ────────────────────────────────────────────────────

  _modelsToTry() {
    const primary = this.model || config.get('llm.deepseek.model');
    const fallbacks = config.get('llm.deepseek.fallbackModels') || [];
    return [primary, ...fallbacks].filter(Boolean);
  }

  _shouldSwitchModel(errorInfo, error) {
    const message = (error && error.message ? error.message : '').toLowerCase();
    return errorInfo.type === 'RATE_LIMIT_ERROR' ||
      errorInfo.type === 'MODEL_ERROR' ||
      message.includes('503') ||
      message.includes('unavailable') ||
      message.includes('high demand');
  }

  _makeHttpError(statusCode, body) {
    const err = new Error(`HTTP ${statusCode}: ${String(body || '').slice(0, 500)}`);
    err.statusCode = statusCode;
    return err;
  }

  async executeRequest(chatRequest) {
    const maxRetries = config.get('llm.deepseek.maxRetries') || 3;
    const timeout = config.get('llm.deepseek.timeout') || 60000;
    const modelsToTry = this._modelsToTry();

    logger.debug('Executing DeepSeek request', {
      model: this.model,
      baseUrl: this.baseUrl,
      timeout,
      maxRetries,
      modelsToTry,
      messageCount: chatRequest.messages?.length,
      platform: process.platform
    });

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const text = await this._postChatCompletion(modelName, chatRequest, timeout);

          logger.debug('DeepSeek API request successful', {
            attempt,
            model: modelName,
            responseLength: text.length
          });

          return text;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          logger.warn(`DeepSeek API attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            isNetworkError: errorInfo.isNetworkError,
            suggestedAction: errorInfo.suggestedAction,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          if (this._shouldSwitchModel(errorInfo, error) && modelName !== modelsToTry[modelsToTry.length - 1]) {
            logger.info(`Switching to fallback model after ${modelName} unavailable`, {
              model: modelName,
              error: error.message
            });
            break;
          }

          if (attempt === maxRetries) {
            break;
          }

          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;
          await this.delay(delay);
        }
      }
    }

    const finalErrorInfo = this.analyzeError(lastError);
    const finalError = new Error(`DeepSeek API failed after trying ${modelsToTry.join(', ')}: ${lastError?.message}`);
    finalError.errorAnalysis = finalErrorInfo;
    finalError.originalError = lastError;
    throw finalError;
  }

  async executeStreamingRequest(chatRequest, onDelta, metrics = null) {
    const maxRetries = config.get('llm.deepseek.maxRetries') || 3;
    const timeout = config.get('llm.deepseek.timeout') || 60000;
    const modelsToTry = this._modelsToTry();

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fullText = await this._streamChatCompletion(modelName, chatRequest, timeout, onDelta, metrics);

          if (!fullText) {
            throw new Error('Empty streamed response from DeepSeek API');
          }

          if (metrics && typeof metrics === 'object') {
            metrics.attempts = attempt;
            metrics.usedFallbackModel = modelName !== modelsToTry[0];
          }

          logger.debug('DeepSeek streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });

          return fullText;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          logger.warn(`DeepSeek streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          if (this._shouldSwitchModel(errorInfo, error) && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break;
          }

          if (attempt === maxRetries) {
            break;
          }

          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;
          await this.delay(delay);
        }
      }
    }

    throw lastError || new Error('DeepSeek streaming request failed');
  }

  _buildChatBody(modelName, chatRequest, stream) {
    return {
      model: modelName,
      messages: chatRequest.messages,
      stream,
      ...this.getGenerationConfig(chatRequest.generation || {})
    };
  }

  _requestOptions(body) {
    const postData = JSON.stringify(body);
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      postData
    };
  }

  _postChatCompletion(modelName, chatRequest, timeout) {
    const body = this._buildChatBody(modelName, chatRequest, false);
    const { headers, postData } = this._requestOptions(body);
    const url = `${this.baseUrl}/chat/completions`;
    const agent = sharedHttpsAgent;
    const requestStart = Date.now();
    const promptChars = this._promptCharCount(chatRequest);

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers, timeout, agent }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(this._makeHttpError(res.statusCode, data));
            return;
          }
          try {
            const json = JSON.parse(data);
            const text = json?.choices?.[0]?.message?.content;
            const finishReason = json?.choices?.[0]?.finish_reason;

            if (finishReason === 'length') {
              logger.warn('DeepSeek response reached max tokens limit', {
                model: modelName,
                finishReason
              });
            }

            if (typeof text !== 'string' || !text.trim()) {
              reject(new Error(`Empty response from DeepSeek API (${finishReason || 'no finish reason'})`));
              return;
            }

            logger.info('LLM completion timing', {
              model: modelName,
              promptChars,
              totalMs: Date.now() - requestStart,
              responseLength: text.length,
              requestId: this.requestCount
            });

            resolve(text.trim());
          } catch (parseError) {
            logger.error('Failed to parse DeepSeek response', {
              error: parseError.message,
              rawResponse: data.substring(0, 500),
              statusCode: res.statusCode
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => reject(new Error(`DeepSeek request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('DeepSeek request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  _streamChatCompletion(modelName, chatRequest, timeout, onDelta, metrics = null) {
    const body = this._buildChatBody(modelName, chatRequest, true);
    const { headers, postData } = this._requestOptions(body);
    const url = `${this.baseUrl}/chat/completions`;
    const agent = sharedHttpsAgent;
    const requestStart = Date.now();
    const promptChars = this._promptCharCount(chatRequest);

    logger.debug('LLM stream request start', {
      model: modelName,
      promptChars,
      requestId: this.requestCount
    });

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers, timeout, agent }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(this._makeHttpError(res.statusCode, errBody)));
          return;
        }

        let fullText = '';
        let buffer = '';
        let firstTokenAt = 0;
        let deltaCount = 0;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) continue;

            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                if (!firstTokenAt) firstTokenAt = Date.now();
                deltaCount++;
                fullText += delta;
                if (typeof onDelta === 'function') onDelta(delta);
              }
            } catch (_) {
              // Partial JSON across chunk boundaries is rare with line
              // framing; skip anything that does not parse cleanly.
            }
          }
        });

        res.on('end', () => {
          const totalMs = Date.now() - requestStart;
          const firstTokenMs = firstTokenAt ? firstTokenAt - requestStart : null;

          if (metrics && typeof metrics === 'object') {
            Object.assign(metrics, {
              model: modelName,
              promptChars,
              firstTokenMs,
              totalMs,
              deltaCount
            });
          }

          logger.info('LLM stream timing', {
            model: modelName,
            promptChars,
            firstTokenMs,
            totalMs,
            deltaCount,
            responseLength: fullText.length,
            requestId: this.requestCount
          });

          resolve(fullText.trim());
        });
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /** 估算 prompt 字符数，用于埋点对比上下文体积与首 token 延迟。 */
  _promptCharCount(chatRequest) {
    try {
      let total = 0;
      for (const message of chatRequest?.messages || []) {
        if (typeof message.content === 'string') {
          total += message.content.length;
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part && typeof part.text === 'string') {
              total += part.text.length;
            } else if (part && part.image_url && typeof part.image_url.url === 'string') {
              // Base64 图片只记录粗略长度，避免日志里出现超长字符串
              total += Math.min(part.image_url.url.length, 200000);
            }
          }
        }
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  /**
   * 预热共享连接：app 启动后先做一次轻量 GET /models，
   * 让后续第一次真实问答直接复用已建立的 TLS 连接。
   */
  warmUpConnection() {
    if (!this.isInitialized || !this.baseUrl || !this.apiKey) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      try {
        const req = https.request(`${this.baseUrl}/models`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': this.getUserAgent()
          },
          timeout: 8000,
          agent: sharedHttpsAgent
        }, (res) => {
          res.resume();
          logger.info('LLM warm-up completed', {
            statusCode: res.statusCode,
            elapsedMs: Date.now() - startedAt
          });
          resolve(res.statusCode === 200);
        });

        req.on('error', (error) => {
          logger.debug('LLM warm-up failed (non-fatal)', { error: error.message });
          resolve(false);
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      } catch (error) {
        logger.debug('LLM warm-up failed (non-fatal)', { error: error.message });
        resolve(false);
      }
    });
  }

  async performPreflightCheck() {
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({
        host: 'api.deepseek.com',
        port: 443,
        name: 'DeepSeek API Endpoint'
      });
      const latency = Date.now() - startTime;

      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', {
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = (error.message || '').toLowerCase();
    const statusCode = error.statusCode;

    // Network connectivity errors
    if (errorMessage.includes('fetch failed') ||
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('econnreset') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }

    // Authentication errors
    if (statusCode === 401 || statusCode === 403 ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('authentication') ||
        errorMessage.includes('forbidden')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        suggestedAction: 'Verify DeepSeek API key configuration'
      };
    }

    // Insufficient account balance
    if (statusCode === 402 ||
        errorMessage.includes('insufficient balance') ||
        errorMessage.includes('insufficient_quota') ||
        errorMessage.includes('payment required')) {
      return {
        type: 'BALANCE_ERROR',
        isNetworkError: false,
        suggestedAction: 'Top up your DeepSeek account balance'
      };
    }

    // Rate limiting
    if (statusCode === 429 ||
        errorMessage.includes('quota') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests')) {
      return {
        type: 'RATE_LIMIT_ERROR',
        isNetworkError: false,
        suggestedAction: 'Wait before retrying or check API quota'
      };
    }

    // Unknown model id
    if (statusCode === 404 ||
        (statusCode === 400 && errorMessage.includes('model')) ||
        errorMessage.includes('model not found') ||
        errorMessage.includes('does not exist')) {
      return {
        type: 'MODEL_ERROR',
        isNetworkError: false,
        suggestedAction: 'Check the configured DeepSeek model name'
      };
    }

    // Timeout errors
    if (errorMessage.includes('request timeout') || errorMessage.includes('etimedout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }

    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: 'api.deepseek.com', port: 443, name: 'DeepSeek API Endpoint' },
      { host: 'deepseek.com', port: 443, name: 'DeepSeek (HTTPS)' }
    ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  generateFallbackResponse(text, activeSkill) {
    logger.info('Generating fallback response', { activeSkill });

    const fallbackResponses = {
      'dsa': 'This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.',
      'system-design': 'For this system design question, consider scalability, reliability, and the trade-offs between different architectural approaches.',
      'programming': 'This looks like a programming challenge. Focus on understanding the requirements, edge cases, and optimal time/space complexity.',
      'default': 'I can help analyze this content. Please ensure your DeepSeek API key is properly configured for detailed analysis.'
    };

    const response = fallbackResponses[activeSkill] || fallbackResponses.default;

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info('Generating intelligent fallback response for transcription', { activeSkill });

    // Simple heuristic to determine if message seems skill-related
    const skillKeywords = {
      'dsa': ['algorithm', 'data structure', 'array', 'tree', 'graph', 'sort', 'search', 'complexity', 'big o'],
      'programming': ['code', 'function', 'variable', 'class', 'method', 'bug', 'debug', 'syntax'],
      'system-design': ['scalability', 'database', 'architecture', 'microservice', 'load balancer', 'cache'],
      'behavioral': ['interview', 'experience', 'situation', 'leadership', 'conflict', 'team'],
      'sales': ['customer', 'deal', 'negotiation', 'price', 'revenue', 'prospect'],
      'presentation': ['slide', 'audience', 'public speaking', 'presentation', 'nervous'],
      'data-science': ['data', 'model', 'machine learning', 'statistics', 'analytics', 'python', 'pandas'],
      'devops': ['deployment', 'ci/cd', 'docker', 'kubernetes', 'infrastructure', 'monitoring'],
      'negotiation': ['negotiate', 'compromise', 'agreement', 'terms', 'conflict resolution']
    };

    const textLower = text.toLowerCase();
    const relevantKeywords = skillKeywords[activeSkill] || [];
    const hasRelevantKeywords = relevantKeywords.some(keyword => textLower.includes(keyword));

    // Check for question indicators
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    let response;
    if (hasRelevantKeywords || seemsLikeQuestion) {
      response = `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically about what you need help with?`;
    } else {
      response = `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;
    }

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);

      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const modelsToTry = this._modelsToTry();
      const timeout = config.get('llm.deepseek.timeout') || 60000;

      let lastError = null;

      for (const modelName of modelsToTry) {
        try {
          const startTime = Date.now();
          const text = await this._postChatCompletion(modelName, {
            messages: [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
            generation: { temperature: 0, maxOutputTokens: 64 }
          }, timeout);
          const latency = Date.now() - startTime;

          logger.info('Connection test successful', {
            response: text,
            latency,
            model: modelName,
            networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
          });

          return {
            success: true,
            response: text,
            latency,
            model: modelName,
            networkConnectivity: networkCheck
          };
        } catch (error) {
          lastError = error;
          logger.warn(`Connection test failed for model ${modelName}`, {
            error: error.message,
            model: modelName
          });

          const errorInfo = this.analyzeError(error);
          if (!this._shouldSwitchModel(errorInfo, error) && modelName === modelsToTry[0]) {
            // Primary model failed for a non-availability reason; don't hide it
            break;
          }
        }
      }

      throw lastError || new Error('Connection test failed on all models');
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        error: error.message,
        errorAnalysis
      });

      return {
        success: false,
        error: this._friendlyTestError(error, errorAnalysis),
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  /**
   * Translate raw transport / network errors into something a user can act on.
   */
  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
      return 'Cannot reach DeepSeek servers. Check your internet connection, firewall, or VPN settings.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
      return 'Invalid API key or insufficient permissions. Double-check your key at platform.deepseek.com/api_keys.';
    }
    if (type === 'BALANCE_ERROR' || raw.includes('insufficient balance') || raw.includes('402')) {
      return 'Your DeepSeek account has insufficient balance. Top up at platform.deepseek.com and try again.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Rate limit or quota exceeded. Wait a moment and try again.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Request timed out. The DeepSeek API may be slow or unreachable right now.';
    }
    if (type === 'MODEL_ERROR' || raw.includes('model') || raw.includes('404')) {
      return 'The configured DeepSeek model is unavailable. Check DEEPSEEK_MODEL in your .env file.';
    }
    if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
      return 'DeepSeek is experiencing high demand. Please wait a moment and try again.';
    }
    // Fall back to a stripped-down raw message (no prefix noise)
    return (error?.message || 'Connection failed').replace(/^DeepSeek request failed:\s*/i, '');
  }

  updateApiKey(newApiKey) {
    process.env.DEEPSEEK_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();

    // 新 key 生效后立刻预热连接，避免下一次提问多付一次握手成本。
    if (this.isInitialized) {
      this.warmUpConnection().catch(() => {});
    }

    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      hasApiKey: !!this.apiKey,
      model: this.model,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      config: config.get('llm.deepseek')
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new LLMService();
