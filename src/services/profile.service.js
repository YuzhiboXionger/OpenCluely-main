const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('PROFILE');

// 存储上限与注入上限分开：文件里保存较完整的解析文本，发送给模型时
// 只截取前若干字符，避免每次请求的 token 失控。
const STORE_LIMITS = {
  jobTitle: 100,
  jobDescription: 5000,
  resumeText: 100000
};
const INJECT_LIMITS = {
  jobTitle: 100,
  jobDescription: 1500,
  resumeText: 4000
};
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function resolveProfilePath() {
  try {
    // 该模块在 app.setName('Terminal ') 之前被 require，此时 userData
    // 仍是默认应用名，与 main.js 中 ENV_PATH 的解析时机一致。
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'profile.json');
    }
  } catch (_) {
    // 非 Electron 环境（例如脚本调试）走下面的兜底路径
  }
  return path.join(os.homedir(), '.OpenCluely', 'profile.json');
}

function emptyProfile() {
  return {
    jobTitle: '',
    jobDescription: '',
    resume: null,
    injectResume: true,
    updatedAt: null
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value, max) {
  const text = String(value || '');
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

class ProfileService {
  constructor() {
    this.profilePath = resolveProfilePath();
    this.profile = null;
  }

  _ensureLoaded() {
    if (this.profile) return this.profile;

    try {
      const raw = fs.readFileSync(this.profilePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.profile = this._normalizeProfile(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Failed to read profile.json, using defaults', { error: error.message });
      }
      this.profile = emptyProfile();
    }
    return this.profile;
  }

  _normalizeProfile(input) {
    const profile = emptyProfile();
    if (!input || typeof input !== 'object') return profile;

    profile.jobTitle = cleanText(input.jobTitle).slice(0, STORE_LIMITS.jobTitle);
    profile.jobDescription = cleanText(input.jobDescription).slice(0, STORE_LIMITS.jobDescription);
    profile.injectResume = input.injectResume !== false;
    profile.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : null;

    if (input.resume && typeof input.resume === 'object') {
      const text = cleanText(input.resume.text).slice(0, STORE_LIMITS.resumeText);
      if (text) {
        profile.resume = {
          fileName: cleanText(input.resume.fileName).slice(0, 255),
          text,
          charCount: text.length,
          importedAt: typeof input.resume.importedAt === 'string'
            ? input.resume.importedAt
            : new Date().toISOString()
        };
      }
    }

    return profile;
  }

  _write(profile) {
    const dir = path.dirname(this.profilePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.profilePath}.tmp`;
    const payload = JSON.stringify(profile, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch (_) {
      // Windows 上 chmod 语义有限，失败不阻塞保存
    }
    // 原子替换，避免写入中途崩溃留下损坏的 JSON。
    fs.renameSync(tmpPath, this.profilePath);
  }

  getProfile() {
    const profile = this._ensureLoaded();
    return {
      jobTitle: profile.jobTitle,
      jobDescription: profile.jobDescription,
      injectResume: profile.injectResume,
      updatedAt: profile.updatedAt,
      resume: profile.resume
        ? {
            fileName: profile.resume.fileName,
            text: profile.resume.text,
            charCount: profile.resume.charCount,
            importedAt: profile.resume.importedAt
          }
        : null
    };
  }

  /** 供 getSettings 使用的轻量摘要，不把简历全文发给每个窗口。 */
  getSummary() {
    const profile = this._ensureLoaded();
    return {
      jobTitle: profile.jobTitle,
      jobDescription: profile.jobDescription,
      injectResume: profile.injectResume,
      resumeMeta: profile.resume
        ? {
            fileName: profile.resume.fileName,
            charCount: profile.resume.charCount,
            importedAt: profile.resume.importedAt
          }
        : null
    };
  }

  /**
   * 保存岗位、JD、开关与简历。字段为 undefined 表示不修改；
   * resume 传 null 表示删除简历。
   */
  update(patch = {}) {
    const profile = this._ensureLoaded();
    let changed = false;

    if (patch.jobTitle !== undefined) {
      profile.jobTitle = cleanText(patch.jobTitle).slice(0, STORE_LIMITS.jobTitle);
      changed = true;
    }
    if (patch.jobDescription !== undefined) {
      profile.jobDescription = cleanText(patch.jobDescription).slice(0, STORE_LIMITS.jobDescription);
      changed = true;
    }
    if (patch.injectResume !== undefined) {
      profile.injectResume = patch.injectResume !== false;
      changed = true;
    }
    if (patch.resume !== undefined) {
      if (patch.resume === null) {
        profile.resume = null;
      } else if (patch.resume && typeof patch.resume === 'object') {
        const text = cleanText(patch.resume.text).slice(0, STORE_LIMITS.resumeText);
        if (!text) {
          throw new Error('简历内容为空，无法保存');
        }
        profile.resume = {
          fileName: cleanText(patch.resume.fileName).slice(0, 255) || 'resume.pdf',
          text,
          charCount: text.length,
          importedAt: patch.resume.importedAt || new Date().toISOString()
        };
      } else {
        throw new Error('无效的简历数据');
      }
      changed = true;
    }

    if (changed) {
      profile.updatedAt = new Date().toISOString();
      this._write(profile);
      logger.info('Profile saved', {
        jobTitleLength: profile.jobTitle.length,
        jdLength: profile.jobDescription.length,
        resumeChars: profile.resume ? profile.resume.charCount : 0,
        injectResume: profile.injectResume
      });
    }

    return this.getProfile();
  }

  clearResume() {
    return this.update({ resume: null });
  }

  /**
   * 解析 PDF 并返回文本，不落盘；由设置页确认后再随 save-settings 保存。
   */
  async parsePdfFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('未选择文件');
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') {
      throw new Error('首版仅支持 PDF 文件');
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      throw new Error(`无法读取文件：${error.message}`);
    }
    if (!stat.isFile()) {
      throw new Error('请选择有效的文件');
    }
    if (stat.size > MAX_PDF_BYTES) {
      throw new Error('PDF 文件过大（上限 10 MB）');
    }

    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 5 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error('文件不是有效的 PDF');
    }

    let pdfParse;
    try {
      pdfParse = require('pdf-parse');
    } catch (_) {
      throw new Error('PDF 解析组件未安装，请先在项目目录运行 npm install');
    }

    const result = await pdfParse(buffer);
    const text = cleanText(result && result.text);

    if (!text || text.length < 20) {
      throw new Error('未能从 PDF 中提取文字，可能是扫描件或加密文件；请改用可复制文字的 PDF');
    }

    const capped = text.slice(0, STORE_LIMITS.resumeText);
    logger.info('Resume PDF parsed', {
      fileName: path.basename(filePath),
      bytes: stat.size,
      chars: capped.length,
      pages: result && result.numpages
    });

    return {
      fileName: path.basename(filePath),
      text: capped,
      charCount: capped.length,
      importedAt: new Date().toISOString()
    };
  }

  /**
   * 生成注入到聊天 / 语音请求的 system 上下文。
   * 关闭开关或档案为空时返回空字符串，不产生额外 token。
   */
  getContextBlock() {
    const profile = this._ensureLoaded();
    if (!profile.injectResume) return '';

    const title = truncate(profile.jobTitle, INJECT_LIMITS.jobTitle);
    const jd = truncate(profile.jobDescription, INJECT_LIMITS.jobDescription);
    const resume = truncate(profile.resume ? profile.resume.text : '', INJECT_LIMITS.resumeText);

    if (!title.text && !jd.text && !resume.text) return '';

    const parts = ['## 候选人背景（仅作参考）'];
    if (title.text) parts.push(`目标岗位：${title.text}`);
    if (jd.text) {
      parts.push(`岗位 JD（节选${jd.truncated ? '，已截断' : ''}）：\n${jd.text}`);
    }
    if (resume.text) {
      parts.push(`简历（节选${resume.truncated ? '，已截断' : ''}）：\n${resume.text}`);
    }

    parts.push(
      `使用规则：
1. 当问题涉及岗位、经历、项目、技术栈或行为面试时，优先使用上述真实信息作答。
2. 不得编造简历中不存在的学历、公司、项目、职责、技术栈或数据。
3. 与背景无关时忽略本段，不要强行关联。
4. 代码与算法题仍遵守所选语言的输出约束，给出复杂度，不要编造未提及的经历。`
    );

    return parts.join('\n\n');
  }
}

module.exports = new ProfileService();
module.exports.ProfileService = ProfileService;
