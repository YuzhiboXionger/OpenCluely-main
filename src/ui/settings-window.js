document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechResponseTargetSelect = document.getElementById('speechResponseTarget');
    const audioInputSourceSelect = document.getElementById('audioInputSource');
    const doubaoApiKeyInput = document.getElementById('doubaoApiKey');
    const doubaoAppIdInput = document.getElementById('doubaoAppId');
    const doubaoAccessTokenInput = document.getElementById('doubaoAccessToken');
    const doubaoResourceIdSelect = document.getElementById('doubaoResourceId');
    const doubaoEnableNonstreamInput = document.getElementById('doubaoEnableNonstream');
    const deepseekKeyInput = document.getElementById('deepseekKey');
    const windowGapInput = document.getElementById('windowGap');
    const answerOpacityInput = document.getElementById('answerOpacity');
    const answerOpacityValue = document.getElementById('answerOpacityValue');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');
    const jobTitleInput = document.getElementById('jobTitle');
    const jobDescriptionInput = document.getElementById('jobDescription');
    const injectResumeInput = document.getElementById('injectResume');
    const uploadResumeButton = document.getElementById('uploadResumeButton');
    const removeResumeButton = document.getElementById('removeResumeButton');
    const resumeStatus = document.getElementById('resumeStatus');
    const resumeTextInput = document.getElementById('resumeText');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
        requestProfile();
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (speechResponseTargetSelect) speechResponseTargetSelect.value = settings.speechResponseTarget || 'both';
        if (audioInputSourceSelect) audioInputSourceSelect.value = settings.audioInputSource || 'microphone';
        if (doubaoApiKeyInput) doubaoApiKeyInput.value = settings.doubaoApiKey || '';
        if (doubaoAppIdInput) doubaoAppIdInput.value = settings.doubaoAppId || '';
        if (doubaoAccessTokenInput) doubaoAccessTokenInput.value = settings.doubaoAccessToken || '';
        if (doubaoResourceIdSelect) {
            doubaoResourceIdSelect.value = settings.doubaoResourceId || 'volc.seedasr.sauc.duration';
        }
        if (doubaoEnableNonstreamInput) {
            doubaoEnableNonstreamInput.checked = String(settings.doubaoEnableNonstream) !== 'false';
        }
        if (deepseekKeyInput) deepseekKeyInput.value = settings.deepseekKey || '';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';
        if (answerOpacityInput) {
            const opacity = Number(settings.answerOpacity);
            answerOpacityInput.value = Number.isFinite(opacity) ? opacity : 40;
            if (answerOpacityValue) answerOpacityValue.textContent = answerOpacityInput.value + '%';
        }

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Job title / JD / injection toggle (resume text is loaded separately
        // via getProfile so the full text only goes to this window).
        if (jobTitleInput && settings.jobTitle !== undefined) jobTitleInput.value = settings.jobTitle || '';
        if (jobDescriptionInput && settings.jobDescription !== undefined) {
            jobDescriptionInput.value = settings.jobDescription || '';
        }
        if (injectResumeInput && settings.injectResume !== undefined) {
            injectResumeInput.checked = settings.injectResume !== false;
        }

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // ── Candidate profile: job title / JD / resume ──
    let profileLoaded = false;
    let currentResume = null;
    let resumeDirty = false;

    const formatResumeTime = (iso) => {
        if (!iso) return '';
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };

    const updateResumeStatus = () => {
        if (!resumeStatus) return;
        if (currentResume && currentResume.text) {
            const count = resumeTextInput ? resumeTextInput.value.length : currentResume.charCount;
            const time = formatResumeTime(currentResume.importedAt);
            resumeStatus.textContent = `${currentResume.fileName} · ${count} 字${time ? ' · ' + time : ''}`;
        }
    };

    const renderResume = () => {
        if (!resumeStatus) return;
        if (currentResume && currentResume.text) {
            updateResumeStatus();
            resumeStatus.classList.remove('is-error');
            if (resumeTextInput) {
                resumeTextInput.value = currentResume.text;
                resumeTextInput.style.display = '';
            }
            if (removeResumeButton) removeResumeButton.style.display = '';
        } else {
            resumeStatus.textContent = '尚未上传简历';
            resumeStatus.classList.remove('is-error');
            if (resumeTextInput) {
                resumeTextInput.value = '';
                resumeTextInput.style.display = 'none';
            }
            if (removeResumeButton) removeResumeButton.style.display = 'none';
        }
    };

    const showResumeError = (message) => {
        if (!resumeStatus) return;
        resumeStatus.textContent = message;
        resumeStatus.classList.add('is-error');
    };

    const applyProfile = (profile) => {
        if (!profile) return;
        if (jobTitleInput) jobTitleInput.value = profile.jobTitle || '';
        if (jobDescriptionInput) jobDescriptionInput.value = profile.jobDescription || '';
        if (injectResumeInput) injectResumeInput.checked = profile.injectResume !== false;
        currentResume = profile.resume || null;
        resumeDirty = false;
        renderResume();
        profileLoaded = true;
    };

    const requestProfile = () => {
        if (!window.electronAPI || typeof window.electronAPI.getProfile !== 'function') return;
        window.electronAPI.getProfile().then(result => {
            if (result && result.success) {
                applyProfile(result.profile);
            } else if (result && result.error) {
                logger.info('Failed to load profile:', result.error);
            }
        }).catch(error => {
            console.error('Failed to get profile:', error);
        });
    };

    const saveProfileFields = () => {
        if (!profileLoaded || !window.electronAPI || typeof window.electronAPI.saveSettings !== 'function') {
            return Promise.resolve({ success: true });
        }
        const payload = {
            jobTitle: jobTitleInput ? jobTitleInput.value : '',
            jobDescription: jobDescriptionInput ? jobDescriptionInput.value : '',
            injectResume: injectResumeInput ? injectResumeInput.checked : true
        };
        if (resumeDirty) {
            payload.resume = currentResume ? {
                fileName: currentResume.fileName,
                text: resumeTextInput ? resumeTextInput.value : currentResume.text,
                importedAt: currentResume.importedAt
            } : null;
        }
        return window.electronAPI.saveSettings(payload).then(result => {
            if (!result || result.success === false) {
                throw new Error((result && result.error) || '保存失败');
            }
            resumeDirty = false;
            if (resumeStatus) resumeStatus.classList.remove('is-error');
            updateResumeStatus();
            return result;
        }).catch(error => {
            showResumeError(`保存失败：${error.message}`);
            throw error;
        });
    };

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechResponseTargetSelect) settings.speechResponseTarget = speechResponseTargetSelect.value;
        if (audioInputSourceSelect) settings.audioInputSource = audioInputSourceSelect.value;
        if (doubaoApiKeyInput) settings.doubaoApiKey = doubaoApiKeyInput.value;
        if (doubaoAppIdInput) settings.doubaoAppId = doubaoAppIdInput.value;
        if (doubaoAccessTokenInput) settings.doubaoAccessToken = doubaoAccessTokenInput.value;
        if (doubaoResourceIdSelect) settings.doubaoResourceId = doubaoResourceIdSelect.value;
        if (doubaoEnableNonstreamInput) settings.doubaoEnableNonstream = doubaoEnableNonstreamInput.checked;
        if (deepseekKeyInput) settings.deepseekKey = deepseekKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (answerOpacityInput) settings.answerOpacity = answerOpacityInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        
        window.api.send('save-settings', settings);
    };

    // Add event listeners for all inputs
    const inputs = [
        speechResponseTargetSelect,
        audioInputSourceSelect,
        doubaoApiKeyInput,
        doubaoAppIdInput,
        doubaoAccessTokenInput,
        doubaoResourceIdSelect,
        doubaoEnableNonstreamInput,
        deepseekKeyInput,
        windowGapInput,
        answerOpacityInput
    ];

    // Live preview while dragging the slider; the value is persisted on change.
    if (answerOpacityInput) {
        answerOpacityInput.addEventListener('input', () => {
            const value = answerOpacityInput.value;
            if (answerOpacityValue) answerOpacityValue.textContent = value + '%';
            if (window.electronAPI && typeof window.electronAPI.previewAnswerOpacity === 'function') {
                window.electronAPI.previewAnswerOpacity(value);
            }
        });
    }

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    // ── Profile field listeners ──
    if (uploadResumeButton) {
        uploadResumeButton.addEventListener('click', async () => {
            if (!window.electronAPI || typeof window.electronAPI.pickResumeFile !== 'function') {
                showResumeError('当前版本不支持上传简历');
                return;
            }
            const originalHTML = uploadResumeButton.innerHTML;
            uploadResumeButton.disabled = true;
            uploadResumeButton.innerHTML = '解析中…';
            try {
                const result = await window.electronAPI.pickResumeFile();
                if (!result || result.canceled) return;
                if (!result.success) {
                    showResumeError(result.error || '简历解析失败');
                    return;
                }
                currentResume = result.resume;
                resumeDirty = true;
                renderResume();
                await saveProfileFields();
            } catch (error) {
                showResumeError(`简历导入失败：${error.message}`);
            } finally {
                uploadResumeButton.disabled = false;
                uploadResumeButton.innerHTML = originalHTML;
            }
        });
    }

    if (removeResumeButton) {
        removeResumeButton.addEventListener('click', async () => {
            currentResume = null;
            resumeDirty = true;
            renderResume();
            try {
                await saveProfileFields();
            } catch (_) {
                // 错误已显示在状态行
            }
        });
    }

    if (resumeTextInput) {
        resumeTextInput.addEventListener('input', () => {
            if (!currentResume) return;
            currentResume.text = resumeTextInput.value;
            resumeDirty = true;
            updateResumeStatus();
        });
        resumeTextInput.addEventListener('blur', () => {
            if (!resumeDirty) return;
            saveProfileFields().catch(() => {
                // 错误已显示在状态行
            });
        });
    }

    [jobTitleInput, jobDescriptionInput, injectResumeInput].forEach(input => {
        if (!input) return;
        input.addEventListener('change', () => {
            saveProfileFields().catch(() => {
                // 错误已显示在状态行
            });
        });
    });

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: '终端', src: './assests/icons/terminal.png' },
            { key: 'activity', name: '活动', src: './assests/icons/activity.png' },
            { key: 'settings', name: '设置', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
