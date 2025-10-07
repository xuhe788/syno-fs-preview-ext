// page-hook.js（运行在页面上下文）
(function(){
  try {
    let capture = false;
    const origOpen = window.open;

    window.addEventListener('message', (e) => {
      try {
        if (e.source !== window || !e.data) return;
        if (e.data.type === 'FS_CAPTURE_ON')  capture = true;
        if (e.data.type === 'FS_CAPTURE_OFF') capture = false;
      } catch (_) {}
    });

    window.open = function(url, ...args){
      try {
        if (capture && url) {
          // 把捕获到的 URL 发给 content script
          window.postMessage({ type: 'FS_CAPTURED', url }, '*');
          return null; // 阻止真正打开窗口
        }
      } catch(_) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) {
    console.error('page-hook injection error', e);
  }
})();
