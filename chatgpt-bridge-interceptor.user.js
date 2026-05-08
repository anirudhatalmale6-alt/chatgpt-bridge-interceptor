// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.1.0
// @description  Pure context pipeline: intercepts /backend-api/conversation via unsafeWindow.fetch, fetches raw context from Laravel, injects as system message. CSP-safe.
// @author       hezarfen4
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      midnightswitchboard.net
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ======================== CONFIGURATION ========================
  const API_ENDPOINT = 'https://midnightswitchboard.net/api/chat';
  const X_AGENT_KEY  = 'PLACEHOLDER_KEY';  // Replace with real key
  const TIMEOUT_MS   = 8000;
  const USER_ID      = 'bridge-user';
  const MEMORY_TOKEN = /(^|\s)\/remember(?=\s|$)/gi;
  // ===============================================================

  const LOG = function (msg) { console.log('[Bridge] ' + msg); };
  const WARN = function (msg) { console.warn('[Bridge] ' + msg); };

  // Session ID — persistent across page loads
  let SESSION_ID;
  try {
    SESSION_ID = localStorage.getItem('bridge_session_id');
  } catch (e) {
    SESSION_ID = null;
  }
  if (!SESSION_ID) {
    SESSION_ID = 'Steer-Primary-Context';
    try { localStorage.setItem('bridge_session_id', SESSION_ID); } catch (e) {}
  }

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function extractUserMessage(payload) {
    if (!payload || !payload.messages || !payload.messages.length) return '';
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const msg = payload.messages[i];
      if (msg.author && msg.author.role === 'user') {
        if (msg.content && msg.content.parts && msg.content.parts.length > 0) {
          return msg.content.parts.join('\n');
        }
      }
    }
    return '';
  }

  function parseMemoryTrigger(text) {
    MEMORY_TOKEN.lastIndex = 0;
    const hasToken = MEMORY_TOKEN.test(text);
    if (!hasToken) return { stripped: text, writeMemory: false };
    MEMORY_TOKEN.lastIndex = 0;
    const stripped = text.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
    return { stripped, writeMemory: true };
  }

  function fetchContext(messageText, writeMemory) {
    LOG('Calling backend: ' + API_ENDPOINT + ' (write_memory: ' + writeMemory + ')');
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        WARN('Backend call timed out after ' + TIMEOUT_MS + 'ms');
        reject(new Error('bridge timeout'));
      }, TIMEOUT_MS);

      GM_xmlhttpRequest({
        method: 'POST',
        url: API_ENDPOINT,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': X_AGENT_KEY,
        },
        data: JSON.stringify({
          user_id: USER_ID,
          session_id: SESSION_ID,
          message: messageText,
          write_memory: writeMemory,
        }),
        onload: function (res) {
          clearTimeout(timer);
          LOG('Backend responded: HTTP ' + res.status);
          if (res.status !== 200) {
            WARN('Backend returned HTTP ' + res.status + ': ' + res.responseText.substring(0, 200));
            reject(new Error('backend HTTP ' + res.status));
            return;
          }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) {
              LOG('Context received (' + body.injected_context.length + ' chars)');
              resolve(body.injected_context);
            } else {
              WARN('Backend returned success=' + body.success + ', context empty=' + !body.injected_context);
              reject(new Error('backend returned success=false or empty context'));
            }
          } catch (e) {
            WARN('Could not parse backend response: ' + res.responseText.substring(0, 200));
            reject(new Error('bridge parse error: ' + e.message));
          }
        },
        onerror: function (err) {
          clearTimeout(timer);
          WARN('GM_xmlhttpRequest network error');
          reject(new Error('bridge network error'));
        },
      });
    });
  }

  var pendingRequests = new Set();

  function messageHash(text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString();
  }

  // ======================== FETCH OVERRIDE ========================
  // CRITICAL: Use unsafeWindow to override the PAGE's fetch, not the sandbox's.
  // With @grant GM_xmlhttpRequest, Tampermonkey sandboxes the script.
  // window.fetch in the sandbox is NOT the same as the page's fetch.
  // ChatGPT's React code uses the page's fetch, so we must override there.

  var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var originalFetch = pageWindow.fetch.bind(pageWindow);

  pageWindow.fetch = async function (input, init) {
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request || (pageWindow.Request && input instanceof pageWindow.Request)) {
      url = input.url;
    } else if (input && input.toString) {
      url = input.toString();
    }

    var isConversation = url.indexOf('/backend-api/conversation') !== -1;
    var isPost = false;

    // Check method from init or from Request object
    if (init && init.method) {
      isPost = init.method.toUpperCase() === 'POST';
    } else if (input instanceof Request || (pageWindow.Request && input instanceof pageWindow.Request)) {
      isPost = (input.method || '').toUpperCase() === 'POST';
    }

    if (!isConversation || !isPost) {
      return originalFetch(input, init);
    }

    LOG('Intercepted POST to: ' + url);

    // Get the body — could be in init.body or in the Request object
    var rawBody = null;
    if (init && init.body) {
      rawBody = init.body;
    } else if (input instanceof Request || (pageWindow.Request && input instanceof pageWindow.Request)) {
      try {
        rawBody = await input.clone().text();
      } catch (e) {
        WARN('Could not read Request body: ' + e.message);
      }
    }

    if (!rawBody) {
      WARN('No body found, passing through');
      return originalFetch(input, init);
    }

    var body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      WARN('Could not parse request body as JSON, passing through');
      return originalFetch(input, init);
    }

    var rawUserMessage = extractUserMessage(body);
    if (!rawUserMessage) {
      LOG('No user message in payload (action: ' + (body.action || 'unknown') + '), passing through');
      return originalFetch(input, init);
    }

    LOG('User message: "' + rawUserMessage.substring(0, 60) + (rawUserMessage.length > 60 ? '...' : '') + '"');

    var memResult = parseMemoryTrigger(rawUserMessage);
    var userMessage = memResult.stripped;
    var writeMemory = memResult.writeMemory;

    if (writeMemory) {
      for (var i = body.messages.length - 1; i >= 0; i--) {
        var msg = body.messages[i];
        if (msg.author && msg.author.role === 'user' && msg.content && msg.content.parts) {
          msg.content.parts = msg.content.parts.map(function (p) {
            if (typeof p !== 'string') return p;
            MEMORY_TOKEN.lastIndex = 0;
            return p.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
          });
          break;
        }
      }
      LOG('MEMORY WRITE REQUESTED — /remember token detected and stripped');
    }

    var hash = messageHash(rawUserMessage);
    if (pendingRequests.has(hash)) {
      LOG('Dedup guard: already processing this message, passing through');
      return originalFetch(input, init);
    }

    pendingRequests.add(hash);

    try {
      var context = await fetchContext(userMessage, writeMemory);

      var systemMessage = {
        id: uuidv4(),
        author: { role: 'system' },
        content: {
          content_type: 'text',
          parts: [context],
        },
        metadata: {},
      };

      body.messages.unshift(systemMessage);

      var modifiedBody = JSON.stringify(body);

      // Rebuild init to ensure the modified body is used
      var newInit = {};
      if (init) {
        for (var key in init) {
          if (init.hasOwnProperty(key)) {
            newInit[key] = init[key];
          }
        }
      }
      newInit.body = modifiedBody;

      LOG('Context injected successfully (' + context.length + ' chars). Sending modified request.');
      return originalFetch(url, newInit);
    } catch (err) {
      WARN('Backend call failed (' + err.message + ') — sending original message (fail-safe)');
    } finally {
      pendingRequests.delete(hash);
    }

    return originalFetch(input, init);
  };

  LOG('v3.1.0 loaded — pure context pipeline active (unsafeWindow fetch override)');
  LOG('Memory gate: type /remember anywhere in your message to trigger a memory write');
  LOG('CSP note: GM_xmlhttpRequest bypasses page CSP. The eval warning is from ChatGPT, not this script.');
})();
