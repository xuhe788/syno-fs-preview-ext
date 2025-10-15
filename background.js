// background.js (MV3 service worker)
// 动态按【选项页配置的 host】注册 content scripts，仅在指定站点注入

const KEY = 'sites'; // [{ host: string, port?: string, enabled: boolean }]
const SCRIPT_ID = 'fs-preview-content';

const contentResources = {
  css: [
    'lib/plyr.css',
    'lib/hljs-github.min.css',
    'lib/fs-preview.css',
  ],
  js: [
    // Markdown + 安全 + 代码高亮
    'lib/marked.min.js',
    'lib/purify.min.js',
    'lib/highlight.min.js',
    'lib/plyr.polyfilled.min.js',
    'lib/heic2any.min.js',
    'lib/hls.min.js',
    'content.js',
  ],
};

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }

function buildMatchesFromSites(sites) {
  // Chrome URL 匹配模式不支持端口限定，因此这里仅按 host 生成模式
  // 端口校验继续由 content.js 在运行时二次判断
  const enabledHosts = uniq(
    (sites || [])
      .filter(s => s && s.enabled && s.host)
      .map(s => String(s.host).trim().toLowerCase())
  );
  const matches = [];
  for (const host of enabledHosts) {
    // 简单校验 host（允许 IP / 域名），不支持通配符输入
    if (/^[*]/.test(host)) continue; // 忽略用户误填通配符
    matches.push(`https://${host}/*`);
    matches.push(`http://${host}/*`);
  }
  return uniq(matches);
}

async function refreshRegisteredContentScripts() {
  try {
    const { [KEY]: sites } = await chrome.storage.local.get(KEY);
    const matches = buildMatchesFromSites(Array.isArray(sites) ? sites : []);

    // 先卸载旧脚本
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts();
      const exists = existing.some(e => e.id === SCRIPT_ID);
      if (exists) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    } catch (_) {}

    if (!matches.length) return; // 未配置任何站点则不注册

    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        runAt: 'document_start',
        css: contentResources.css,
        js: contentResources.js,
        allFrames: false,
        world: 'ISOLATED',
      },
    ]);
  } catch (err) {
    // 静默处理，必要时可打开日志
    // console.warn('[fs-preview] register content scripts failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  refreshRegisteredContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  refreshRegisteredContentScripts();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  refreshRegisteredContentScripts();
});
