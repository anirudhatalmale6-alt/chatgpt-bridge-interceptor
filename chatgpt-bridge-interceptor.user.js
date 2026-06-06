// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.7.0
// @description  Targets /f/conversation + /backend-api/conversation, handles Request objects. Pure context pipeline.
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

  // Check if URL is a conversation endpoint we should intercept
  function isConversationUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.indexOf('/f/conversation') !== -1 ||
           url.indexOf('/backend-api/conversation') !== -1;
  }

  // Safely extract URL from any fetch input type
  function getUrlFromInput(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    // Request object — read .url property directly
    if (typeof input === 'object') {
      try { if (input.url) return input.url; } catch (e) {}
      try { if (input.href) return input.href; } catch (e) {}
    }
    return '';
  }

  // Safely get method from input/init
  function getMethod(input, init) {
    if (init && init.method) return init.method.toUpperCase();
    if (input && typeof input === 'object') {
      try { if (input.method) return input.method.toUpperCase(); } catch (e) {}
    }
    return 'GET';
  }

  function getTextFromMessage(msg) {
    if (!msg) return '';
    if (msg.content && msg.content.parts && Array.isArray(msg.content.parts)) {
      var tp = msg.content.parts.filter(function (p) { return typeof p === 'string' && p.trim(); });
      if (tp.length > 0) return tp.join('\n');
    }
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    if (msg.content && msg.content.text && typeof msg.content.text === 'string') return msg.content.text;
    if (msg.text && typeof msg.text === 'string' && msg.text.trim()) return msg.text;
    if (msg.parts && Array.isArray(msg.parts)) {
      var tp2 = msg.parts.filter(function (p) { return typeof p === 'string' && p.trim(); });
      if (tp2.length > 0) return tp2.join('\n');
    }
    return '';
  }

  function extractUserMessage(payload) {
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var i = payload.messages.length - 1; i >= 0; i--) {
        var msg = payload.messages[i];
        var role = (msg.author && msg.author.role) || msg.role || '';
        if (role === 'user') { var t = getTextFromMessage(msg); if (t) return t; }
      }
      for (var j = payload.messages.length - 1; j >= 0; j--) {
        var msg2 = payload.messages[j];
        var role2 = (msg2.author && msg2.author.role) || msg2.role || '';
        if (role2 === 'system' || role2 === 'tool') continue;
        var t2 = getTextFromMessage(msg2); if (t2) return t2;
      }
      for (var k = payload.messages.length - 1; k >= 0; k--) {
        var t3 = getTextFromMessage(payload.messages[k]); if (t3) return t3;
      }
    }
    if (payload.message) { var t4 = getTextFromMessage(payload.message); if (t4) return t4; }
    if (payload.prompt && typeof payload.prompt === 'string') return payload.prompt;
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
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, TIMEOUT_MS);
      GM_xmlhttpRequest({
        method: 'POST', url: API_ENDPOINT,
        headers: { 'Content-Type': 'application/json', 'X-Agent-Key': X_AGENT_KEY },
        data: JSON.stringify({ user_id: USER_ID, session_id: SESSION_ID, message: messageText, write_memory: writeMemory }),
        onload: function (res) {
          clearTimeout(timer);
          if (res.status !== 200) { reject(new Error('HTTP ' + res.status)); return; }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) resolve(body.injected_context);
            else reject(new Error('no context'));
          } catch (e) { reject(new Error('parse')); }
        },
        onerror: function () { clearTimeout(timer); reject(new Error('network')); },
      });
    });
  }

  // Read body string from fetch arguments — handles Request objects, init.body, streams
  async function readBodyFromFetch(input, init, pw) {
    // Source 1: init.body (string)
    if (init && init.body != null && typeof init.body === 'string') {
      return init.body;
    }

    // Source 2: init.body (stream/blob/buffer)
    if (init && init.body != null) {
      // ReadableStream
      if (init.body.getReader && typeof init.body.getReader === 'function') {
        try {
          var reader = init.body.getReader();
          var chunks = [];
          while (true) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); }
          return chunks.map(function (c) { return new TextDecoder().decode(c); }).join('');
        } catch (e) { LOG('  Stream read failed: ' + e.message); }
      }
      // Blob
      try {
        if (init.body instanceof Blob || (pw.Blob && init.body instanceof pw.Blob)) {
          return await init.body.text();
        }
      } catch (e) {}
      // ArrayBuffer
      try {
        if (init.body instanceof ArrayBuffer) return new TextDecoder().decode(init.body);
        if (ArrayBuffer.isView && ArrayBuffer.isView(init.body)) return new TextDecoder().decode(init.body);
      } catch (e) {}
    }

    // Source 3: Request object — clone and read body
    if (input && typeof input === 'object' && typeof input.clone === 'function') {
      try {
        var cloned = input.clone();
        return await cloned.text();
      } catch (e) { LOG('  Request.clone().text() failed: ' + e.message); }
      try {
        var cloned2 = input.clone();
        var ab = await cloned2.arrayBuffer();
        return new TextDecoder().decode(ab);
      } catch (e) {}
    }

    return null;
  }

  // ======================== INTERCEPT SETUP ========================
  var pw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var realFetch = pw.fetch;
  var callCount = 0;

  function wrappedFetch(input, init) {
    // STEP 1: Extract URL from input (string or Request object)
    var url = getUrlFromInput(input);

    // Quick exit for non-conversation URLs
    if (!isConversationUrl(url)) {
      return realFetch.apply(pw, arguments);
    }

    callCount++;
    var id = 'F' + callCount;
    var method = getMethod(input, init);

    LOG('[' + id + '] Intercepted: ' + method + ' ' + url);

    if (method !== 'POST') {
      LOG('[' + id + '] Not POST, passing through');
      return realFetch.apply(pw, arguments);
    }

    // STEP 2: Async — read body, parse, inject
    return (async function () {
      var bodyStr = await readBodyFromFetch(input, init, pw);

      if (!bodyStr) {
        WARN('[' + id + '] Could not read body, passing through');
        return realFetch.apply(pw, [input, init]);
      }

      LOG('[' + id + '] Body: ' + bodyStr.length + ' chars');

      var body;
      try { body = JSON.parse(bodyStr); } catch (e) {
        LOG('[' + id + '] Not JSON, passing through');
        return sendWithStringBody(url, bodyStr, input, init);
      }

      var action = body.action === undefined ? '' : body.action;
      LOG('[' + id + '] action=' + action + ' model=' + (body.model || '?'));

      if (action !== 'next') {
        LOG('[' + id + '] Not action:next, passing through');
        return sendWithStringBody(url, bodyStr, input, init);
      }

      LOG('[' + id + '] *** PRIMARY SEND — action:next ***');

      var rawMsg = extractUserMessage(body);
      if (!rawMsg) {
        WARN('[' + id + '] Message extraction failed');
        try { LOG('[' + id + '] Dump: ' + JSON.stringify(body).substring(0, 500)); } catch (e) {}
        return sendWithStringBody(url, bodyStr, input, init);
      }

      LOG('[' + id + '] Message: "' + rawMsg.substring(0, 100) + '"');

      var mem = parseMemoryTrigger(rawMsg);

      if (mem.writeMemory && body.messages && Array.isArray(body.messages)) {
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
        LOG('[' + id + '] /remember stripped');
      }

      try {
        LOG('[' + id + '] Calling backend...');
        var context = await fetchContext(mem.stripped, mem.writeMemory);

        if (!body.messages || !Array.isArray(body.messages)) body.messages = [];
        body.messages.unshift({
          id: uuidv4(),
          author: { role: 'system' },
          content: { content_type: 'text', parts: [context] },
          metadata: {},
        });

        LOG('[' + id + '] INJECTION SUCCESS (' + context.length + ' chars)');
        return sendWithStringBody(url, JSON.stringify(body), input, init);
      } catch (err) {
        WARN('[' + id + '] Backend failed (' + err.message + ') — fail-safe');
        return sendWithStringBody(url, bodyStr, input, init);
      }
    })();
  }

  // Re-send with a string body, preserving headers/credentials from original init or Request
  function sendWithStringBody(url, bodyStr, originalInput, originalInit) {
    var newInit = { method: 'POST', body: bodyStr };

    // Copy properties from init if available
    if (originalInit) {
      if (originalInit.headers) newInit.headers = originalInit.headers;
      if (originalInit.credentials) newInit.credentials = originalInit.credentials;
      if (originalInit.signal) newInit.signal = originalInit.signal;
      if (originalInit.mode) newInit.mode = originalInit.mode;
      if (originalInit.cache) newInit.cache = originalInit.cache;
      if (originalInit.redirect) newInit.redirect = originalInit.redirect;
      if (originalInit.referrer) newInit.referrer = originalInit.referrer;
      if (originalInit.referrerPolicy) newInit.referrerPolicy = originalInit.referrerPolicy;
      if (originalInit.integrity) newInit.integrity = originalInit.integrity;
      if (originalInit.keepalive != null) newInit.keepalive = originalInit.keepalive;
    }
    // If input was a Request object and no init, copy headers from Request
    else if (originalInput && typeof originalInput === 'object' && originalInput.headers) {
      try { newInit.headers = originalInput.headers; } catch (e) {}
      try { if (originalInput.credentials) newInit.credentials = originalInput.credentials; } catch (e) {}
      try { if (originalInput.signal) newInit.signal = originalInput.signal; } catch (e) {}
      try { if (originalInput.mode) newInit.mode = originalInput.mode; } catch (e) {}
      try { if (originalInput.redirect) newInit.redirect = originalInput.redirect; } catch (e) {}
      try { if (originalInput.referrerPolicy) newInit.referrerPolicy = originalInput.referrerPolicy; } catch (e) {}
    }

    return realFetch.call(pw, url, newInit);
  }

  // Apply fetch override
  try { pw.fetch = wrappedFetch; } catch (e) {}
  try {
    Object.defineProperty(pw, 'fetch', { value: wrappedFetch, writable: true, configurable: true });
  } catch (e) {}

  // -------------------- XHR OVERRIDE --------------------
  var xhrProto = pw.XMLHttpRequest.prototype;
  var origOpen = xhrProto.open;
  var origSend = xhrProto.send;

  xhrProto.open = function (method, url) {
    this._bMethod = method;
    this._bUrl = url;
    return origOpen.apply(this, arguments);
  };

  xhrProto.send = function (body) {
    var url = this._bUrl || '';
    if (!isConversationUrl(url)) return origSend.apply(this, arguments);
    var method = (this._bMethod || '').toUpperCase();
    if (method !== 'POST' || typeof body !== 'string') return origSend.apply(this, arguments);

    var parsed;
    try { parsed = JSON.parse(body); } catch (e) { return origSend.call(this, body); }
    if (parsed.action !== 'next') return origSend.call(this, body);

    LOG('[XHR] action:next on ' + url);
    var xhr = this;
    var rawMsg = extractUserMessage(parsed);
    if (!rawMsg) { return origSend.call(xhr, body); }

    var mem = parseMemoryTrigger(rawMsg);
    fetchContext(mem.stripped, mem.writeMemory).then(function (context) {
      if (!parsed.messages) parsed.messages = [];
      parsed.messages.unshift({
        id: uuidv4(), author: { role: 'system' },
        content: { content_type: 'text', parts: [context] }, metadata: {},
      });
      LOG('[XHR] INJECTION SUCCESS');
      origSend.call(xhr, JSON.stringify(parsed));
    }).catch(function () {
      origSend.call(xhr, body);
    });
  };

  LOG('v3.7.0 loaded — targets /f/conversation + /backend-api/conversation');
  LOG('Handles Request objects + all body types');
  LOG('Memory gate: /remember');
})();
