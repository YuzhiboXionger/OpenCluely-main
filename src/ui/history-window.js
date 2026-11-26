(() => {
  const api = window.electronAPI;

  const state = {
    sessions: [],
    records: [],
    selectedSessionId: null,
    keyword: '',
    typeFilter: '',
    skillFilter: '',
    expanded: new Set(),
    fullRecords: new Map(),
    noteEditing: new Set()
  };

  const els = {};
  let refreshToken = 0;
  let refreshTimer = null;
  let toastTimer = null;
  let lastDetailSessionId = null;

  const SESSION_TYPE_LABELS = {
    written_test: '笔试',
    interview: '面试',
    mixed: '混合'
  };

  const RECORD_TYPE_META = {
    chat: { label: '聊天', icon: 'fa-comment-dots' },
    screenshot: { label: '截图', icon: 'fa-camera' },
    speech: { label: '语音', icon: 'fa-microphone' }
  };

  const SKILL_LABELS = {
    dsa: '算法 / 笔试',
    interview: '面试问答'
  };

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatSessionRange(session) {
    const start = formatDateTime(session.startedAt);
    if (session.endedAt) {
      return `${start} ~ ${formatDateTime(session.endedAt)}`;
    }
    return `${start} 开始`;
  }

  function dateKey(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function formatDateGroup(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((today - target) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function sessionTypeClass(type) {
    if (type === 'interview') return 'badge-interview';
    if (type === 'mixed') return 'badge-mixed';
    return 'badge-written';
  }

  function renderMarkdown(text) {
    const source = String(text || '');
    try {
      if (window.marked && typeof window.marked.parse === 'function') {
        return window.marked.parse(source);
      }
      if (window.markdown && typeof window.markdown.toHTML === 'function') {
        return window.markdown.toHTML(source);
      }
    } catch (error) {
      console.error('[HISTORY] Markdown render failed:', error);
    }
    const div = document.createElement('div');
    div.textContent = source;
    return div.innerHTML;
  }

  function enhanceMarkdown(container) {
    if (!container) return;
    try {
      if (window.Prism && typeof window.Prism.highlightAllUnder === 'function') {
        window.Prism.highlightAllUnder(container);
      }
    } catch (_) {}
    try {
      if (window.renderMathInElement) window.renderMathInElement(container);
    } catch (_) {}
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2200);
  }

  function selectedSession() {
    return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
  }

  async function refreshAll() {
    const token = ++refreshToken;
    if (!api || typeof api.historyListSessions !== 'function') {
      showToast('历史记录接口不可用');
      return;
    }

    let sessions = [];
    try {
      sessions = await api.historyListSessions({
        keyword: state.keyword,
        type: state.typeFilter || undefined
      });
    } catch (error) {
      console.error('[HISTORY] Failed to load sessions:', error);
      showToast('加载历史记录失败');
      return;
    }
    if (token !== refreshToken) return;

    state.sessions = Array.isArray(sessions) ? sessions : [];

    if (state.selectedSessionId && !state.sessions.some((s) => s.id === state.selectedSessionId)) {
      state.selectedSessionId = null;
    }
    if (!state.selectedSessionId && state.sessions.length) {
      state.selectedSessionId = state.sessions[0].id;
    }

    renderSessionList();
    renderDetail();
    await loadRecords(token);
  }

  async function loadRecords(token) {
    if (!state.selectedSessionId) {
      state.records = [];
      renderRecords();
      return;
    }

    let result = { total: 0, records: [] };
    try {
      result = await api.historyListRecords({
        sessionId: state.selectedSessionId,
        keyword: state.keyword,
        skill: state.skillFilter || undefined
      });
    } catch (error) {
      console.error('[HISTORY] Failed to load records:', error);
      showToast('加载问答记录失败');
    }
    if (token !== refreshToken) return;

    state.records = Array.isArray(result.records) ? result.records : [];
    renderRecords();
  }

  function scheduleRefresh() {
    if (document.hidden) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAll();
    }, 180);
  }

  function renderSessionList() {
    const list = els.sessionList;
    if (!list) return;
    list.innerHTML = '';

    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = state.keyword || state.typeFilter ? '没有匹配的场次' : '还没有历史记录';
      list.appendChild(empty);
      return;
    }

    let lastGroupKey = '';
    for (const session of state.sessions) {
      const groupIso = session.lastActivityAt || session.startedAt;
      const groupKey = dateKey(groupIso);
      if (groupKey && groupKey !== lastGroupKey) {
        lastGroupKey = groupKey;
        const group = document.createElement('div');
        group.className = 'session-date-group';
        group.textContent = formatDateGroup(groupIso);
        list.appendChild(group);
      }

      const card = document.createElement('div');
      card.className = 'session-card' + (session.id === state.selectedSessionId ? ' selected' : '');
      card.dataset.sessionId = session.id;

      const title = document.createElement('div');
      title.className = 'session-card-title';
      const titleText = document.createElement('span');
      titleText.textContent = session.title;
      titleText.style.overflow = 'hidden';
      titleText.style.textOverflow = 'ellipsis';
      titleText.style.whiteSpace = 'nowrap';
      title.appendChild(titleText);
      card.appendChild(title);

      const sub = document.createElement('div');
      sub.className = 'session-card-sub';

      const typeBadge = document.createElement('span');
      typeBadge.className = `badge ${sessionTypeClass(session.type)}`;
      typeBadge.textContent = SESSION_TYPE_LABELS[session.type] || '场次';
      sub.appendChild(typeBadge);

      if (session.status === 'active') {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'badge badge-active';
        activeBadge.textContent = '进行中';
        sub.appendChild(activeBadge);
      }

      const count = document.createElement('span');
      count.textContent = `${session.recordCount || 0} 条`;
      sub.appendChild(count);

      const range = document.createElement('span');
      range.textContent = formatSessionRange(session);
      sub.appendChild(range);

      card.appendChild(sub);

      if (session.lastQuestion) {
        const last = document.createElement('div');
        last.className = 'session-card-last';
        last.textContent = session.lastQuestion;
        card.appendChild(last);
      }

      card.addEventListener('click', () => selectSession(session.id));
      list.appendChild(card);
    }
  }

  function renderDetail() {
    const session = selectedSession();
    if (!session) {
      els.emptyDetail.style.display = 'flex';
      els.sessionDetail.style.display = 'none';
      return;
    }

    els.emptyDetail.style.display = 'none';
    els.sessionDetail.style.display = 'flex';

    if (lastDetailSessionId !== session.id) {
      els.sessionTitle.value = session.title;
      els.sessionType.value = session.type;
      lastDetailSessionId = session.id;
    } else {
      if (document.activeElement !== els.sessionTitle) {
        els.sessionTitle.value = session.title;
      }
      if (document.activeElement !== els.sessionType) {
        els.sessionType.value = session.type;
      }
    }

    const parts = [formatSessionRange(session), `${session.recordCount || 0} 条记录`];
    if (session.company) parts.push(session.company);
    if (session.position) parts.push(session.position);
    if (session.status === 'ended') parts.push('已结束');
    els.sessionMeta.textContent = parts.join(' · ');

    els.endSessionBtn.style.display = session.status === 'ended' ? 'none' : 'inline-flex';
  }

  function selectSession(id) {
    if (!id || state.selectedSessionId === id) return;
    state.selectedSessionId = id;
    state.expanded.clear();
    state.noteEditing.clear();
    renderSessionList();
    renderDetail();
    loadRecords(refreshToken);
  }

  function renderRecords() {
    const list = els.recordList;
    if (!list) return;
    list.innerHTML = '';

    if (!state.records.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = state.keyword || state.skillFilter ? '本场没有匹配的记录' : '本场还没有问答记录';
      list.appendChild(empty);
      return;
    }

    state.records.forEach((record, index) => {
      list.appendChild(buildRecordCard(record, index));
    });
  }

  function buildRecordCard(record, index) {
    const full = state.fullRecords.get(record.id) || record;
    const expanded = state.expanded.has(record.id);

    const card = document.createElement('div');
    card.className = 'record-card' + (expanded ? ' expanded' : '');
    card.dataset.recordId = record.id;

    const head = document.createElement('div');
    head.className = 'record-head';

    const indexBadge = document.createElement('span');
    indexBadge.className = 'record-index';
    indexBadge.textContent = String(index + 1);
    head.appendChild(indexBadge);

    const meta = RECORD_TYPE_META[record.type] || RECORD_TYPE_META.chat;
    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge badge-type';
    typeBadge.textContent = meta.label;
    head.appendChild(typeBadge);

    if (record.skill) {
      const skillBadge = document.createElement('span');
      skillBadge.className = 'badge badge-type';
      skillBadge.textContent = SKILL_LABELS[record.skill] || record.skill;
      head.appendChild(skillBadge);
    }

    if (record.language) {
      const langBadge = document.createElement('span');
      langBadge.className = 'badge badge-type';
      langBadge.textContent = record.language;
      head.appendChild(langBadge);
    }

    const time = document.createElement('span');
    time.className = 'record-time';
    time.textContent = formatDateTime(record.createdAt);
    head.appendChild(time);

    const spacer = document.createElement('span');
    spacer.className = 'record-spacer';
    head.appendChild(spacer);

    const actions = document.createElement('div');
    actions.className = 'record-actions';

    const starBtn = createActionButton(
      'fa-star',
      record.starred ? '取消收藏' : '收藏',
      record.starred ? 'is-starred' : ''
    );
    starBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const updated = await api.historyUpdateRecord(record.id, { starred: !record.starred });
      if (updated) {
        record.starred = updated.starred;
        state.records = state.records.map((item) => (item.id === record.id ? { ...item, starred: updated.starred } : item));
        showToast(updated.starred ? '已收藏' : '已取消收藏');
        renderRecords();
      }
    });
    actions.appendChild(starBtn);

    const noteBtn = createActionButton('fa-note-sticky', '备注');
    noteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.noteEditing.has(record.id)) {
        state.noteEditing.delete(record.id);
      } else {
        state.noteEditing.add(record.id);
        state.expanded.add(record.id);
      }
      renderRecords();
      if (state.noteEditing.has(record.id)) {
        const textarea = document.querySelector(`[data-record-id="${record.id}"] textarea`);
        if (textarea) textarea.focus();
      }
    });
    actions.appendChild(noteBtn);

    const copyBtn = createActionButton('fa-copy', '复制题目与答案');
    copyBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const source = state.fullRecords.get(record.id) || record;
      const text = `题目：\n${source.question}\n\n答案：\n${source.answer}`;
      if (api && typeof api.copyToClipboard === 'function') {
        await api.copyToClipboard(text);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      showToast('已复制');
    });
    actions.appendChild(copyBtn);

    const deleteBtn = createActionButton('fa-trash', '删除这条记录', 'danger');
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm('确定删除这条问答记录吗？此操作不可恢复。')) return;
      const result = await api.historyRemoveRecord(record.id);
      if (result && result.success) {
        state.expanded.delete(record.id);
        state.noteEditing.delete(record.id);
        state.fullRecords.delete(record.id);
        showToast('已删除');
        await refreshAll();
      }
    });
    actions.appendChild(deleteBtn);

    head.appendChild(actions);

    head.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      if (state.expanded.has(record.id)) {
        state.expanded.delete(record.id);
      } else {
        state.expanded.add(record.id);
      }
      renderRecords();
    });

    card.appendChild(head);

    const question = document.createElement('div');
    question.className = 'record-question';
    question.textContent = full.question || '（无题目文本）';
    card.appendChild(question);

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'record-body';
      body.textContent = '加载完整记录…';
      card.appendChild(body);
      fillRecordBody(body, record);
    }

    return card;
  }

  function createActionButton(icon, title, extraClass = '') {
    const button = document.createElement('button');
    button.className = `record-action ${extraClass}`.trim();
    button.title = title;
    const i = document.createElement('i');
    i.className = `fas ${icon}`;
    button.appendChild(i);
    return button;
  }

  async function ensureFullRecord(record) {
    if (state.fullRecords.has(record.id)) return state.fullRecords.get(record.id);
    if (!record.questionTruncated && !record.answerTruncated) return record;
    try {
      const full = await api.historyGetRecord(record.id);
      if (full) state.fullRecords.set(record.id, full);
      return full || record;
    } catch (error) {
      console.error('[HISTORY] Failed to load full record:', error);
      return record;
    }
  }

  async function fillRecordBody(body, record) {
    const full = await ensureFullRecord(record);
    if (!body.isConnected) return;

    body.innerHTML = '';

    const answer = document.createElement('div');
    answer.className = 'markdown-body';
    if (full.answer) {
      answer.innerHTML = renderMarkdown(full.answer);
    } else {
      answer.textContent = '（无答案文本）';
    }
    body.appendChild(answer);
    enhanceMarkdown(answer);

    if (full.note) {
      const note = document.createElement('div');
      note.className = 'record-note';
      note.textContent = `备注：${full.note}`;
      body.appendChild(note);
    }

    if (state.noteEditing.has(record.id)) {
      body.appendChild(buildNoteEditor(record, full));
    }
  }

  function buildNoteEditor(record, full) {
    const wrap = document.createElement('div');
    wrap.className = 'note-editor';

    const textarea = document.createElement('textarea');
    textarea.placeholder = '写点复习备注，例如：这题的边界条件 / 更好的解法…';
    textarea.value = full.note || '';
    wrap.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'note-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-small';
    saveBtn.innerHTML = '<i class="fas fa-check"></i> 保存备注';
    saveBtn.addEventListener('click', async () => {
      const updated = await api.historyUpdateRecord(record.id, { note: textarea.value });
      if (updated) {
        state.noteEditing.delete(record.id);
        const cached = state.fullRecords.get(record.id);
        if (cached) cached.note = updated.note;
        record.note = updated.note;
        showToast('备注已保存');
        renderRecords();
      }
    });
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-small';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => {
      state.noteEditing.delete(record.id);
      renderRecords();
    });
    actions.appendChild(cancelBtn);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    actions.appendChild(spacer);

    wrap.appendChild(actions);

    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveBtn.click();
      }
    });

    return wrap;
  }

  async function saveSessionPatch(patch) {
    const session = selectedSession();
    if (!session) return;
    const updated = await api.historyUpdateSession(session.id, patch);
    if (updated) {
      Object.assign(session, updated);
      renderSessionList();
      renderDetail();
    }
  }

  async function createSession() {
    const session = await api.historyCreateSession({ type: 'written_test' });
    if (!session) return;
    state.selectedSessionId = session.id;
    await refreshAll();
    els.sessionTitle.focus();
    els.sessionTitle.select();
    showToast('已新建场次，可直接改标题');
  }

  async function endCurrentSession() {
    const session = selectedSession();
    if (!session) return;
    const updated = await api.historyEndSession(session.id);
    if (updated) {
      showToast('场次已结束');
      await refreshAll();
    }
  }

  async function removeCurrentSession() {
    const session = selectedSession();
    if (!session) return;
    const count = session.recordCount || 0;
    if (!window.confirm(`确定删除「${session.title}」及其中 ${count} 条记录吗？此操作不可恢复。`)) return;
    const result = await api.historyRemoveSession(session.id);
    if (result && result.success) {
      state.selectedSessionId = null;
      state.expanded.clear();
      state.noteEditing.clear();
      state.fullRecords.clear();
      showToast('场次已删除');
      await refreshAll();
    }
  }

  async function exportHistory(sessionId) {
    const result = await api.historyExport({ format: 'markdown', sessionId: sessionId || null });
    if (result && result.success) {
      showToast('已导出到文件');
    } else if (result && result.error) {
      showToast(`导出失败：${result.error}`);
    }
  }

  async function clearAll() {
    if (!window.confirm('确定清空全部历史记录吗？此操作不可恢复。')) return;
    if (!window.confirm('再次确认：所有场次、问答、收藏与备注都会被删除。')) return;
    const result = await api.historyClearAll();
    if (result && result.success) {
      state.selectedSessionId = null;
      state.expanded.clear();
      state.noteEditing.clear();
      state.fullRecords.clear();
      showToast('历史记录已清空');
      await refreshAll();
    }
  }

  function bindEvents() {
    els.searchInput.addEventListener('input', () => {
      state.keyword = els.searchInput.value.trim();
      scheduleRefresh();
    });

    els.typeFilter.addEventListener('change', () => {
      state.typeFilter = els.typeFilter.value;
      refreshAll();
    });

    els.skillFilter.addEventListener('change', () => {
      state.skillFilter = els.skillFilter.value;
      loadRecords(refreshToken);
    });

    els.newSessionBtn.addEventListener('click', createSession);
    els.exportAllBtn.addEventListener('click', () => exportHistory(null));
    els.clearAllBtn.addEventListener('click', clearAll);
    els.closeBtn.addEventListener('click', () => api.hideHistory());

    els.sessionTitle.addEventListener('change', () => {
      const title = els.sessionTitle.value.trim();
      if (title) saveSessionPatch({ title });
    });
    els.sessionTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        els.sessionTitle.blur();
      }
    });

    els.sessionType.addEventListener('change', () => {
      saveSessionPatch({ type: els.sessionType.value });
    });

    els.endSessionBtn.addEventListener('click', endCurrentSession);
    els.exportSessionBtn.addEventListener('click', () => {
      const session = selectedSession();
      if (session) exportHistory(session.id);
    });
    els.removeSessionBtn.addEventListener('click', removeCurrentSession);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        api.hideHistory();
      }
    });

    if (api && typeof api.onHistoryChanged === 'function') {
      api.onHistoryChanged(() => scheduleRefresh());
    }
    if (api && typeof api.onHistoryWindowShown === 'function') {
      api.onHistoryWindowShown(() => refreshAll());
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAll();
    });
  }

  function init() {
    els.sessionList = $('sessionList');
    els.emptyDetail = $('emptyDetail');
    els.sessionDetail = $('sessionDetail');
    els.recordList = $('recordList');
    els.searchInput = $('searchInput');
    els.typeFilter = $('typeFilter');
    els.skillFilter = $('skillFilter');
    els.newSessionBtn = $('newSessionBtn');
    els.exportAllBtn = $('exportAllBtn');
    els.clearAllBtn = $('clearAllBtn');
    els.closeBtn = $('closeBtn');
    els.sessionTitle = $('sessionTitle');
    els.sessionType = $('sessionType');
    els.sessionMeta = $('sessionMeta');
    els.endSessionBtn = $('endSessionBtn');
    els.exportSessionBtn = $('exportSessionBtn');
    els.removeSessionBtn = $('removeSessionBtn');
    els.toast = $('toast');

    if (!api) {
      console.error('[HISTORY] electronAPI unavailable');
      return;
    }

    try {
      if (window.marked && typeof window.marked.setOptions === 'function') {
        window.marked.setOptions({ breaks: true, gfm: true });
      }
    } catch (_) {}

    bindEvents();
    refreshAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
