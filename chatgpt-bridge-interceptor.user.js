// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.2.0
// @description  Pure context pipeline: intercepts /backend-api/conversation via unsafeWindow.fetch, handles all body types (string, ReadableStream, Blob, Request). CSP-safe.
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
  var API_ENDPOINT = 'https://midnightswitchboard.net/api/chat';
  var X_AGENT_KEY  = 'PLACEHOLDER_KEY';  // Replace with real key
  var TIMEOUT_MS   = 8000;
  var USER_ID      = 'bridge-user';
  var MEMORY_TOKEN = /(^|\s)\/remember(?=\s|$)/gi;
  // ===============================================================

  function LOG(msg) { console.log('[Bridge] ' + msg); }
  function WARN(msg) { console.warn('[Bridge] ' + msg); }

  var SESSION_ID;
  try { SESSION_ID = localStorage.getItem('bridge_session_id'); } catch (e) {}
  if (!SESSION_ID) {
    SESSION_ID = 'Steer-Primary-Context';
    try { localStorage.setItem('bridge_session_id', SESSION_ID); } catch (e) {}
  }

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function extractUserMessage(payload) {
    if (!payload || !payload.messages || !Array.isArray(payload.messages)) {
      LOG('  extractUserMessage: no messages array found');
      if (payload && payload.message && payload.message.content && payload.message.content.parts) {
        LOG('  extractUserMessage: found singular message.content.parts');
        return payload.message.content.parts.join('\n');
      }
      return '';
    }
    LOG('  extractUserMessage: messages array has ' + payload.messages.length + ' items');
    for (var i = payload.messages.length - 1; i >= 0; i--) {
      var msg = payload.messages[i];
      var role = (msg.author && msg.author.role) || msg.role || '';
      LOG('  extractUserMessage: [' + i + '] role=' + role);
      if (role === 'user') {
        if (msg.content && msg.content.parts && msg.content.parts.length > 0) {
          return msg.content.parts.join('\n');
        }
        if (msg.content && typeof msg.content === 'string') {
          return msg.content;
        }
      }
    }
    LOG('  extractUserMessage: no user message found in any format');
    return '';
  }

  function parseMemoryTrigger(text) {
    MEMORY_TOKEN.lastIndex = 0;
    var hasToken = MEMORY_TOKEN.test(text);
    if (!hasToken) return { stripped: text, writeMemory: false };
    MEMORY_TOKEN.lastIndex = 0;
    var stripped = text.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
    return { stripped: stripped, writeMemory: true };
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
            WARN('Backend HTTP ' + res.status + ': ' + (res.responseText || '').substring(0, 200));
            reject(new Error('backend HTTP ' + res.status));
            return;
          }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) {
              LOG('Context received (' + body.injected_context.length + ' chars)');
              resolve(body.injected_context);
            } else {
              WARN('Backend success=' + body.success + ', context empty=' + !body.injected_context);
              reject(new Error('backend returned success=false or empty context'));
            }
          } catch (e) {
            WARN('Parse error: ' + (res.responseText || '').substring(0, 200));
            reject(new Error('bridge parse error: ' + e.message));
          }
        },
        onerror: function () {
          clearTimeout(timer);
          WARN('GM_xmlhttpRequest network error');
          reject(new Error('bridge network error'));
        },
      });
    });
  }

  // Read body from any source type: string, ReadableStream, Blob, ArrayBuffer, Request
  async function readBody(input, init, pw) {
    // 1. Try init.body first (most common)
    if (init && init.body != null) {
      var b = init.body;
      var btype = typeof b;
      LOG('Body source: init.body (type: ' + btype + ', constructor: ' + (b.constructor && b.constructor.name || 'unknown') + ')');

      if (btype === 'string') return b;

      // ReadableStream
      if (b instanceof pw.ReadableStream || (b.getReader && typeof b.getReader === 'function')) {
        LOG('Reading body from ReadableStream...');
        try {
          var reader = b.getReader();
          var chunks = [];
          while (true) {
            var result = await reader.read();
            if (result.done) break;
            chunks.push(result.value);
          }
          var decoder = new TextDecoder();
          var text = chunks.map(function (c) { return decoder.decode(c, { stream: true }); }).join('');
          LOG('ReadableStream body read: ' + text.length + ' chars');
          return text;
        } catch (e) {
          WARN('ReadableStream read failed: ' + e.message);
          return null;
        }
      }

      // Blob
      if (b instanceof Blob || (pw.Blob && b instanceof pw.Blob)) {
        LOG('Reading body from Blob...');
        try { return await b.text(); } catch (e) { WARN('Blob read failed: ' + e.message); return null; }
      }

      // ArrayBuffer / TypedArray
      if (b instanceof ArrayBuffer || (pw.ArrayBuffer && b instanceof pw.ArrayBuffer)) {
        LOG('Reading body from ArrayBuffer...');
        try { return new TextDecoder().decode(b); } catch (e) { WARN('ArrayBuffer decode failed: ' + e.message); return null; }
      }
      if (ArrayBuffer.isView(b)) {
        LOG('Reading body from TypedArray...');
        try { return new TextDecoder().decode(b); } catch (e) { WARN('TypedArray decode failed: ' + e.message); return null; }
      }

      // Last resort: try toString
      LOG('Body is unknown type, trying toString...');
      try { return b.toString(); } catch (e) { return null; }
    }

    // 2. Try reading from Request object
    if (input && (typeof pw.Request !== 'undefined') && (input instanceof pw.Request || input instanceof Request)) {
      LOG('Body source: Request object');
      try {
        var cloned = input.clone();
        var reqText = await cloned.text();
        LOG('Request body read: ' + reqText.length + ' chars');
        return reqText;
      } catch (e) {
        WARN('Request.clone().text() failed: ' + e.message);
        return null;
      }
    }

    LOG('No body found in init or input');
    return null;
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
  var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var originalFetch = pageWindow.fetch.bind(pageWindow);

  pageWindow.fetch = async function (input, init) {
    // Determine URL
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input === 'object' && input.url) {
      url = input.url;
    } else if (input && input.toString) {
      url = input.toString();
    }

    // Scope check
    if (url.indexOf('/backend-api/conversation') === -1) {
      return originalFetch(input, init);
    }

    // Method check — be lenient: if we can't determine method, assume POST for conversation endpoint
    var method = 'UNKNOWN';
    if (init && init.method) {
      method = init.method.toUpperCase();
    } else if (input && typeof input === 'object' && input.method) {
      method = input.method.toUpperCase();
    } else {
      method = 'ASSUMED-POST';
    }

    if (method !== 'POST' && method !== 'ASSUMED-POST') {
      return originalFetch(input, init);
    }

    LOG('--- INTERCEPT START ---');
    LOG('URL: ' + url);
    LOG('Method: ' + method);

    // Read body from whatever source
    var bodyText = await readBody(input, init, pageWindow);

    if (!bodyText) {
      WARN('Could not read body from any source, passing through');
      LOG('--- INTERCEPT END (no body) ---');
      return originalFetch(input, init);
    }

    LOG('Raw body length: ' + bodyText.length + ' chars');
    LOG('Body preview: ' + bodyText.substring(0, 150) + '...');

    var body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      WARN('Body is not valid JSON: ' + e.message);
      LOG('--- INTERCEPT END (bad JSON) ---');
      return originalFetch(input, init);
    }

    LOG('Parsed payload keys: ' + Object.keys(body).join(', '));
    LOG('Action: ' + (body.action || 'none'));

    // Extract user message
    var rawUserMessage = extractUserMessage(body);
    if (!rawUserMessage) {
      LOG('No user message extracted, passing through');
      LOG('--- INTERCEPT END (no user msg) ---');
      return originalFetch(input, init);
    }

    LOG('User message: "' + rawUserMessage.substring(0, 80) + (rawUserMessage.length > 80 ? '...' : '') + '"');

    // Memory trigger
    var memResult = parseMemoryTrigger(rawUserMessage);
    var userMessage = memResult.stripped;
    var writeMemory = memResult.writeMemory;

    if (writeMemory) {
      if (body.messages && Array.isArray(body.messages)) {
        for (var i = body.messages.length - 1; i >= 0; i--) {
          var msg = body.messages[i];
          var role = (msg.author && msg.author.role) || msg.role || '';
          if (role === 'user' && msg.content && msg.content.parts) {
            msg.content.parts = msg.content.parts.map(function (p) {
              if (typeof p !== 'string') return p;
              MEMORY_TOKEN.lastIndex = 0;
              return p.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
            });
            break;
          }
        }
      }
      LOG('MEMORY WRITE REQUESTED — /remember stripped');
    }

    // Dedup
    var hash = messageHash(rawUserMessage);
    if (pendingRequests.has(hash)) {
      LOG('Dedup: already processing, passing through');
      LOG('--- INTERCEPT END (dedup) ---');
      return originalFetch(input, init);
    }
    pendingRequests.add(hash);

    try {
      var context = await fetchContext(userMessage, writeMemory);

      // Build system message
      var systemMessage = {
        id: uuidv4(),
        author: { role: 'system' },
        content: {
          content_type: 'text',
          parts: [context],
        },
        metadata: {},
      };

      // Inject into messages array
      if (body.messages && Array.isArray(body.messages)) {
        body.messages.unshift(systemMessage);
      } else {
        body.messages = [systemMessage];
        LOG('Created messages array (was missing)');
      }

      var modifiedBody = JSON.stringify(body);

      // Build clean init with modified body
      var newInit = { method: 'POST', body: modifiedBody };
      if (init) {
        if (init.headers) newInit.headers = init.headers;
        if (init.credentials) newInit.credentials = init.credentials;
        if (init.signal) newInit.signal = init.signal;
        if (init.mode) newInit.mode = init.mode;
        if (init.cache) newInit.cache = init.cache;
        if (init.redirect) newInit.redirect = init.redirect;
        if (init.referrer) newInit.referrer = init.referrer;
        if (init.referrerPolicy) newInit.referrerPolicy = init.referrerPolicy;
        if (init.integrity) newInit.integrity = init.integrity;
        if (init.keepalive != null) newInit.keepalive = init.keepalive;
      }

      LOG('Context injected (' + context.length + ' chars). Sending modified request.');
      LOG('--- INTERCEPT END (success) ---');
      return originalFetch(url, newInit);
    } catch (err) {
      WARN('Backend failed (' + err.message + ') — sending original (fail-safe)');
      LOG('--- INTERCEPT END (fail-safe) ---');
    } finally {
      pendingRequests.delete(hash);
    }

    return originalFetch(input, init);
  };

  LOG('v3.2.0 loaded — pure context pipeline (unsafeWindow + all body types)');
  LOG('Memory gate: /remember triggers write');
  LOG('CSP eval warning is from ChatGPT, not this script');
})();
