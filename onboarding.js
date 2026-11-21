/* eslint-disable no-undef */
/**
 * Onboarding wizard controller.
 *
 * Drives the 4-step flow rendered in onboarding.html and persists
 * everything via the electronAPI bridge exposed by preload.js:
 *
 *   1. Welcome
 *   2. DeepSeek API key entry + live connection test
 *   3. Doubao speech provider setup (or skip)
 *   4. Star-the-repo prompt + summary
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = $$('.screen');
  const stepperDots = $$('.step-dot');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    deepseekKey: '',
    deepseekConfigured: false, // a key already exists in .env from a prior run
    speechProvider: null, // 'doubao' | 'skip'
    doubaoApiKey: '',
    finished: false,
  };

  const stepScreens = ['welcome', 'apikey', 'speech', 'finish'];

  // ── Step rendering ────────────────────────────────────────────────
  function refreshStepper() {
    const total = stepScreens.length;
    const current = state.step + 1;
    stepBadge.textContent = `Step ${current} of ${total}`;
    stepperDots.forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    nextBtn.disabled = false;
    nextBtn.classList.remove('success');
    nextBtn.classList.add('primary');
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    if (skipBtn) skipBtn.style.display = 'none';
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'apikey':
        // A key already in .env is enough — don't force a re-entry.
        return !!state.deepseekKey.trim() || state.deepseekConfigured;
      case 'speech':
        return !!state.speechProvider;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: API key ──────────────────────────────────────────────
  const deepseekInput = $('#deepseekKey');
  const toggleVis = $('#toggleVis');
  const keyStatus = $('#keyStatus');

  function setKeyStatus(state_, text) {
    keyStatus.className = `status-pill ${state_}`;
    keyStatus.style.display = 'inline-flex';
    const icon = keyStatus.querySelector('i');
    const txt = keyStatus.querySelector('.text');
    if (state_ === 'testing') {
      icon.className = 'fas fa-circle-notch fa-spin';
    } else if (state_ === 'success') {
      icon.className = 'fas fa-check-circle';
    } else if (state_ === 'error') {
      icon.className = 'fas fa-circle-xmark';
    } else {
      icon.className = 'fas fa-circle-info';
    }
    txt.textContent = text;
  }

  deepseekInput.addEventListener('input', () => {
    state.deepseekKey = deepseekInput.value.trim();
    if (!state.deepseekKey) {
      keyStatus.style.display = 'none';
    } else if (keyStatus.classList.contains('success')) {
      // Keep success state — they had a valid key, may be editing
    } else {
      setKeyStatus('idle', 'Key entered');
    }
  });

  toggleVis.addEventListener('click', () => {
    const showing = deepseekInput.type === 'text';
    deepseekInput.type = showing ? 'password' : 'text';
    toggleVis.innerHTML = showing
      ? '<i class="fas fa-eye"></i>'
      : '<i class="fas fa-eye-slash"></i>';
  });

  // ── Wire up: Speech choices ───────────────────────────────────────
  $$('#speechChoices .choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      state.speechProvider = value;
      $$('#speechChoices .choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const doubaoPanel = $('#doubaoPanel');
      doubaoPanel.style.display = value === 'doubao' ? 'block' : 'none';
      if (value !== 'doubao') {
        state.doubaoApiKey = '';
      }
    });
  });

  $('#doubaoApiKey').addEventListener('input', (e) => { state.doubaoApiKey = e.target.value.trim(); });

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    rows.push({
      label: '<i class="fas fa-key"></i> DeepSeek API',
      value: (state.deepseekKey || state.deepseekConfigured) ? 'Configured' : 'Missing',
      cls: (state.deepseekKey || state.deepseekConfigured) ? 'ok' : 'skip',
    });
    if (state.speechProvider === 'doubao') {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: state.doubaoApiKey ? 'Doubao' : 'Doubao (configure in Settings)',
        cls: 'ok',
      });
    } else {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: 'Skipped (configure later)',
        cls: 'skip',
      });
    }
    rows.push({
      label: '<i class="fas fa-file-lines"></i> Config saved to',
      value: '.env',
      cls: 'ok',
    });
    $('#summaryList').innerHTML = rows
      .map((r) => `
        <div class="summary-row">
          <div class="label">${r.label}</div>
          <div class="value ${r.cls}">${r.value}</div>
        </div>
      `)
      .join('');
  }

  $('#starBtn').addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://github.com/TechyCSR/OpenCluely');
    } else {
      window.open('https://github.com/TechyCSR/OpenCluely', '_blank');
    }
  });
  $('#skipStarBtn').addEventListener('click', () => {
    // No-op — just visual closure
  });

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      if (name === 'apikey') setKeyStatus('error', 'Enter a DeepSeek API key');
      return;
    }

    // Persist settings on speech selection, since we already saved
    // deepseekKey on test; do it here too if the user skipped testing.
    if (name === 'apikey' && state.deepseekKey && window.electronAPI) {
      try {
        await window.electronAPI.saveSettings({ deepseekKey: state.deepseekKey });
      } catch (_) { /* surfaced elsewhere */ }
    }
    if (name === 'speech' && window.electronAPI) {
      try {
        const payload = {};
        if (state.speechProvider === 'doubao' && state.doubaoApiKey) {
          payload.doubaoApiKey = state.doubaoApiKey;
        }
        await window.electronAPI.saveSettings(payload);
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    const order = stepScreens;
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    state.step = order.indexOf(nextName);
    showScreen(nextName);
    if (nextName === 'finish') populateSummary();
  });

  backBtn.addEventListener('click', () => {
    const name = currentScreenName();
    const idx = stepScreens.indexOf(name);
    const prevName = stepScreens[idx - 1];
    if (!prevName) return;
    state.step = stepScreens.indexOf(prevName);
    showScreen(prevName);
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
  });

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');

  // Pre-populate DeepSeek key from existing .env (if any) so users with
  // a partial config don't have to retype.
  if (window.electronAPI && window.electronAPI.getFirstRunStatus) {
    window.electronAPI.getFirstRunStatus().then((s) => {
      if (s && s.deepseekConfigured) {
        state.deepseekConfigured = true;
        setKeyStatus('success', 'Already configured — click Continue');
        deepseekInput.placeholder = '•••••••••••••••• (already set)';
      }
    }).catch(() => {});
  }
})();
