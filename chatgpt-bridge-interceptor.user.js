// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.3.0
// @description  Pure context pipeline: intercepts /backend-api/conversation (fetch + XHR), targets action:next payloads, injects raw context from Laravel as system message.
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

  // Extract user message — tolerant of multiple payload shapes
  function extractUserMessage(payload) {
    // Shape 1: messages array with author.role
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var i = payload.messages.length - 1; i >= 0; i--) {
        var msg = payload.messages[i];
        var role = (msg.author && msg.author.role) || msg.role || '';
        if (role === 'user') {
          if (msg.content && msg.content.parts && msg.content.parts.length > 0) {
            return msg.content.parts.join('\n');
          }
          if (msg.content && typeof msg.content === 'string') {
            return msg.content;
          }
        }
      }
    }
    // Shape 2: singular message object
    if (payload.message) {
      var m = payload.message;
      var r = (m.author && m.author.role) || m.role || '';
      if (r === 'user' || r === '') {
        if (m.content && m.content.parts && m.content.parts.length > 0) {
          return m.content.parts.join('\n');
        }
        if (m.content && typeof m.content === 'string') {
          return m.content;
        }
      }
    }
    // Shape 3: prompt field
    if (payload.prompt && typeof payload.prompt === 'string') {
      return payload.prompt;
    }
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
    LOG('Calling backend: ' + API_ENDPOINT);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        WARN('Backend timed out after ' + TIMEOUT_MS + 'ms');
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
          LOG('Backend HTTP ' + res.status);
          if (res.status !== 200) {
            WARN('Backend error: ' + (res.responseText || '').substring(0, 200));
            reject(new Error('backend HTTP ' + res.status));
            return;
          }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) {
              LOG('Context received (' + body.injected_context.length + ' chars)');
              resolve(body.injected_context);
            } else {
              WARN('Backend success=' + body.success + ', has context=' + !!body.injected_context);
              reject(new Error('no context returned'));
            }
          } catch (e) {
            WARN('Response parse error');
            reject(new Error('parse error'));
          }
        },
        onerror: function () {
          clearTimeout(timer);
          WARN('Network error');
          reject(new Error('network error'));
        },
      });
    });
  }

  // Convert any body type to string
  async function bodyToString(body, pw) {
    if (body == null) return null;
    if (typeof body === 'string') return body;

    // ReadableStream
    if (typeof pw.ReadableStream !== 'undefined' && body instanceof pw.ReadableStream) {
      LOG('  body type: ReadableStream');
      try {
        var reader = body.getReader();
        var chunks = [];
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
        }
        return chunks.map(function (c) { return new TextDecoder().decode(c); }).join('');
      } catch (e) { WARN('  ReadableStream read failed: ' + e.message); return null; }
    }
    if (body.getReader && typeof body.getReader === 'function') {
      LOG('  body type: stream-like (has getReader)');
      try {
        var reader2 = body.getReader();
        var chunks2 = [];
        while (true) {
          var r2 = await reader2.read();
          if (r2.done) break;
          chunks2.push(r2.value);
        }
        return chunks2.map(function (c) { return new TextDecoder().decode(c); }).join('');
      } catch (e) { WARN('  stream read failed: ' + e.message); return null; }
    }

    // Blob
    if ((typeof Blob !== 'undefined' && body instanceof Blob) || (pw.Blob && body instanceof pw.Blob)) {
      LOG('  body type: Blob');
      try { return await body.text(); } catch (e) { return null; }
    }

    // ArrayBuffer
    if ((typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) || (pw.ArrayBuffer && body instanceof pw.ArrayBuffer)) {
      LOG('  body type: ArrayBuffer');
      try { return new TextDecoder().decode(body); } catch (e) { return null; }
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      LOG('  body type: TypedArray');
      try { return new TextDecoder().decode(body); } catch (e) { return null; }
    }

    LOG('  body type: ' + (body.constructor ? body.constructor.name : typeof body) + ' (trying toString)');
    try { return body.toString(); } catch (e) { return null; }
  }

  // Core injection logic — shared between fetch and XHR intercepts
  async function processPayload(bodyString) {
    var body;
    try {
      body = JSON.parse(bodyString);
    } catch (e) {
      LOG('Not valid JSON, skipping');
      return null;
    }

    // ONLY process action:"next" — this is the primary user send
    var action = body.action || '';
    if (action !== 'next') {
      LOG('Action is "' + action + '" (not "next"), skipping');
      return null;
    }

    LOG('ACTION: next — this is a primary user send');

    var rawUserMessage = extractUserMessage(body);
    if (!rawUserMessage) {
      LOG('No user message found in payload, skipping');
      LOG('Payload keys: ' + Object.keys(body).join(', '));
      if (body.messages) LOG('Messages count: ' + body.messages.length);
      return null;
    }

    LOG('User message: "' + rawUserMessage.substring(0, 80) + '"');

    // Memory trigger
    var memResult = parseMemoryTrigger(rawUserMessage);
    var userMessage = memResult.stripped;
    var writeMemory = memResult.writeMemory;

    if (writeMemory && body.messages && Array.isArray(body.messages)) {
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
      LOG('MEMORY WRITE — /remember stripped');
    }

    try {
      var context = await fetchContext(userMessage, writeMemory);

      var systemMessage = {
        id: uuidv4(),
        author: { role: 'system' },
        content: { content_type: 'text', parts: [context] },
        metadata: {},
      };

      if (body.messages && Array.isArray(body.messages)) {
        body.messages.unshift(systemMessage);
      } else {
        body.messages = [systemMessage];
      }

      LOG('INJECTED (' + context.length + ' chars)');
      return JSON.stringify(body);
    } catch (err) {
      WARN('Backend failed (' + err.message + ') — fail-safe, no injection');
      return null;
    }
  }

  // ======================== INTERCEPT SETUP ========================
  var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Track processed requests to avoid double-processing
  var processedIds = new Set();

  // -------------------- FETCH OVERRIDE --------------------
  var originalFetch = pageWindow.fetch.bind(pageWindow);

  pageWindow.fetch = async function (input, init) {
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input === 'object' && input.url) {
      url = input.url;
    }

    if (url.indexOf('/backend-api/conversation') === -1) {
      return originalFetch(input, init);
    }

    LOG('=== FETCH intercept: ' + url + ' ===');

    // Read body from all possible sources
    var bodyStr = null;

    // Source 1: init.body
    if (init && init.body != null) {
      bodyStr = await bodyToString(init.body, pageWindow);
      if (bodyStr) LOG('Body from init.body (' + bodyStr.length + ' chars)');
    }

    // Source 2: Request object
    if (!bodyStr && input && typeof input === 'object' && input.clone) {
      try {
        var cloned = input.clone();
        bodyStr = await cloned.text();
        if (bodyStr) LOG('Body from Request.text() (' + bodyStr.length + ' chars)');
      } catch (e) {
        WARN('Request body read failed: ' + e.message);
      }
    }

    if (!bodyStr) {
      WARN('No readable body, passing through');
      return originalFetch(input, init);
    }

    // Process the payload
    var modified = await processPayload(bodyStr);

    if (modified) {
      // Build new init with modified body
      var newInit = { method: 'POST', body: modified };
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
      LOG('Sending modified request via fetch');
      return originalFetch(url, newInit);
    }

    // No modification — send original body (re-create since stream may be consumed)
    var fallbackInit = {};
    if (init) {
      for (var key in init) {
        if (init.hasOwnProperty(key) && key !== 'body') {
          fallbackInit[key] = init[key];
        }
      }
    }
    fallbackInit.body = bodyStr;
    if (!fallbackInit.method) fallbackInit.method = 'POST';
    return originalFetch(url, fallbackInit);
  };

  // -------------------- XHR OVERRIDE --------------------
  var OrigXHR = pageWindow.XMLHttpRequest;
  var xhrProto = OrigXHR.prototype;
  var origOpen = xhrProto.open;
  var origSend = xhrProto.send;

  xhrProto.open = function (method, url) {
    this._bridgeMethod = method;
    this._bridgeUrl = url;
    return origOpen.apply(this, arguments);
  };

  xhrProto.send = function (body) {
    var xhr = this;
    var url = xhr._bridgeUrl || '';
    var method = (xhr._bridgeMethod || '').toUpperCase();

    if (url.indexOf('/backend-api/conversation') === -1 || method !== 'POST') {
      return origSend.apply(xhr, arguments);
    }

    if (typeof body !== 'string') {
      LOG('=== XHR intercept (non-string body, passing through) ===');
      return origSend.apply(xhr, arguments);
    }

    LOG('=== XHR intercept: ' + url + ' ===');

    processPayload(body).then(function (modified) {
      if (modified) {
        LOG('Sending modified request via XHR');
        origSend.call(xhr, modified);
      } else {
        origSend.call(xhr, body);
      }
    }).catch(function (err) {
      WARN('XHR processing error: ' + err.message);
      origSend.call(xhr, body);
    });
  };

  LOG('v3.3.0 loaded — fetch + XHR intercept, action:next filter');
  LOG('Memory gate: /remember triggers write');
})();
