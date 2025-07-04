// ==UserScript==
// @name          B站评论弹幕监控助手
// @name:zh-CN    B站评论弹幕监控助手
// @name:en       Bilibili Comment & Danmaku Monitor
// @namespace     https://scriptcat.org/users/naaammme
// @version       1.1.1
// @description   实时监控并记录B站评论和弹幕，优化版本降低风控检测风险(可能有兼容问题)。
// @author        naaaammme
// @match         *://*.bilibili.com/*
// @icon          https://www.bilibili.com/favicon.ico
// @grant         none
// @run-at        document-end
// @license       AGPL-3.0-or-later
// @homepage      https://github.com/naaammme/bili-monitor
// @supportURL    https://github.com/naaammme/bili-monitor/issues
// ==/UserScript==
(() => {
  "use strict";

  // ===== 配置参数 =====
  const STORAGE_CONFIG = {
    // localStorage存储数量限制
    LOCALSTORAGE_LIMIT: 5000,

    // 内存中数据量限制
    MEMORY_LIMIT_COMMENTS: 2000,  // 评论内存限制
    MEMORY_LIMIT_DANMAKU: 2000,   // 弹幕内存限制

    // 界面显示数量限制
    DISPLAY_LIMIT: 100,

    // 导出数据来源：'localStorage' 或 'memory'
    EXPORT_SOURCE: 'localStorage'
  };

  let capturedComments = [];
  let capturedDanmaku = [];
  let pendingComments = new Map();

  const processedRequests = new Map();
  const REQUEST_CACHE_TIME = 5000;

  const CACHE_KEYS = {
    comments: 'bili_monitor_comments',
    danmaku: 'bili_monitor_danmaku'
  };

  const API_CONFIG = {
    danmaku: ['/dm/post', '/dmpost'],
    comment: ['/reply/add', '/reply/post', '/v2/reply/add', '/comment/post', '/x/v2/reply/add']
  };

  function loadCachedData() {
    try {
      capturedComments = JSON.parse(localStorage.getItem(CACHE_KEYS.comments) || '[]');
      capturedDanmaku = JSON.parse(localStorage.getItem(CACHE_KEYS.danmaku) || '[]');
      console.log(`缓存加载完成 - 评论:${capturedComments.length} 弹幕:${capturedDanmaku.length}`);
    } catch (e) {
      console.error('缓存数据加载失败:', e);
    }
  }

  function saveToCache() {
    try {
      localStorage.setItem(CACHE_KEYS.comments, JSON.stringify(capturedComments.slice(-STORAGE_CONFIG.LOCALSTORAGE_LIMIT)));
      localStorage.setItem(CACHE_KEYS.danmaku, JSON.stringify(capturedDanmaku.slice(-STORAGE_CONFIG.LOCALSTORAGE_LIMIT)));
    } catch (e) {
      console.error('保存缓存失败:', e);
    }
  }

  function log(msg, data = null) {
    console.log(`[BiliMonitor ${new Date().toLocaleTimeString()}] ${msg}`, data || '');
  }

  function generateRequestId(url, data) {
    const timestamp = Date.now();
    const dataStr = typeof data === 'string' ? data.substring(0, 100) : '';
    return `${url}-${dataStr}-${timestamp}`;
  }

  function shouldProcessRequest(requestId) {
    if (processedRequests.has(requestId)) {
      return false;
    }

    processedRequests.set(requestId, Date.now());

    setTimeout(() => {
      processedRequests.delete(requestId);
    }, REQUEST_CACHE_TIME);

    return true;
  }

  function cleanupRequestCache() {
    const now = Date.now();
    for (const [id, time] of processedRequests) {
      if (now - time > REQUEST_CACHE_TIME) {
        processedRequests.delete(id);
      }
    }
  }

  setInterval(cleanupRequestCache, 10000);

  function extractImageInfo(data) {
    const images = [];

    if (data && data.pictures) {
      try {
        let picturesData = data.pictures;

        if (typeof picturesData === 'string') {
          try {
            picturesData = JSON.parse(picturesData);
          } catch (e) {
            return { images: [] };
          }
        }

        if (Array.isArray(picturesData)) {
          picturesData.forEach((img, index) => {
            if (img && img.img_src && typeof img.img_src === 'string') {
              images.push({
                url: img.img_src,
                width: img.img_width || 0,
                height: img.img_height || 0,
                size: img.img_size || 0,
                index: index
              });
            }
          });
        }
      } catch (e) {
        console.error('解析pictures失败:', e);
      }
    }

    return { images };
  }

  function createFloatingBall() {
    const ball = document.createElement('div');
    ball.id = 'bili-monitor-ball';
    ball.innerHTML = '💖';
    ball.style.cssText = `
      position: fixed;
      top: 100px;
      right: 20px;
      width: 45px;
      height: 45px;
      background: linear-gradient(135deg, #00a1d6 0%, #f25d8e 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      cursor: pointer;
      z-index: 999999;
      box-shadow: 0 2px 10px rgba(0, 161, 214, 0.3);
      transition: all 0.3s ease;
      user-select: none;
    `;

    ball.addEventListener('mouseenter', () => {
      ball.style.transform = 'scale(1.1)';
    });

    ball.addEventListener('mouseleave', () => {
      ball.style.transform = 'scale(1)';
    });

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    ball.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(ball.style.right) || 20;
      startTop = parseInt(ball.style.top) || 100;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = startX - e.clientX;
      const deltaY = e.clientY - startY;
      ball.style.right = Math.max(10, startLeft + deltaX) + 'px';
      ball.style.top = Math.max(10, startTop + deltaY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    ball.addEventListener('click', (e) => {
      if (!isDragging) {
        toggleMainWindow();
      }
    });

    document.body.appendChild(ball);
    return ball;
  }

  function createMainWindow() {
    const window = document.createElement('div');
    window.id = 'bili-monitor-window';
    window.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 800px;
      height: 600px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
      z-index: 1000000;
      display: none;
      overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      background: linear-gradient(135deg, #00a1d6 0%, #f25d8e 100%);
      color: white;
      padding: 15px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
    `;
    header.innerHTML = `
      <h3 style="margin: 0; font-size: 16px;">B站评论弹幕记录</h3>
      <div>
        <button id="export-btn" style="background: rgba(255,255,255,0.2); border: none; color: white; padding: 6px 12px; border-radius: 5px; margin-right: 10px; cursor: pointer; font-size: 14px;">导出数据</button>
        <button id="close-btn" style="background: rgba(255,255,255,0.2); border: none; color: white; padding: 6px 10px; border-radius: 5px; cursor: pointer; font-size: 18px;">×</button>
      </div>
    `;

    const tabNav = document.createElement('div');
    tabNav.style.cssText = `
      display: flex;
      background: #f8f9fa;
      border-bottom: 1px solid #e9ecef;
    `;

    const tabs = [
      { id: 'comments', name: '评论监控', icon: '' },
      { id: 'danmaku', name: '弹幕监控', icon: '' }
    ];

    tabs.forEach((tab, index) => {
      const tabBtn = document.createElement('button');
      tabBtn.className = 'tab-btn';
      tabBtn.dataset.tab = tab.id;
      tabBtn.innerHTML = `${tab.icon} ${tab.name}`;
      tabBtn.style.cssText = `
        flex: 1;
        padding: 12px;
        border: none;
        background: ${index === 0 ? 'white' : 'transparent'};
        cursor: pointer;
        font-size: 14px;
        transition: all 0.3s ease;
        ${index === 0 ? 'border-bottom: 3px solid #00a1d6;' : ''}
      `;

      tabBtn.addEventListener('click', () => switchTab(tab.id));
      tabNav.appendChild(tabBtn);
    });

    const content = document.createElement('div');
    content.id = 'tab-content';
    content.style.cssText = `
      flex: 1;
      overflow: hidden;
      padding: 20px;
    `;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = window.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      window.style.left = startLeft + deltaX + 'px';
      window.style.top = startTop + deltaY + 'px';
      window.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    header.querySelector('#close-btn').addEventListener('click', () => {
      window.style.display = 'none';
    });

    header.querySelector('#export-btn').addEventListener('click', exportData);

    window.appendChild(header);
    window.appendChild(tabNav);
    window.appendChild(content);
    document.body.appendChild(window);

    return window;
  }

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabId;
      btn.style.background = isActive ? 'white' : 'transparent';
      btn.style.borderBottom = isActive ? '3px solid #00a1d6' : 'none';
    });

    const content = document.getElementById('tab-content');
    switch (tabId) {
      case 'comments':
        content.innerHTML = createCommentsTab();
        updateCommentsDisplay();
        break;
      case 'danmaku':
        content.innerHTML = createDanmakuTab();
        updateDanmakuDisplay();
        break;
    }
  }

  function createCommentsTab() {
    const imageComments = capturedComments.filter(c => c.images && c.images.length > 0);
    return `
      <div style="height: 100%; display: flex; flex-direction: column;">
        <div style="margin-bottom: 15px;">
          <h4 style="margin: 0 0 10px 0; color: #00a1d6;">
            评论监控 (${capturedComments.length})
            ${imageComments.length > 0 ? `<span style="color: #28a745; font-size: 14px;">📷 含图片: ${imageComments.length}</span>` : ''}
          </h4>
          <button onclick="window.clearComments()" style="padding: 6px 12px; background: #f25d8e; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">清空评论</button>
        </div>
        <div id="comments-list" style="flex: 1; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px;"></div>
      </div>
    `;
  }

  function createDanmakuTab() {
    return `
      <div style="height: 100%; display: flex; flex-direction: column;">
        <div style="margin-bottom: 15px;">
          <h4 style="margin: 0 0 10px 0; color: #00a1d6;">弹幕监控 (${capturedDanmaku.length})</h4>
          <button onclick="window.clearDanmaku()" style="padding: 6px 12px; background: #f25d8e; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">清空弹幕</button>
        </div>
        <div id="danmaku-list" style="flex: 1; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px;"></div>
      </div>
    `;
  }

  function updateCommentsDisplay() {
    const listDiv = document.getElementById('comments-list');
    if (!listDiv) return;

    if (capturedComments.length === 0) {
      listDiv.innerHTML = '<div style="text-align: center; color: #666; padding: 50px;">暂无评论数据</div>';
      return;
    }

    listDiv.innerHTML = capturedComments.slice(-STORAGE_CONFIG.DISPLAY_LIMIT).reverse().map(comment => {
      const hasImages = comment.images && comment.images.length > 0;

      return `
        <div style="margin-bottom: 12px; padding: 12px; background: ${hasImages ? '#e8f5e8' : (comment.rpid ? '#f8f9fa' : '#fff5f5')}; border-left: 4px solid ${hasImages ? '#28a745' : (comment.rpid ? '#00a1d6' : '#f25d8e')}; border-radius: 6px;">
          <div style="font-weight: 500; margin-bottom: 6px; color: #333; font-size: 14px;">
            ${escapeHtml(comment.text)}
          </div>

          ${hasImages ? `
            <div style="margin: 8px 0; padding: 10px; background: white; border-radius: 6px; border: 1px solid #28a745;">
              <div style="font-weight: 600; color: #28a745; margin-bottom: 8px; font-size: 13px;">📷 包含图片 (${comment.images.length}张)</div>
              ${comment.images.map((img, index) => `
                <div style="margin: 5px 0; padding: 8px; background: #f8f9fa; border-radius: 4px; font-size: 12px;">
                  <strong>图片 ${index + 1}:</strong>
                  <a href="${img.url}" target="_blank" style="color: #007bff; margin-left: 8px; word-break: break-all;">查看原图</a>
                  ${img.width ? `<span style="margin-left: 10px; color: #666;">尺寸: ${img.width}×${img.height}px</span>` : ''}
                </div>
              `).join('')}
            </div>
          ` : ''}

          <div style="font-size: 12px; color: #666;">
            <span style="margin-right: 12px;">⏰ ${comment.time}</span>
            <span style="margin-right: 12px;">🆔 ${comment.rpid || '未获取'}</span>
            <span style="margin-right: 12px;">📹 oid: ${comment.oid || '未获取'}</span> 
            <span style="color: ${comment.status === '已获取ID' ? '#28a745' : '#dc3545'};">● ${comment.status}</span>
            ${hasImages ? '<span style="margin-left: 12px; color: #28a745; font-weight: 600;">📷 含图片</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

    const tab = document.querySelector('[data-tab="comments"]');
    if (tab) {
      const imageCount = capturedComments.filter(c => c.images && c.images.length > 0).length;
      tab.innerHTML = `评论监控 (${capturedComments.length}${imageCount > 0 ? ` 📷${imageCount}` : ''})`;
    }
  }

  function updateDanmakuDisplay() {
    const listDiv = document.getElementById('danmaku-list');
    if (!listDiv) return;

    if (capturedDanmaku.length === 0) {
      listDiv.innerHTML = '<div style="text-align: center; color: #666; padding: 50px;">暂无弹幕数据</div>';
      return;
    }

    listDiv.innerHTML = capturedDanmaku.slice(-STORAGE_CONFIG.DISPLAY_LIMIT).reverse().map(danmaku => `
      <div style="margin-bottom: 10px; padding: 10px; background: #f8f9fa; border-left: 4px solid #f25d8e; border-radius: 6px;">
        <div style="font-weight: 500; margin-bottom: 5px; color: #333; font-size: 14px;">${escapeHtml(danmaku.text)}</div>
        <div style="font-size: 12px; color: #666;">
          <span style="margin-right: 12px;">⏰ ${danmaku.time}</span>
          <span style="margin-right: 12px;">📺 ${danmaku.method || '发送'}</span>
          <span style="margin-right: 12px;">⏱️ ${danmaku.videoTime || 0}s</span>
          <span>🎯 ${danmaku.pageType || '未知页面'}</span>
        </div>
      </div>
    `).join('');

    const tab = document.querySelector('[data-tab="danmaku"]');
    if (tab) {
      tab.innerHTML = `弹幕监控 (${capturedDanmaku.length})`;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function toggleMainWindow() {
    const window = document.getElementById('bili-monitor-window');
    if (window.style.display === 'none') {
      window.style.display = 'flex';
      window.style.flexDirection = 'column';
      switchTab('comments');
    } else {
      window.style.display = 'none';
    }
  }

  function exportData() {
    if (STORAGE_CONFIG.EXPORT_SOURCE === 'localStorage') {
      exportFromLocalStorage();
    } else {
      exportFromMemory();
    }
  }

  function exportFromLocalStorage() {
    let localStorageComments = [];
    let localStorageDanmaku = [];

    try {
      localStorageComments = JSON.parse(localStorage.getItem(CACHE_KEYS.comments) || '[]');
      localStorageDanmaku = JSON.parse(localStorage.getItem(CACHE_KEYS.danmaku) || '[]');
      console.log(`从localStorage导出 - 评论:${localStorageComments.length} 弹幕:${localStorageDanmaku.length}`);
    } catch (e) {
      console.error('localStorage读取失败，回退到内存数据:', e);
      exportFromMemory();
      return;
    }

    const data = createExportData(localStorageComments, localStorageDanmaku, 'localStorage');
    downloadJSON(data, 'bili-monitor-data');
  }

  function exportFromMemory() {
    console.log(`从内存导出 - 评论:${capturedComments.length} 弹幕:${capturedDanmaku.length}`);
    const data = createExportData(capturedComments, capturedDanmaku, 'memory');
    downloadJSON(data, 'bili-monitor-data');
  }

  function createExportData(comments, danmaku, source) {
    return {
      exportTime: new Date().toISOString(),
      dataSource: source,
      config: STORAGE_CONFIG,
      summary: {
        totalComments: comments.length,
        totalDanmaku: danmaku.length,
        imageComments: comments.filter(c => c.images && c.images.length > 0).length,
        totalImages: comments.reduce((sum, c) => sum + (c.images ? c.images.length : 0), 0)
      },
      comments: comments.map(comment => ({
        text: comment.text,
        time: comment.time,
        timestamp: comment.timestamp,
        rpid: comment.rpid,
        oid: comment.oid,
        type: comment.type,
        status: comment.status,
        images: comment.images || [],
        videoInfo: comment.videoInfo || getCurrentVideoInfo(),
        videoTime: comment.videoTime || getCurrentVideoTime(),
        pageType: comment.pageType || getPageType(),
        url: comment.url || window.location.href
      })),
      danmaku: danmaku
    };
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`数据导出完成 - 评论:${data.summary.totalComments} 弹幕:${data.summary.totalDanmaku} 图片:${data.summary.totalImages}`);
  }

  window.clearComments = () => {
    capturedComments = [];
    pendingComments.clear();
    updateCommentsDisplay();
    saveToCache();
    console.log('评论数据已清空');
  };

  window.clearDanmaku = () => {
    capturedDanmaku = [];
    updateDanmakuDisplay();
    saveToCache();
    console.log('弹幕数据已清空');
  };

  function parseCommentData(data) {
    let requestData = {};
    try {
      if (typeof data === 'string') {
        const params = new URLSearchParams(data);
        params.forEach((value, key) => {
          requestData[key] = value;
        });
      } else if (data instanceof FormData) {
        data.forEach((value, key) => {
          requestData[key] = value;
        });
      }
    } catch (e) {
      console.error('解析请求数据失败:', e);
    }
    return requestData;
  }

  function getCurrentVideoInfo() {
    try {
      const title = document.querySelector('.video-title, h1.title, .video-data__info h1')?.textContent?.trim() || '未知视频';
      const bvid = window.location.href.match(/BV[\w]+/) ? window.location.href.match(/BV[\w]+/)[0] : '未知';
      const upName = document.querySelector('.up-name, .up-info__right .up-name')?.textContent?.trim() || '未知UP主';

      return { title, bvid, upName, url: window.location.href };
    } catch (e) {
      return { title: '未知视频', bvid: '未知', upName: '未知UP主', url: window.location.href };
    }
  }

  function getCurrentVideoTime() {
    try {
      const video = document.querySelector('video');
      return video ? Math.floor(video.currentTime) : 0;
    } catch (e) {
      return 0;
    }
  }

  function getPageType() {
    const url = window.location.href;
    if (url.includes('/video/') || url.includes('/list/')) return '视频';
    if (url.includes('/bangumi/')) return '番剧';
    return '其他';
  }

  function addCommentWithLimit(comment) {
    capturedComments.push(comment);

    // 应用内存限制
    if (capturedComments.length > STORAGE_CONFIG.MEMORY_LIMIT_COMMENTS) {
      capturedComments = capturedComments.slice(-STORAGE_CONFIG.MEMORY_LIMIT_COMMENTS);
      console.log(`评论超出内存限制，保留最新${STORAGE_CONFIG.MEMORY_LIMIT_COMMENTS}条`);
    }

    updateCommentsDisplay();
    saveToCache();
  }

  class OptimizedNetworkInterceptor {
    constructor() {
      this.setupFetchInterceptor();
      log('网络拦截器已启动（仅Fetch）');
    }

    setupFetchInterceptor() {
      const originalFetch = window.fetch;

      window.fetch = async function(...args) {
        const [url, options = {}] = args;

        if (typeof url !== 'string' || !options.body) {
          return originalFetch.apply(this, args);
        }

        const isDanmakuAPI = API_CONFIG.danmaku.some(api => url.includes(api));
        const isCommentAPI = API_CONFIG.comment.some(api => url.includes(api));

        if (!isDanmakuAPI && !isCommentAPI) {
          return originalFetch.apply(this, args);
        }

        const requestId = generateRequestId(url, options.body);
        if (!shouldProcessRequest(requestId)) {
          return originalFetch.apply(this, args);
        }

        if (isDanmakuAPI) {
          try {
            const params = new URLSearchParams(options.body);
            const msg = params.get('msg');
            if (msg) {
              log('弹幕请求拦截', msg);
              setTimeout(() => {
                if (window.danmakuMonitor) {
                  window.danmakuMonitor.recordDanmaku(msg, '网络请求');
                }
              }, 100);
            }
          } catch (e) {
            console.error('弹幕请求解析失败:', e);
          }
        }

        if (isCommentAPI) {
          log('评论请求检测', url);

          const requestData = parseCommentData(options.body);
          const { images } = extractImageInfo(requestData);

          if (images.length > 0) {
            log('📷 请求中发现图片!', images.length);
          }

          const comment = {
            text: requestData.message || requestData.content || '(评论内容)',
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            tempId: Date.now() + Math.random(),
            rpid: null,
            oid: requestData.oid || null,
            type: requestData.type || null,
            status: "等待ID",
            images: images,
            videoInfo: getCurrentVideoInfo(),
            videoTime: getCurrentVideoTime(),
            pageType: getPageType(),
            url: window.location.href
          };

          addCommentWithLimit(comment);
          pendingComments.set(comment.tempId, comment);

          return originalFetch.apply(this, args).then(response => {
            const clonedResponse = response.clone();

            clonedResponse.json().then(data => {
              if (data.code === 0 && data.data) {
                const rpid = data.data.rpid || data.data.rpid_str ||
                           (data.data.reply && data.data.reply.rpid);
                if (rpid) {
                  log(`获取到评论ID: ${rpid}`);
                  updatePendingComment(rpid, requestData.message || requestData.content || '', comment.tempId);
                }
              }
            }).catch(e => console.error('解析响应失败:', e));

            return response;
          });
        }

        return originalFetch.apply(this, args);
      };
    }
  }

  class DanmakuMonitor {
    constructor() {
      this.videoInfo = {};
      this.updateVideoInfo();
    }

    start() {
      this.monitorInputAndButton();
      log('弹幕监控已启动');
    }

    updateVideoInfo() {
      this.videoInfo = getCurrentVideoInfo();
    }

    monitorInputAndButton() {
      setInterval(() => {
        const inputSelectors = [
          '.bpx-player-dm-input',
          '.bilibili-player-video-danmaku-input',
          'input[placeholder*="发个友善的弹幕"]'
        ];

        const buttonSelectors = [
          '.bpx-player-dm-btn-send',
          '.bilibili-player-video-btn-send',
          'button[class*="send"]'
        ];

        const input = inputSelectors.map(s => document.querySelector(s)).find(Boolean);
        const button = buttonSelectors.map(s => document.querySelector(s)).find(Boolean);

        if (input && !input.hasAttribute('data-danmaku-monitored')) {
          input.setAttribute('data-danmaku-monitored', 'true');

          input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
              setTimeout(() => this.recordDanmaku(input.value.trim(), 'Enter键'), 100);
            }
          });

          log('弹幕输入框监听已设置');
        }

        if (button && !button.hasAttribute('data-danmaku-monitored')) {
          button.setAttribute('data-danmaku-monitored', 'true');

          button.addEventListener('click', () => {
            if (input && input.value.trim()) {
              setTimeout(() => this.recordDanmaku(input.value.trim(), '点击按钮'), 100);
            }
          });

          log('弹幕发送按钮监听已设置');
        }
      }, 2000);
    }

    recordDanmaku(text, method = '未知') {
      if (!text || text.trim() === '') return;

      const danmaku = {
        text: text.trim(),
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
        method: method,
        videoInfo: this.videoInfo,
        videoTime: getCurrentVideoTime(),
        pageType: getPageType()
      };

      const isDuplicate = capturedDanmaku.some(d =>
        d.text === danmaku.text && Math.abs(d.timestamp - danmaku.timestamp) < 2000
      );

      if (!isDuplicate) {
        capturedDanmaku.unshift(danmaku);

        // 应用内存限制
        if (capturedDanmaku.length > STORAGE_CONFIG.MEMORY_LIMIT_DANMAKU) {
          capturedDanmaku = capturedDanmaku.slice(0, STORAGE_CONFIG.MEMORY_LIMIT_DANMAKU);
          console.log(`弹幕超出内存限制，保留最新${STORAGE_CONFIG.MEMORY_LIMIT_DANMAKU}条`);
        }

        log('弹幕已记录', danmaku.text);
        updateDanmakuDisplay();
        saveToCache();
      }
    }
  }

  function monitorCommentInput() {
    setInterval(() => {
      const selectors = [
        '.bili-rich-textarea__inner',
        '.brt-container',
        '.reply-box-textarea',
        'textarea[placeholder*="评论"]',
        '[contenteditable="true"]'
      ];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
          if (!element.hasAttribute('data-monitored')) {
            element.setAttribute('data-monitored', 'true');

            element.addEventListener('keydown', function(e) {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                setTimeout(() => handleCommentSend(element), 100);
              }
            });
          }
        });
      });

      const sendSelectors = [
        '.reply-box-send',
        '.brt-send-btn',
        'button[class*="submit"]',
        'button[class*="send"]',
        '.comment-submit button'
      ];

      sendSelectors.forEach(selector => {
        const buttons = document.querySelectorAll(selector);
        buttons.forEach(btn => {
          if (!btn.hasAttribute('data-monitored')) {
            btn.setAttribute('data-monitored', 'true');
            btn.addEventListener('click', () => {
              const parentForm = btn.closest('form, .reply-box, .comment-box, .brt-container');
              const input = parentForm ? parentForm.querySelector('textarea, [contenteditable="true"]') : null;
              setTimeout(() => handleCommentSend(input), 100);
            });
          }
        });
      });
    }, 1000);
  }

  function handleCommentSend(targetInput = null) {
    const inputSelectors = [
      '.bili-rich-textarea__inner',
      '.brt-container',
      '.reply-box-textarea',
      'textarea[placeholder*="评论"]',
      '[contenteditable="true"]'
    ];

    let commentText = '';

    if (targetInput) {
      const text = targetInput.value || targetInput.textContent || targetInput.innerText;
      if (text && text.trim()) {
        commentText = text.trim();
      }
    }

    if (!commentText) {
      for (const selector of inputSelectors) {
        const inputs = document.querySelectorAll(selector);
        for (const input of inputs) {
          const text = input.value || input.textContent || input.innerText;
          if (text && text.trim()) {
            commentText = text.trim();
            break;
          }
        }
        if (commentText) break;
      }
    }

    if (commentText) {
      const comment = {
        text: commentText,
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
        tempId: Date.now() + Math.random(),
        rpid: null,
        status: "等待ID",
        images: [],
        videoInfo: getCurrentVideoInfo(),
        videoTime: getCurrentVideoTime(),
        pageType: getPageType(),
        url: window.location.href
      };

      addCommentWithLimit(comment);
      pendingComments.set(comment.tempId, comment);

      log('捕获评论发送', commentText);

      setTimeout(() => {
        if (pendingComments.has(comment.tempId) && !comment.rpid) {
          comment.status = "获取失败";
          pendingComments.delete(comment.tempId);
          log(`评论ID获取超时: ${comment.tempId}`);
          updateCommentsDisplay();
          saveToCache();
        }
      }, 30000);
    }
  }

  function updatePendingComment(rpid, content, targetTempId = null) {
    log(`尝试匹配评论 rpid=${rpid}`);

    let matchedComment = null;
    const now = Date.now();

    if (targetTempId && pendingComments.has(targetTempId)) {
      matchedComment = pendingComments.get(targetTempId);
      log('直接tempId匹配成功');
    }

    if (!matchedComment && content && content.trim()) {
      for (const [tempId, comment] of pendingComments) {
        if (now - comment.timestamp < 30000) {
          const commentText = comment.text.trim();
          const contentText = content.trim();

          let actualContent = contentText;
          const replyMatch = contentText.match(/回复\s*@[^:：]+\s*[：:]\s*(.+)$/);
          if (replyMatch) {
            actualContent = replyMatch[1].trim();
          }

          if (commentText === actualContent ||
              commentText === contentText ||
              commentText.includes(actualContent) ||
              actualContent.includes(commentText)) {
            matchedComment = comment;
            log('内容匹配成功');
            break;
          }
        }
      }
    }

    if (!matchedComment && pendingComments.size > 0) {
      for (const [tempId, comment] of pendingComments) {
        if (now - comment.timestamp < 30000) {
          if (!matchedComment || comment.timestamp > matchedComment.timestamp) {
            matchedComment = comment;
          }
        }
      }
      if (matchedComment) {
        log('使用时间匹配');
      }
    }

    if (matchedComment) {
      matchedComment.rpid = rpid;
      matchedComment.status = "已获取ID";

      const index = capturedComments.findIndex(c => c.tempId === matchedComment.tempId);
      if (index !== -1) {
        capturedComments[index] = { ...matchedComment };
      }

      pendingComments.delete(matchedComment.tempId);

      log(`✅ 评论匹配成功: rpid=${rpid}`);

      updateCommentsDisplay();
      saveToCache();
    } else {
      log(`❌ 未找到匹配评论: rpid=${rpid}`);
    }
  }

  function init() {
    console.log('B站监控工具启动（配置化版本）');
    console.log('配置参数:', STORAGE_CONFIG);

    loadCachedData();
    createFloatingBall();
    createMainWindow();

    new OptimizedNetworkInterceptor();

    monitorCommentInput();

    const danmakuMonitor = new DanmakuMonitor();
    window.danmakuMonitor = danmakuMonitor;
    danmakuMonitor.start();

    console.log('所有功能已启动');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  } else {
    setTimeout(init, 1000);
  }

})();