// Simple logger for renderer process
const logger = {
    info: (...args) => console.log('[MainWindowUI]', ...args),
    debug: (...args) => console.log('[MainWindowUI DEBUG]', ...args),
    error: (...args) => console.error('[MainWindowUI ERROR]', ...args),
    warn: (...args) => console.warn('[MainWindowUI WARN]', ...args)
};

// 音频采集参数：worklet 在音频线程完成降混、抗混叠重采样与静音门限，
// 主线程只负责把 16kHz PCM 转发给主进程。
const CAPTURE_WORKLET_NAME = 'opencluely-capture';
const CAPTURE_TARGET_RATE = 16000;
const CAPTURE_CHUNK_SAMPLES = 2560; // 160ms @ 16kHz
const CAPTURE_SILENCE_RMS = 0.0015; // 约 -56 dBFS，低于该值视为静音
// 静音后继续发送约 1.6s：服务端依赖尾部静音（end_window_size=800ms）
// 才会判定一句结束，过早停发会把最后一句一直挂起到下次说话。
const CAPTURE_SILENCE_HOLD = 10;

// 以 Blob URL 加载，避免 file:// 页面直接 fetch 本地 worklet 文件时的跨域限制。
const CAPTURE_WORKLET_SOURCE = `
class OpenCluelyCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    const cutoff = Math.min(7000, this.targetRate * 0.45);
    this.filters = [this.makeLowpass(cutoff), this.makeLowpass(cutoff)];
    this.ring = new Float32Array(4096);
    this.ringStart = 0;
    this.ringLength = 0;
    this.phase = 0;
    this.chunk = new Int16Array(${CAPTURE_CHUNK_SAMPLES});
    this.chunkLength = 0;
    this.sumSquares = 0;
    this.holdChunks = 0;
  }

  makeLowpass(f0) {
    const w0 = 2 * Math.PI * f0 / sampleRate;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 0.7071067811865476);
    const a0 = 1 + alpha;
    return {
      b0: ((1 - cosw) / 2) / a0,
      b1: (1 - cosw) / a0,
      b2: ((1 - cosw) / 2) / a0,
      a1: (-2 * cosw) / a0,
      a2: (1 - alpha) / a0,
      x1: 0, x2: 0, y1: 0, y2: 0
    };
  }

  filter(f, x) {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1;
    f.x1 = x;
    f.y2 = f.y1;
    f.y1 = y;
    return y;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;

    // 按能量加权降混：某一路几乎无声时权重自动转向另一路，
    // 避免左右声道简单平均导致音量减半。
    let weightL = 0.5;
    let weightR = 0.5;
    if (input.length > 1) {
      let energyL = 0;
      let energyR = 0;
      for (let i = 0; i < frames; i++) {
        energyL += input[0][i] * input[0][i];
        energyR += input[1][i] * input[1][i];
      }
      const total = energyL + energyR;
      if (total > 1e-9) {
        weightL = energyL / total;
        weightR = energyR / total;
      }
    }

    for (let i = 0; i < frames; i++) {
      const left = input[0][i];
      const right = input.length > 1 ? input[1][i] : left;
      let sample = weightL * left + weightR * right;
      sample = this.filter(this.filters[0], sample);
      sample = this.filter(this.filters[1], sample);
      this.ring[(this.ringStart + this.ringLength) % this.ring.length] = sample;
      this.ringLength++;
    }

    // 线性插值重采样到 16kHz（已先做 4 阶低通，抑制混叠）。
    while (this.phase <= this.ringLength - 2) {
      const index = Math.floor(this.phase);
      const frac = this.phase - index;
      const a = this.ring[(this.ringStart + index) % this.ring.length];
      const b = this.ring[(this.ringStart + index + 1) % this.ring.length];
      this.emit(a + (b - a) * frac);
      this.phase += this.ratio;
    }

    const consume = Math.min(Math.floor(this.phase), this.ringLength);
    if (consume > 0) {
      this.ringStart = (this.ringStart + consume) % this.ring.length;
      this.ringLength -= consume;
      this.phase -= consume;
    }
    return true;
  }

  emit(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.chunk[this.chunkLength++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    this.sumSquares += clamped * clamped;
    if (this.chunkLength === this.chunk.length) this.flush();
  }

  flush() {
    const rms = Math.sqrt(this.sumSquares / this.chunkLength);
    const buffer = this.chunk.buffer;
    if (rms >= ${CAPTURE_SILENCE_RMS}) {
      this.holdChunks = ${CAPTURE_SILENCE_HOLD};
      this.port.postMessage(buffer, [buffer]);
    } else if (this.holdChunks > 0) {
      this.holdChunks--;
      this.port.postMessage(buffer, [buffer]);
    }
    this.chunk = new Int16Array(${CAPTURE_CHUNK_SAMPLES});
    this.chunkLength = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('${CAPTURE_WORKLET_NAME}', OpenCluelyCaptureProcessor);
`;

class MainWindowUI {
    constructor() {
        this.isInteractive = false;
        this.isHidden = false;
        this.currentSkill = 'dsa'; // Default, will be updated from settings
        this.statusDot = null;
        this.skillIndicator = null;
        this.micButton = null;
        this.isRecording = false;
        this.speechAvailable = false; // track availability
        this.audioInputSource = 'microphone'; // 'microphone' | 'system'
        this._popoverHideTimeout = null;
        // Renderer-side audio capture state (used for Doubao on Windows/macOS)
        this._audioContext = null;
        this._mediaStream = null;
        this._sourceNode = null;
        this._workletNode = null;
        this._workletUrl = null;
        this._muteNode = null;
        this._captureInterval = null;
        
        // Define available skills for navigation
        this.availableSkills = [
            'dsa',
            'interview'
        ];
        
        this.init();
    }

    async init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            
            // Load current skill from settings
            await this.loadCurrentSkill();
            
            // Load current interaction state
            await this.loadCurrentInteractionState();

            // Keep the command bar's background in sync with the answer panel
            await this.loadAnswerOpacity();
            this.setupRegionHint();
            
            // Fetch speech availability
            await this.loadSpeechAvailability();
            
            this.updateSkillIndicator();
            this.updateAllElementStates(); // Update all elements with current state
            this.resizeWindowToContent();
            
            logger.info('Main window UI initialized', {
                component: 'MainWindowUI',
                skill: this.currentSkill,
                interactive: this.isInteractive
            });

            // Notify the main process that the overlay renderer is ready
            // so it can push the latest speech availability state.
            if (window.electronAPI && window.electronAPI.notifyMainWindowReady) {
                window.electronAPI.notifyMainWindowReady();
            }
            
        } catch (error) {
            logger.error('Failed to initialize main window UI', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentSkill() {
        try {
            if (window.electronAPI && window.electronAPI.getSettings) {
                const settings = await window.electronAPI.getSettings();
                if (settings && settings.activeSkill) {
                    this.currentSkill = settings.activeSkill;
                    logger.debug('Loaded current skill from settings', {
                        component: 'MainWindowUI',
                        skill: this.currentSkill
                    });
                }
            }
        } catch (error) {
            logger.warn('Failed to load current skill from settings', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentInteractionState() {
        try {
            // Request current interaction state from main process
            if (window.electronAPI && window.electronAPI.getWindowStats) {
                const stats = await window.electronAPI.getWindowStats();
                if (stats && typeof stats.isInteractive === 'boolean') {
                    this.isInteractive = stats.isInteractive;
                    logger.debug('Loaded current interaction state', {
                        component: 'MainWindowUI',
                        interactive: this.isInteractive
                    });
                }
            }
        } catch (error) {
            // If we can't get the state, assume non-interactive (safer default)
            this.isInteractive = false;
            logger.warn('Failed to load current interaction state, defaulting to non-interactive', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadAnswerOpacity() {
        try {
            const applyOpacity = (percent) => {
                const value = Number(percent);
                if (!Number.isFinite(value)) return;
                const alpha = Math.min(1, Math.max(0, value / 100));
                document.documentElement.style.setProperty('--answer-opacity', String(alpha));
            };
            if (window.electronAPI && window.electronAPI.getAnswerOpacity) {
                applyOpacity(await window.electronAPI.getAnswerOpacity());
            }
            if (window.electronAPI && window.electronAPI.onAnswerOpacity) {
                window.electronAPI.onAnswerOpacity(applyOpacity);
            }
        } catch (error) {
            logger.warn('Failed to load answer opacity', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    /**
     * Region screenshot mode (Ctrl+Alt+T) shows its hint inside the command bar
     * instead of covering the screen with an overlay mask.
     */
    setupRegionHint() {
        const hint = document.getElementById('regionHint');
        if (!hint || !window.electronAPI || !window.electronAPI.onRegionMode) return;

        window.electronAPI.onRegionMode((payload) => {
            if (payload && payload.active) {
                hint.textContent = payload.text || '区域截图：点击两次左上角（Esc 取消）';
                hint.hidden = false;
            } else {
                hint.hidden = true;
            }
        });
    }

    async loadSpeechAvailability() {
        try {
            if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
                this.speechAvailable = await window.electronAPI.getSpeechAvailability();
                this.applyMicVisibility();
            }
        } catch (e) {
            this.speechAvailable = false;
            this.applyMicVisibility();
        }
    }

    applyMicVisibility() {
        if (this.micButton) {
            if (this.speechAvailable) {
                this.micButton.style.display = '';
            } else {
                this.micButton.style.display = 'none';
            }
            // Resize to reflect layout change
            setTimeout(() => this.resizeWindowToContent(), 50);
        }
    }

    updateAllElementStates() {
        // Update all interactive elements with current state
        this.updateStatusDot();
        this.updateSkillIndicatorState();
        this.updateMicButtonState();
        this.updateSettingsIndicatorState();
    }

    updateStatusDot() {
        if (this.statusDot) {
            logger.debug('Updating status dot', {
                component: 'MainWindowUI',
                isInteractive: this.isInteractive,
                currentClasses: this.statusDot.className
            });
            
            // Remove both classes first
            this.statusDot.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.statusDot.classList.add('interactive');
            } else {
                this.statusDot.classList.add('non-interactive');
            }
            
            logger.debug('Status dot updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                newClasses: this.statusDot.className
            });
        } else {
            logger.error('Status dot element not found');
        }
    }

    updateSkillIndicatorState() {
        if (this.skillIndicator) {
            // Remove both classes first
            this.skillIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.skillIndicator.classList.add('interactive');
            } else {
                this.skillIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Skill indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                classes: this.skillIndicator.className
            });
        }
    }

    updateMicButtonState() {
        if (this.micButton) {
            // Also hide when unavailable
            this.applyMicVisibility();
            // Remove both classes first
            this.micButton.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.micButton.classList.add('interactive');
            } else {
                this.micButton.classList.add('non-interactive');
            }
            
            // Update button state
            this.micButton.disabled = !this.isInteractive;
            
            logger.debug('Mic button state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                disabled: !this.isInteractive
            });
        }
    }

    updateSettingsIndicatorState() {
        if (this.settingsIndicator) {
            // Remove both classes first
            this.settingsIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.settingsIndicator.classList.add('interactive');
            } else {
                this.settingsIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Settings indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive
            });
        } else {
            logger.debug('Settings indicator not found, skipping state update');
        }
    }

    resizeWindowToContent() {
        // Wait for DOM to fully render
        setTimeout(() => {
            const commandTab = document.querySelector('.command-tab');
            if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                const rect = commandTab.getBoundingClientRect();
                const width = Math.ceil(rect.width);
                let height = Math.ceil(rect.height);

                // If shortcuts popover is visible, extend height to fit it
                if (this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    const popRect = this.shortcutsPopover.getBoundingClientRect();
                    // popover is positioned below the bar (top:36px), add that plus its height and a small margin
                    height = Math.max(height, Math.ceil(36 + popRect.height + 8));
                }
                
                logger.debug('Resizing window to content', {
                    width,
                    height,
                    component: 'MainWindowUI'
                });
                
                window.electronAPI.resizeWindow(width, height);
            }
        }, 100);
    }

    setupElements() {
        this.statusDot = document.getElementById('statusDot');
        this.skillIndicator = document.getElementById('skillIndicator');
        this.settingsIndicator = document.getElementById('settingsIndicator'); // Optional
        this.micButton = document.getElementById('micButton');
    this.infoButton = document.getElementById('infoButton');
    this.historyButton = document.getElementById('historyButton');
    this.shortcutsPopover = document.getElementById('shortcutsPopover');

        // NEW: Screenshot button is the first .command-item without id
        const commandItems = document.querySelectorAll('.command-item');
        this.screenshotButton = commandItems && commandItems[0];

    if (!this.statusDot || !this.skillIndicator || !this.micButton || !this.screenshotButton) {
            throw new Error('Required UI elements not found');
        }

        // Screenshot click handler
        this.screenshotButton.addEventListener('click', () => {
            if (this.isInteractive && window.electronAPI && window.electronAPI.takeScreenshot) {
                window.electronAPI.takeScreenshot();
            }
        });

        // Skill indicator click handler cycles through available skills
        this.skillIndicator.addEventListener('click', () => {
            if (!this.isInteractive) return;
            const currentIndex = this.availableSkills.indexOf(this.currentSkill);
            const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % this.availableSkills.length;
            const newSkill = this.availableSkills[nextIndex];
            if (window.electronAPI && window.electronAPI.updateActiveSkill) {
                window.electronAPI.updateActiveSkill(newSkill).then(() => {
                    this.handleSkillActivated(newSkill);
                });
            } else {
                this.handleSkillActivated(newSkill);
            }
        });

        // Check for required elements (settingsIndicator is optional)
        if (this.settingsIndicator) {
            this.settingsIndicator.addEventListener('click', () => {
                if (this.isInteractive) {
                    this.showSettingsMenu();
                }
            });
        }

        // Add click handler for microphone
        this.micButton.addEventListener('click', async () => {
            if (this.isInteractive && this.speechAvailable) {
                try {
                    if (this.isRecording) {
                        await window.electronAPI.stopSpeechRecognition();
                    } else {
                        await window.electronAPI.startSpeechRecognition();
                    }
                } catch (error) {
                    logger.error('Speech recognition toggle failed', {
                        component: 'MainWindowUI',
                        error: error.message
                    });
                    this.isRecording = false;
                    this.updateMicButtonState();
                }
            } else if (this.isInteractive && !this.speechAvailable) {
                logger.warn('Mic clicked but speech recognition is not available', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            }
        });

        // Language dropdown
        this.languageSelect = document.getElementById('codingLanguage');
        if (this.languageSelect) {
            // Set default to C++ if no value is set
            this.languageSelect.value = 'cpp';
            
            // Initialize with current setting
            if (window.electronAPI && window.electronAPI.getSettings) {
                window.electronAPI.getSettings().then(settings => {
                    if (settings && settings.codingLanguage) {
                        this.languageSelect.value = settings.codingLanguage;
                    } else {
                        // Save C++ as default if no language is set
                        this.languageSelect.value = 'cpp';
                        window.electronAPI.saveSettings({ codingLanguage: 'cpp' });
                    }
                }).catch(() => {
                    // Fallback to C++ on error
                    this.languageSelect.value = 'cpp';
                });
            }

            this.languageSelect.addEventListener('change', (e) => {
                const lang = e.target.value;
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    window.electronAPI.saveSettings({ codingLanguage: lang });
                }
                // Resize for any width change
                setTimeout(() => {
                    const commandTab = document.querySelector('.command-tab');
                    if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                        const rect = commandTab.getBoundingClientRect();
                        window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
                    }
                }, 50);
            });
        }

        // History button
        if (this.historyButton) {
            this.historyButton.addEventListener('click', () => {
                if (!this.isInteractive) return;
                if (window.electronAPI && window.electronAPI.showHistory) {
                    window.electronAPI.showHistory();
                }
            });
        }

        // Info button / shortcuts popover
        if (this.infoButton && this.shortcutsPopover) {
            this.infoButton.addEventListener('click', (e) => {
                if (!this.isInteractive) return;
                e.stopPropagation();
                this.toggleShortcutsPopover();
            });

            // Hover to show
            this.infoButton.addEventListener('mouseenter', () => {
                if (!this.isInteractive) return;
                this.showShortcutsPopover();
            });
            // Queue hide when leaving the button
            this.infoButton.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Keep open when hovering popover
            this.shortcutsPopover.addEventListener('mouseenter', () => {
                if (this._popoverHideTimeout) {
                    clearTimeout(this._popoverHideTimeout);
                    this._popoverHideTimeout = null;
                }
            });
            // Hide after a small delay when leaving popover
            this.shortcutsPopover.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (!this.shortcutsPopover) return;
                const isClickInside = this.shortcutsPopover.contains(e.target) || this.infoButton.contains(e.target);
                if (!isClickInside && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });

            // Close on Escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });
        }
    }

    setupEventListeners() {
        if (window.electronAPI) {
            // Fix interaction mode change listener
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                logger.debug('Interaction mode changed received:', interactive);
                this.handleInteractionModeChanged(interactive);
            });

            window.electronAPI.onRecordingStarted(() => {
                this.handleRecordingStarted();
            });

            window.electronAPI.onRecordingStopped(() => {
                this.handleRecordingStopped();
            });

            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                }
            });

            window.electronAPI.onSpeechAvailability((event, data) => {
                this.speechAvailable = !!(data && data.available);
                this.applyMicVisibility();
            });

            // Listen for coding language changes from other windows
            window.electronAPI.onCodingLanguageChanged((event, data) => {
                if (data && data.language && this.languageSelect) {
                    // avoid clobbering if same value
                    if (this.languageSelect.value !== data.language) {
                        this.languageSelect.value = data.language;
                    }
                    logger.debug('Language updated from other window', {
                        component: 'MainWindowUI',
                        language: data.language
                    });
                }
            });

            // Listen for main window shown event to refresh speech availability
            window.electronAPI.onMainWindowShown(() => {
                logger.debug('Main window shown - refreshing speech availability', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            });
            
            // Global keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (e.altKey && e.key === 'r' && this.isInteractive) {
                    e.preventDefault();
                    if (!this.speechAvailable) return; // guard when unavailable
                    if (this.isRecording) {
                        window.electronAPI.stopSpeechRecognition();
                    } else {
                        window.electronAPI.startSpeechRecognition();
                    }
                }
            });
        }
        
        // Also listen via the api interface for backup
        if (window.api) {
            
            window.api.receive('interaction-mode-changed', (interactive) => {
                logger.debug('Interaction mode changed via api:', interactive);
                this.handleInteractionModeChanged(interactive);
            });
            
            window.api.receive('skill-updated', (data) => {
                logger.info('Skill updated event received from main process:', data);
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                } else if (typeof data === 'string') {
                    // Handle case where skill is passed directly as string
                    this.handleSkillChanged({ skill: data });
                } else {
                    logger.warn('Skill updated event received but no skill data found:', data);
                }
            });
            
            // Listen for skill updates from settings window  
            window.api.receive('update-skill', (skill) => {
                logger.info('Direct skill update received from settings:', skill);
                this.handleSkillChanged({ skill: skill });
            });
        } else {
            logger.error('window.api not available - event listeners not set up!');
        }
        
        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Settings shortcut
        this.setupSettingsShortcut();
    }

    handleLLMResponse(data) {
        const skill = data.skill || data.metadata?.skill || 'General';
        const skillNames = {
            'dsa': 'DSA',
            'interview': 'Interview',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displaySkill = skillNames[skill] || skill.toUpperCase();
        
        logger.info('LLM response received', {
            component: 'MainWindowUI',
            skill: skill,
            displaySkill: displaySkill
        });
    }

    handleLLMError(data) {
        logger.error('LLM error received', {
            component: 'MainWindowUI',
            error: data.error
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.metaKey && e.key === '\\') {
                this.isHidden = !this.isHidden;
                if (this.isHidden) {
                    this.showHiddenIndicator();
                }
            }
            
            // Handle Cmd + Arrow keys based on interaction mode
            if (e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                if (this.isInteractive) {
                    // Interactive mode: Cmd + Up/Down for skill navigation
                    if (e.key === 'ArrowUp') {
                        this.navigateSkill(-1); // Previous skill
                    } else if (e.key === 'ArrowDown') {
                        this.navigateSkill(1); // Next skill
                    } else {
                    }
                    // Left/Right arrows do nothing in interactive mode
                } else {
                    // Non-interactive mode: Cmd + Arrow keys for window movement
                    this.moveWindow(e.key);
                }
            }
            
            // Alt+A is handled globally by the main process
            // No need to handle it here since it needs to work even when windows are non-interactive
        });
    }

    handleInteractionModeChanged(interactive) {
        logger.info('Handling interaction mode change', {
            component: 'MainWindowUI',
            newState: interactive,
            previousState: this.isInteractive
        });
        
        // Update the internal state
        this.isInteractive = interactive;
        
        // Update all UI elements to reflect the new state
        this.updateAllElementStates();

        // Auto-hide popover when leaving interactive mode
        if (!this.isInteractive && this.shortcutsPopover && this.shortcutsPopover.style.display !== 'none') {
            this.hideShortcutsPopover();
        }
        
        // Update skill indicator tooltip
        this.updateSkillIndicator();
        
        logger.info('Interaction mode change completed', {
            component: 'MainWindowUI',
            interactive: this.isInteractive,
            statusDotClass: this.statusDot ? this.statusDot.className : 'not found',
            skillIndicatorClass: this.skillIndicator ? this.skillIndicator.className : 'not found'
        });
    }

    handleSkillChanged(data) {
        const oldSkill = this.currentSkill;
        this.currentSkill = data.skill;
        
        logger.info('Handling skill change', {
            component: 'MainWindowUI',
            oldSkill: oldSkill,
            newSkill: data.skill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        this.updateSkillIndicator();
        
        logger.info('Skill changed successfully', {
            component: 'MainWindowUI',
            skill: data.skill
        });
    }

    handleSkillActivated(skillName) {
        this.currentSkill = skillName;
        this.updateSkillIndicator();
        
        logger.info('Skill activated', {
            component: 'MainWindowUI',
            skill: skillName
        });
    }

    handleScreenshotRequest() {
        logger.debug('Screenshot request received', { component: 'MainWindowUI' });
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.micButton) {
            this.micButton.classList.add('recording');
        }
        // 实际采集由主进程通过 executeJavaScript（带 userGesture）调用
        // startAudioCapture 触发：getDisplayMedia 需要用户激活才能执行。
        logger.debug('Recording started', { component: 'MainWindowUI' });
    }

    /**
     * 由主进程调用（带用户手势），按设置选择麦克风或系统音频作为输入源。
     */
    async startAudioCapture(source) {
        const mode = source === 'system' ? 'system' : 'microphone';
        this.audioInputSource = mode;
        this.isRecording = true;
        await this._startRendererAudioCapture(mode);
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.micButton) {
            this.micButton.classList.remove('recording');
        }
        this._stopRendererAudioCapture();
        logger.debug('Recording stopped', { component: 'MainWindowUI' });
    }

    /**
     * 采集音频并用 Web Audio 转成 16kHz 单声道 PCM，通过 audio-chunk
     * IPC 发给主进程。
     *
     * source === 'system' 时采集整机回环音频（Windows loopback），
     * 这样戴耳机也能拿到会议软件播放的面试官声音；否则采集麦克风。
     */
    async _startRendererAudioCapture(source = this.audioInputSource || 'microphone') {
        try {
            this._stopRendererAudioCapture();
            this.audioInputSource = source === 'system' ? 'system' : 'microphone';

            let stream;
            if (this.audioInputSource === 'system') {
                // 主进程的 setDisplayMediaRequestHandler 会直接返回整机
                // 回环音频，所以不会弹出画面选择框。
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { frameRate: 1 },
                    audio: true
                });
                // 只保留音频轨，视频轨立即释放
                stream.getVideoTracks().forEach((track) => track.stop());
                if (!stream.getAudioTracks().length) {
                    throw new Error('未获取到系统音频，请确认系统正在播放声音，且该平台支持回环采集');
                }
            } else {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        // 关闭回声消除与降噪：Windows 的 WebRTC 降噪会压制辅音和轻声，
                        // 导致转写出现缺字；自动增益保留以稳定音量。
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: true
                    }
                });
            }
            this._mediaStream = stream;

            // 使用设备原生采样率采集，重采样交给 worklet 里的低通 + 插值，
            // 避免依赖浏览器隐式重采样。
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this._audioContext = audioContext;
            if (audioContext.state === 'suspended') {
                await audioContext.resume().catch(() => {});
            }

            const sourceNode = audioContext.createMediaStreamSource(stream);
            this._sourceNode = sourceNode;

            const workletUrl = this._createWorkletUrl();
            this._workletUrl = workletUrl;
            await audioContext.audioWorklet.addModule(workletUrl);

            const workletNode = new AudioWorkletNode(audioContext, CAPTURE_WORKLET_NAME, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { targetRate: CAPTURE_TARGET_RATE }
            });
            this._workletNode = workletNode;

            workletNode.port.onmessage = (event) => {
                if (!this.isRecording || !window.electronAPI || !window.electronAPI.sendAudioChunk) {
                    return;
                }
                window.electronAPI.sendAudioChunk(event.data);
            };

            // worklet 本身不输出声音，经零增益节点接到 destination 以保持
            // 音频图被持续拉取。
            const muteNode = audioContext.createGain();
            muteNode.gain.value = 0;
            this._muteNode = muteNode;

            sourceNode.connect(workletNode);
            workletNode.connect(muteNode);
            muteNode.connect(audioContext.destination);

            logger.info('Renderer audio capture started', {
                component: 'MainWindowUI',
                source: this.audioInputSource,
                sampleRate: audioContext.sampleRate,
                targetRate: CAPTURE_TARGET_RATE
            });
        } catch (error) {
            logger.error('Failed to start renderer audio capture', {
                component: 'MainWindowUI',
                source: this.audioInputSource,
                error: error.message
            });
            // Notify main process so it can stop the recording state
            try {
                await window.electronAPI.stopSpeechRecognition();
            } catch (_) { /* ignore */ }
        }
    }

    _createWorkletUrl() {
        const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    _stopRendererAudioCapture() {
        try {
            if (this._workletNode) {
                this._workletNode.port.onmessage = null;
                this._workletNode.disconnect();
                this._workletNode = null;
            }
            if (this._muteNode) {
                this._muteNode.disconnect();
                this._muteNode = null;
            }
            if (this._sourceNode) {
                this._sourceNode.disconnect();
                this._sourceNode = null;
            }
            if (this._workletUrl) {
                URL.revokeObjectURL(this._workletUrl);
                this._workletUrl = null;
            }
            if (this._mediaStream) {
                this._mediaStream.getTracks().forEach((track) => track.stop());
                this._mediaStream = null;
            }
            if (this._audioContext) {
                this._audioContext.close().catch(() => {});
                this._audioContext = null;
            }
            if (this._captureInterval) {
                clearInterval(this._captureInterval);
                this._captureInterval = null;
            }
        } catch (error) {
            logger.error('Error stopping renderer audio capture', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    updateSkillIndicator() {
        const skillNames = {
            'dsa': 'DSA',
            'interview': 'Interview',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        logger.info('Updating skill indicator', {
            component: 'MainWindowUI',
            currentSkill: this.currentSkill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        if (!this.skillIndicator) {
            logger.error('Skill indicator element not found!');
            return;
        }
        
        const skillName = skillNames[this.currentSkill] || this.currentSkill.toUpperCase();
        const skillSpan = this.skillIndicator.querySelector('span');
        
        logger.info('Looking for skill span element', {
            component: 'MainWindowUI',
            spanExists: !!skillSpan,
            skillName: skillName
        });
        
        if (skillSpan) {
            const oldText = skillSpan.textContent;
            skillSpan.textContent = skillName;
                        
            const tooltip = this.isInteractive ? 
                `${skillName} - 点击切换技能` : 
                `${skillName} - 启用交互模式 (Alt+A) 后可切换`;
            this.skillIndicator.title = tooltip;
            
            // Add visual feedback for skill change
            this.animateSkillChange();
            
            logger.info('Skill indicator updated successfully', {
                component: 'MainWindowUI',
                oldText: oldText,
                newText: skillName,
                interactive: this.isInteractive
            });
        } else {
            logger.error('Skill span element not found within skill indicator!');
        }
    }

    animateSkillChange() {
        if (this.skillIndicator) {
            this.skillIndicator.style.transform = 'scale(1.1)';
            this.skillIndicator.style.transition = 'transform 0.2s ease';
            
            setTimeout(() => {
                this.skillIndicator.style.transform = 'scale(1)';
            }, 200);
        }
    }

    navigateSkill(direction) {
        
        if (!this.isInteractive) {
            return;
        }
        
        const currentIndex = this.availableSkills.indexOf(this.currentSkill);
        if (currentIndex === -1) {
            logger.error('Current skill not found in available skills array');
            return;
        }
        
        // Calculate new index with wrapping
        let newIndex = currentIndex + direction;
        if (newIndex >= this.availableSkills.length) {
            newIndex = 0; // Wrap to beginning
        } else if (newIndex < 0) {
            newIndex = this.availableSkills.length - 1; // Wrap to end
        }
        
        const newSkill = this.availableSkills[newIndex];
        
        // Update skill locally and notify main process
        this.currentSkill = newSkill;
        this.updateSkillIndicator();
        
        // Save the skill change via IPC
        if (window.electronAPI && window.electronAPI.updateActiveSkill) {
            window.electronAPI.updateActiveSkill(newSkill).then(() => {
                logger.info('Skill navigation completed', {
                    component: 'MainWindowUI',
                    newSkill,
                    direction: direction > 0 ? 'down' : 'up'
                });
            }).catch(error => {
                logger.error('Failed to update skill via navigation', {
                    component: 'MainWindowUI',
                    error: error.message
                });
            });
        }
        
        // Show visual feedback
        this.showSkillChangeNotification(newSkill, direction);
    }

    showSkillChangeNotification(skill, direction) {
        const skillNames = {
            'dsa': 'DSA',
            'interview': 'Interview',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displayName = skillNames[skill] || skill.toUpperCase();
        const arrow = direction > 0 ? '↓' : '↑';
        
        // Create temporary notification
        const notification = document.createElement('div');
        notification.className = 'skill-change-notification';
        notification.innerHTML = `${arrow} ${displayName}`;
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.2s ease;
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        // Remove after 1 second
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 200);
        }, 1000);
    }

    showHiddenIndicator() {
        const indicator = document.querySelector('.hidden-indicator');
        if (indicator) {
            indicator.classList.add('show');
            setTimeout(() => {
                indicator.classList.remove('show');
            }, 3000);
        }
    }

    toggleInteractiveMode() {
        this.isInteractive = !this.isInteractive;
        this.updateAllElementStates();
        
        logger.debug('Interactive mode toggled', {
            component: 'MainWindowUI',
            interactive: this.isInteractive
        });
    }

    moveWindow(direction) {
        const moveDistance = 20; // pixels
        
        if (window.electronAPI && window.electronAPI.moveWindow) {
            let deltaX = 0, deltaY = 0;
            
            switch(direction) {
                case 'ArrowUp':
                    deltaY = -moveDistance;
                    break;
                case 'ArrowDown':
                    deltaY = moveDistance;
                    break;
                case 'ArrowLeft':
                    deltaX = -moveDistance;
                    break;
                case 'ArrowRight':
                    deltaX = moveDistance;
                    break;
            }
            
            window.electronAPI.moveWindow(deltaX, deltaY);
            logger.debug('Moving window', {
                component: 'MainWindowUI',
                direction: direction,
                deltaX: deltaX,
                deltaY: deltaY,
                interactive: this.isInteractive
            });
        } else {
            logger.warn('moveWindow API not available', { component: 'MainWindowUI' });
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 p-4 rounded-lg text-white z-50 ${
            type === 'error' ? 'bg-red-600' : 
            type === 'success' ? 'bg-green-600' :
            'bg-blue-600'
        }`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
        
        logger.debug('Notification shown', {
            component: 'MainWindowUI',
            message,
            type
        });
    }

    async showDeepseekConfig() {
        try {
            const status = await window.electronAPI.getDeepseekStatus();
            
            const modal = this.createDeepseekConfigModal(status);
            document.body.appendChild(modal);
            
            logger.debug('DeepSeek config modal shown', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to show DeepSeek config', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to load DeepSeek configuration', 'error');
        }
    }

    createDeepseekConfigModal(status) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-gray-900 text-white p-6 rounded-lg max-w-md w-full">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-xl font-bold">🤖 DeepSeek Configuration</h2>
                    <button class="text-gray-400 hover:text-white" onclick="this.closest('.fixed').remove()">✕</button>
                </div>
                
                <div class="mb-4 p-3 rounded ${status.hasApiKey ? 'bg-green-900' : 'bg-red-900'}">
                    <p><strong>Status:</strong> ${status.hasApiKey ? 'Configured' : 'Not Configured'}</p>
                    <p><strong>Model:</strong> ${status.model}</p>
                </div>
                
                <div class="mb-4">
                    <label class="block text-sm font-medium mb-2">API Key:</label>
                    <input type="password" id="deepseekApiKey" placeholder="Enter your DeepSeek API key" 
                           class="w-full p-2 bg-gray-800 border border-gray-600 rounded text-white">
                    <p class="text-xs text-gray-400 mt-1">
                        Get your API key from: <a href="https://platform.deepseek.com/api_keys" target="_blank" class="text-blue-400">DeepSeek Platform</a>
                    </p>
                </div>
                
                <div class="flex space-x-2">
                    <button onclick="mainWindowUI.configureDeepseek()" class="flex-1 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">
                        Configure
                    </button>
                    <button onclick="mainWindowUI.testDeepseekConnection()" class="flex-1 bg-green-600 hover:bg-green-700 px-4 py-2 rounded">
                        Test Connection
                    </button>
                </div>
                
                <div class="mt-4 text-center">
                    <button class="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded" onclick="this.closest('.fixed').remove()">
                        Close
                    </button>
                </div>
            </div>
        `;
        return modal;
    }

    async configureDeepseek() {
        const apiKey = document.getElementById('deepseekApiKey').value.trim();
        if (!apiKey) {
            this.showNotification('Please enter an API key', 'error');
            return;
        }
        
        try {
            const result = await window.electronAPI.setDeepseekApiKey(apiKey);
            if (result.success) {
                this.showNotification('DeepSeek API key configured successfully!', 'success');
                document.querySelector('.fixed').remove();
                
                logger.info('DeepSeek API key configured', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Configuration failed: ${result.error}`, 'error');
                logger.error('DeepSeek configuration failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('DeepSeek configuration error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async testDeepseekConnection() {
        try {
            const result = await window.electronAPI.testDeepseekConnection();
            if (result.success) {
                this.showNotification('DeepSeek connection test successful!', 'success');
                logger.info('DeepSeek connection test successful', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Connection test failed: ${result.error}`, 'error');
                logger.error('DeepSeek connection test failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('DeepSeek connection test error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    setupSettingsShortcut() {
        document.addEventListener('keydown', (e) => {
            // Cmd+, or Ctrl+, for settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                logger.debug('Settings keyboard shortcut pressed');
                e.preventDefault();
                this.openSettings();
            }
        });
    }

    openSettings() {
        try {
            if (window.electronAPI && window.electronAPI.showSettings) {
                window.electronAPI.showSettings();
            } else {
                logger.error('electronAPI or showSettings not available');
                return;
            }
            
            // Add visual feedback
            if (this.settingsIndicator) {
                this.settingsIndicator.style.transform = 'scale(1.1)';
                this.settingsIndicator.style.transition = 'transform 0.2s ease';
                
                setTimeout(() => {
                    this.settingsIndicator.style.transform = 'scale(1)';
                }, 200);
            }
            
            logger.info('Settings window opened', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to open settings', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to open settings', 'error');
        }
    }

    showSettingsMenu() {
        const menu = document.createElement('div');
        menu.className = 'settings-menu';
        menu.style.cssText = `
            position: absolute;
            right: 10px;
            top: 35px;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 8px 0;
            min-width: 150px;
            z-index: 1000;
        `;

        const settingsOption = this.createMenuItem('Settings', 'fa-cog', () => {
            this.openSettings();
            document.body.removeChild(menu);
        });

        const quitOption = this.createMenuItem('Quit OpenCluely', 'fa-power-off', () => {
            if (window.electronAPI && window.electronAPI.quit) {
                window.electronAPI.quit();
            }
        });

        menu.appendChild(settingsOption);
        menu.appendChild(this.createMenuSeparator());
        menu.appendChild(quitOption);

        // Add click outside listener to close menu
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !this.settingsIndicator.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);

        document.body.appendChild(menu);
    }

    createMenuItem(text, iconClass, onClick) {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 8px 16px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        `;
        item.innerHTML = `<i class="fas ${iconClass}"></i>${text}`;
        item.addEventListener('mouseover', () => {
            item.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        item.addEventListener('mouseout', () => {
            item.style.background = 'transparent';
        });
        item.addEventListener('click', onClick);
        return item;
    }

    createMenuSeparator() {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
            margin: 8px 0;
        `;
        return separator;
    }

    toggleShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    const isOpen = this.shortcutsPopover.classList.contains('is-open');
    if (!isOpen) {
            this.showShortcutsPopover();
        } else {
            this.hideShortcutsPopover();
        }
    }

    showShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) {
            clearTimeout(this._popoverHideTimeout);
            this._popoverHideTimeout = null;
        }
    this.shortcutsPopover.classList.add('is-open');
        // Resize main window to fit popover
        setTimeout(() => this.resizeWindowToContent(), 50);
    }

    hideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    this.shortcutsPopover.classList.remove('is-open');
    // resize back to compact after transition
    setTimeout(() => this.resizeWindowToContent(), 130);
    }

    queueHideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) clearTimeout(this._popoverHideTimeout);
        this._popoverHideTimeout = setTimeout(() => this.hideShortcutsPopover(), 180);
    }
}

// Initialize when DOM is ready
let mainWindowUI;
if (typeof document !== 'undefined') {
    // Add immediate visual indicator that script is loading
    const style = document.createElement('style');
    document.head.appendChild(style);
    
    document.addEventListener('DOMContentLoaded', () => {
                
        mainWindowUI = new MainWindowUI();
        // Make it globally accessible for debugging
        window.mainWindowUI = mainWindowUI;
        logger.info('MainWindowUI initialized and available as window.mainWindowUI');
    });
}

// module.exports = MainWindowUI; // Not needed in browser context