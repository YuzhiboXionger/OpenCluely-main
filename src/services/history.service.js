const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('HISTORY');

// 笔试/面试历史记录：场次（session）+ 单条问答（record）。
// 存储为 userData/history.json，写入方式与 profile.service.js 一致：
// 先写临时文件再 rename，避免中途崩溃留下损坏的 JSON。
//
// 注意：main.js 会在应用启动后把 app 名改成 "Terminal "。本模块必须在
// require 阶段解析路径（与 profile.service 的时机一致），否则 userData
// 会指向另一个目录，历史记录看起来就像“丢了”。

const SESSION_IDLE_SPLIT_MS = 30 * 60 * 1000; // 30 分钟无新记录自动切场
const MAX_RECORDS = 2000;
const RETENTION_DAYS = 180;
const MAX_QUESTION_CHARS = 20000;
const MAX_ANSWER_CHARS = 60000;
const MAX_NOTE_CHARS = 2000;
const MAX_TAGS = 10;

const RECORD_TYPES = new Set(['chat', 'screenshot', 'speech']);
const SESSION_TYPES = new Set(['written_test', 'interview', 'mixed']);

function resolveHistoryPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'history.json');
    }
  } catch (_) {
    // 非 Electron 环境（例如脚本调试）走下面的兜底路径
  }
  return path.join(os.homedir(), '.OpenCluely', 'history.json');
}

function emptyData() {
  return {
    version: 1,
    activeSessionId: null,
    sessions: [],
    records: []
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function makeId(prefix) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncate(value, max) {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function typeLabelForSession(type) {
  switch (type) {
    case 'written_test': return '笔试';
    case 'interview': return '面试';
    case 'mixed': return '混合';
    default: return '场次';
  }
}

function derivedSessionType(skill) {
  return skill === 'interview' ? 'interview' : 'written_test';
}

function defaultSessionTitle(type) {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日 ${typeLabelForSession(type)}`;
}

function extractCode(answer) {
  const matches = [...String(answer || '').matchAll(/```[^\n`]*\n([\s\S]*?)```/g)];
  if (!matches.length) return '';
  return matches
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20000);
}

function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

class HistoryService {
  constructor() {
    this.filePath = resolveHistoryPath();
    this.data = null;
    this._loaded = false;
    this._dirty = false;
    this._writing = false;
    this._version = 0;
    this._writeTimer = null;
  }

  init() {
    if (this._loaded) return this.getStats();
    this._load();
    this._expireStaleActiveSession();
    this._trim();
    return this.getStats();
  }

  _ensureLoaded() {
    if (!this._loaded) this.init();
    return this.data;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = this._normalizeData(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Failed to read history.json, starting with an empty history', {
          error: error.message,
          file: this.filePath
        });
      }
      this.data = emptyData();
    }
    this._loaded = true;
  }

  _normalizeData(input) {
    const data = emptyData();
    if (!input || typeof input !== 'object') return data;

    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    const seen = new Set();
    for (const raw of sessions) {
      const session = this._normalizeSession(raw);
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      data.sessions.push(session);
    }

    const records = Array.isArray(input.records) ? input.records : [];
    for (const raw of records) {
      const record = this._normalizeRecord(raw);
      if (!record) continue;
      // 归属场次丢失时补一个“未归属”场次，避免记录在 UI 中彻底消失。
      if (!seen.has(record.sessionId)) {
        const recoveredId = record.sessionId || `s_recovered`;
        if (!seen.has(recoveredId)) {
          seen.add(recoveredId);
          data.sessions.push({
            id: recoveredId,
            title: '未归属记录',
            type: 'mixed',
            typeSource: 'auto',
            company: '',
            position: '',
            startedAt: record.createdAt,
            endedAt: null,
            lastActivityAt: record.createdAt,
            status: 'active'
          });
        }
        record.sessionId = recoveredId;
      }
      data.records.push(record);
    }

    const activeId = typeof input.activeSessionId === 'string' ? input.activeSessionId : null;
    data.activeSessionId = activeId && seen.has(activeId) ? activeId : null;
    if (data.activeSessionId) {
      const active = data.sessions.find((session) => session.id === data.activeSessionId);
      if (!active || active.status !== 'active') data.activeSessionId = null;
    }

    return data;
  }

  _normalizeSession(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    const type = SESSION_TYPES.has(raw.type) ? raw.type : 'written_test';
    const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString();
    return {
      id: String(raw.id),
      title: cleanText(raw.title).slice(0, 80) || defaultSessionTitle(type),
      type,
      typeSource: raw.typeSource === 'manual' ? 'manual' : 'auto',
      company: cleanText(raw.company).slice(0, 100),
      position: cleanText(raw.position).slice(0, 100),
      startedAt,
      endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
      lastActivityAt: typeof raw.lastActivityAt === 'string' ? raw.lastActivityAt : startedAt,
      status: raw.status === 'ended' ? 'ended' : 'active'
    };
  }

  _normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    const question = cleanText(raw.question).slice(0, MAX_QUESTION_CHARS);
    const answer = cleanText(raw.answer).slice(0, MAX_ANSWER_CHARS);
    if (!question && !answer) return null;
    return {
      id: String(raw.id),
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      type: RECORD_TYPES.has(raw.type) ? raw.type : 'chat',
      skill: typeof raw.skill === 'string' ? raw.skill : null,
      language: typeof raw.language === 'string' ? raw.language : null,
      question,
      answer,
      code: cleanText(raw.code).slice(0, 20000),
      starred: raw.starred === true,
      tags: Array.isArray(raw.tags)
        ? raw.tags.map((tag) => cleanText(tag).slice(0, 30)).filter(Boolean).slice(0, MAX_TAGS)
        : [],
      note: cleanText(raw.note).slice(0, MAX_NOTE_CHARS),
      meta: raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : {}
    };
  }

  _expireStaleActiveSession() {
    const session = this._getActiveSession();
    if (!session) return;
    const last = toTime(session.lastActivityAt || session.startedAt);
    if (Date.now() - last > SESSION_IDLE_SPLIT_MS) {
      this._endSessionInternal(session, session.lastActivityAt || session.startedAt);
      this._scheduleWrite();
    }
  }

  _getActiveSession() {
    const id = this.data.activeSessionId;
    if (!id) return null;
    return this.data.sessions.find((session) => session.id === id && session.status === 'active') || null;
  }

  _endSessionInternal(session, endedAt) {
    if (!session) return;
    session.status = 'ended';
    session.endedAt = endedAt || new Date().toISOString();
    if (this.data.activeSessionId === session.id) {
      this.data.activeSessionId = null;
    }
  }

  _ensureActiveSessionForRecord(derivedType) {
    const now = new Date().toISOString();
    let active = this._getActiveSession();

    if (active) {
      const last = toTime(active.lastActivityAt || active.startedAt);
      if (Date.now() - last > SESSION_IDLE_SPLIT_MS) {
        this._endSessionInternal(active, active.lastActivityAt || active.startedAt);
        active = null;
      }
    }

    if (!active) {
      this.createSession({ type: derivedType, typeSource: 'auto' });
      // createSession 返回的是给 IPC 的副本，这里要拿到内存中的真实对象，
      // 否则后面写入的 lastActivityAt 不会落到 history.json。
      return this._getActiveSession();
    }

    // 同一场次里同时出现笔试与面试时标记为混合；手动设置的类型不覆盖。
    if (active.typeSource !== 'manual' && active.type !== derivedType && active.type !== 'mixed') {
      active.type = 'mixed';
    }
    active.lastActivityAt = now;
    return active;
  }

  createSession({ type = 'written_test', title = '', company = '', position = '', typeSource = 'manual' } = {}) {
    this._ensureLoaded();
    const now = new Date();
    const normalizedType = SESSION_TYPES.has(type) ? type : 'written_test';

    const active = this._getActiveSession();
    if (active) this._endSessionInternal(active, now.toISOString());

    const session = {
      id: makeId('s'),
      title: cleanText(title).slice(0, 80) || defaultSessionTitle(normalizedType),
      type: normalizedType,
      typeSource: typeSource === 'auto' ? 'auto' : 'manual',
      company: cleanText(company).slice(0, 100),
      position: cleanText(position).slice(0, 100),
      startedAt: now.toISOString(),
      endedAt: null,
      lastActivityAt: now.toISOString(),
      status: 'active'
    };

    this.data.sessions.push(session);
    this.data.activeSessionId = session.id;
    this._scheduleWrite();
    logger.info('History session created', {
      sessionId: session.id,
      type: session.type,
      title: session.title
    });
    return clone(session);
  }

  getActiveSession() {
    this._ensureLoaded();
    const session = this._getActiveSession();
    return session ? clone(session) : null;
  }

  endSession(id) {
    this._ensureLoaded();
    const session = this.data.sessions.find((item) => item.id === id);
    if (!session) return null;
    this._endSessionInternal(session, new Date().toISOString());
    this._scheduleWrite();
    return clone(session);
  }

  updateSession(id, patch = {}) {
    this._ensureLoaded();
    const session = this.data.sessions.find((item) => item.id === id);
    if (!session) return null;
    let changed = false;

    if (patch.title !== undefined) {
      const title = cleanText(patch.title).slice(0, 80);
      if (title) {
        session.title = title;
        changed = true;
      }
    }
    if (patch.type !== undefined && SESSION_TYPES.has(patch.type)) {
      session.type = patch.type;
      session.typeSource = 'manual';
      changed = true;
    }
    if (patch.company !== undefined) {
      session.company = cleanText(patch.company).slice(0, 100);
      changed = true;
    }
    if (patch.position !== undefined) {
      session.position = cleanText(patch.position).slice(0, 100);
      changed = true;
    }

    if (changed) this._scheduleWrite();
    return clone(session);
  }

  removeSession(id) {
    this._ensureLoaded();
    const beforeRecords = this.data.records.length;
    this.data.sessions = this.data.sessions.filter((session) => session.id !== id);
    this.data.records = this.data.records.filter((record) => record.sessionId !== id);
    if (this.data.activeSessionId === id) this.data.activeSessionId = null;
    const removedRecords = beforeRecords - this.data.records.length;
    this._scheduleWrite();
    return { success: true, removedRecords };
  }

  addRecord(input = {}) {
    this._ensureLoaded();
    const question = cleanText(input.question).slice(0, MAX_QUESTION_CHARS);
    const answer = cleanText(input.answer).slice(0, MAX_ANSWER_CHARS);
    if (!question || !answer) return null;

    const type = RECORD_TYPES.has(input.type) ? input.type : 'chat';
    const skill = typeof input.skill === 'string' ? input.skill : null;
    const session = this._ensureActiveSessionForRecord(derivedSessionType(skill));
    const createdAt = new Date().toISOString();

    const record = {
      id: makeId('hr'),
      sessionId: session.id,
      createdAt,
      type,
      skill,
      language: typeof input.language === 'string' ? input.language : null,
      question,
      answer,
      code: cleanText(input.code).slice(0, 20000) || extractCode(answer),
      starred: false,
      tags: [],
      note: '',
      meta: input.meta && typeof input.meta === 'object' ? { ...input.meta } : {}
    };

    this.data.records.push(record);
    session.lastActivityAt = createdAt;
    this._trim();
    this._scheduleWrite();

    logger.info('History record saved', {
      recordId: record.id,
      sessionId: session.id,
      type: record.type,
      skill: record.skill,
      questionLength: question.length,
      answerLength: answer.length
    });

    return clone(record);
  }

  listSessions(filters = {}) {
    this._ensureLoaded();
    const keyword = cleanText(filters.keyword).toLowerCase();
    const type = SESSION_TYPES.has(filters.type) ? filters.type : null;
    const from = filters.from ? toTime(filters.from) : 0;
    const to = filters.to ? toTime(filters.to) : 0;

    const recordsBySession = new Map();
    for (const record of this.data.records) {
      if (!recordsBySession.has(record.sessionId)) recordsBySession.set(record.sessionId, []);
      recordsBySession.get(record.sessionId).push(record);
    }

    const sessions = [];
    for (const session of this.data.sessions) {
      if (type && session.type !== type) continue;
      const started = toTime(session.startedAt);
      if (from && started < from) continue;
      if (to && started > to) continue;

      const records = recordsBySession.get(session.id) || [];
      if (keyword) {
        const haystack = [
          session.title,
          session.company,
          session.position,
          ...records.map((record) => `${record.question}\n${record.answer}\n${record.note}`)
        ].join('\n').toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }

      const sorted = records.slice().sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
      const last = sorted[sorted.length - 1];
      sessions.push({
        ...clone(session),
        recordCount: records.length,
        skills: [...new Set(records.map((record) => record.skill).filter(Boolean))],
        lastQuestion: last ? last.question.slice(0, 160) : ''
      });
    }

    sessions.sort((a, b) => toTime(b.lastActivityAt) - toTime(a.lastActivityAt));

    return sessions;
  }

  listRecords(filters = {}) {
    this._ensureLoaded();
    const keyword = cleanText(filters.keyword).toLowerCase();
    const sessionId = typeof filters.sessionId === 'string' ? filters.sessionId : null;
    const skill = typeof filters.skill === 'string' ? filters.skill : null;
    const type = RECORD_TYPES.has(filters.type) ? filters.type : null;
    const starredOnly = filters.starred === true;
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 500));
    const offset = Math.max(0, Number(filters.offset) || 0);

    const matched = this.data.records.filter((record) => {
      if (sessionId && record.sessionId !== sessionId) return false;
      if (skill && record.skill !== skill) return false;
      if (type && record.type !== type) return false;
      if (starredOnly && !record.starred) return false;
      if (keyword) {
        const haystack = `${record.question}\n${record.answer}\n${record.note}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });

    matched.sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
    const page = matched.slice(offset, offset + limit);

    return {
      total: matched.length,
      records: page.map((record) => this._toListRecord(record))
    };
  }

  _toListRecord(record) {
    const question = truncate(record.question, 500);
    const answer = truncate(record.answer, 1200);
    return {
      ...record,
      // 列表只带预览，完整代码块在展开时通过 history-get-record 读取。
      code: '',
      question: question.text,
      questionTruncated: question.truncated,
      answer: answer.text,
      answerTruncated: answer.truncated
    };
  }

  getRecord(id) {
    this._ensureLoaded();
    const record = this.data.records.find((item) => item.id === id);
    return record ? clone(record) : null;
  }

  updateRecord(id, patch = {}) {
    this._ensureLoaded();
    const record = this.data.records.find((item) => item.id === id);
    if (!record) return null;
    let changed = false;

    if (patch.starred !== undefined) {
      record.starred = patch.starred === true;
      changed = true;
    }
    if (patch.note !== undefined) {
      record.note = cleanText(patch.note).slice(0, MAX_NOTE_CHARS);
      changed = true;
    }
    if (Array.isArray(patch.tags)) {
      record.tags = patch.tags
        .map((tag) => cleanText(tag).slice(0, 30))
        .filter(Boolean)
        .slice(0, MAX_TAGS);
      changed = true;
    }

    if (changed) this._scheduleWrite();
    return clone(record);
  }

  removeRecord(id) {
    this._ensureLoaded();
    const before = this.data.records.length;
    this.data.records = this.data.records.filter((record) => record.id !== id);
    const removed = before - this.data.records.length;
    if (removed) {
      this._trim();
      this._scheduleWrite();
    }
    return { success: true, removed };
  }

  clearAll() {
    this._ensureLoaded();
    this.data = emptyData();
    this._dirty = true;
    this._scheduleWrite();
    logger.warn('History cleared by user');
    return { success: true };
  }

  getStats() {
    this._ensureLoaded();
    const byType = {};
    const bySkill = {};
    for (const record of this.data.records) {
      byType[record.type] = (byType[record.type] || 0) + 1;
      if (record.skill) bySkill[record.skill] = (bySkill[record.skill] || 0) + 1;
    }
    return {
      sessionCount: this.data.sessions.length,
      activeSessionId: this.data.activeSessionId,
      recordCount: this.data.records.length,
      byType,
      bySkill,
      filePath: this.filePath,
      estimatedBytes: JSON.stringify(this.data).length
    };
  }

  getExportPayload({ format = 'markdown', sessionId = null } = {}) {
    this._ensureLoaded();
    if (format === 'json') {
      return JSON.stringify(this.data, null, 2);
    }

    const sessions = sessionId
      ? this.data.sessions.filter((session) => session.id === sessionId)
      : this.data.sessions.slice().sort((a, b) => toTime(a.startedAt) - toTime(b.startedAt));

    return sessions.map((session) => this._sessionToMarkdown(session)).join('\n\n---\n\n');
  }

  _sessionToMarkdown(session) {
    const records = this.data.records
      .filter((record) => record.sessionId === session.id)
      .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));

    const lines = [];
    lines.push(`# ${session.title}`);
    lines.push('');
    lines.push(`- 类型：${typeLabelForSession(session.type)}`);
    if (session.company) lines.push(`- 公司：${session.company}`);
    if (session.position) lines.push(`- 岗位：${session.position}`);
    lines.push(`- 开始时间：${formatDateTime(session.startedAt)}`);
    if (session.endedAt) lines.push(`- 结束时间：${formatDateTime(session.endedAt)}`);
    lines.push(`- 记录数：${records.length}`);

    const recordTypeLabels = { chat: '聊天', screenshot: '截图', speech: '语音' };
    records.forEach((record, index) => {
      lines.push('');
      lines.push(`## ${index + 1}. ${recordTypeLabels[record.type] || record.type} · ${formatDateTime(record.createdAt)}`);
      if (record.skill) lines.push(`> 技能：${record.skill}${record.language ? ` · 语言：${record.language}` : ''}`);
      if (record.starred) lines.push('> 已收藏');
      lines.push('');
      lines.push('**题目**');
      lines.push('');
      lines.push(record.question);
      lines.push('');
      lines.push('**答案**');
      lines.push('');
      lines.push(record.answer);
      if (record.note) {
        lines.push('');
        lines.push(`**备注**：${record.note}`);
      }
    });

    return lines.join('\n');
  }

  _trim() {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    this.data.records = this.data.records.filter((record) => toTime(record.createdAt) >= cutoff);

    if (this.data.records.length > MAX_RECORDS) {
      this.data.records.sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
      this.data.records = this.data.records.slice(-MAX_RECORDS);
    }

    const usedSessionIds = new Set(this.data.records.map((record) => record.sessionId));
    this.data.sessions = this.data.sessions.filter((session) => {
      if (session.id === this.data.activeSessionId) return true;
      if (session.status === 'active') return true;
      return usedSessionIds.has(session.id);
    });
  }

  _scheduleWrite() {
    this._dirty = true;
    this._version++;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this._flushAsync();
    }, 200);
    if (typeof this._writeTimer.unref === 'function') this._writeTimer.unref();
  }

  async _flushAsync() {
    if (this._writing) return;
    if (!this._dirty) return;

    this._writing = true;
    this._dirty = false;
    const version = this._version;
    const payload = JSON.stringify(this.data, null, 2);

    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, 'utf8');
      // 写入期间若有新修改（或已由 flushSync 落盘），跳过这次 rename，
      // 让更新的数据走下一轮写入，避免旧内容覆盖新内容。
      if (version !== this._version) {
        this._dirty = true;
        return;
      }
      await fs.promises.rename(tmpPath, this.filePath);
      try {
        await fs.promises.chmod(this.filePath, 0o600);
      } catch (_) {
        // Windows 上 chmod 语义有限，失败不阻塞保存
      }
    } catch (error) {
      this._dirty = true;
      logger.error('Failed to persist history.json', {
        error: error.message,
        file: this.filePath
      });
    } finally {
      this._writing = false;
      if (this._dirty) this._scheduleWrite();
    }
  }

  // will-quit 阶段无法 await，用同步写保证最后一次修改不丢。
  flushSync() {
    if (!this._loaded) return;
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 用单独的临时文件，避免与仍在进行的异步写重名。
      const tmpPath = `${this.filePath}.quit.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch (_) {
        // Windows 上 chmod 语义有限
      }
      this._dirty = false;
    } catch (error) {
      logger.error('Failed to flush history.json on quit', { error: error.message });
    }
  }
}

module.exports = new HistoryService();
module.exports.HistoryService = HistoryService;
