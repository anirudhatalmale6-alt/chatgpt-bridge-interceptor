// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.6.0
// @description  Full traffic diagnostic: logs ALL fetch/XHR URLs, uses defineProperty to prevent fetch override bypass.
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
    // Pass 1: role=user
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var i = payload.messages.length - 1; i >= 0; i--) {
        var msg = payload.messages[i];
        var role = (msg.author && msg.author.role) || msg.role || '';
        if (role === 'user') {
          var t = getTextFromMessage(msg);
          if (t) return t;
        }
      }
    }
    // Pass 2: last message with text, skip system/tool
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var j = payload.messages.length - 1; j >= 0; j--) {
        var msg2 = payload.messages[j];
        var role2 = (msg2.author && msg2.author.role) || msg2.role || '';
        if (role2 === 'system' || role2 === 'tool') continue;
        var t2 = getTextFromMessage(msg2);
        if (t2) return t2;
      }
    }
    // Pass 3: any message with text
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var k = payload.messages.length - 1; k >= 0; k--) {
        var t3 = getTextFromMessage(payload.messages[k]);
        if (t3) return t3;
      }
    }
    // Pass 4: singular message
    if (payload.message) {
      var t4 = getTextFromMessage(payload.message);
      if (t4) return t4;
    }
    // Pass 5: prompt
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
        method: 'POST',
        url: API_ENDPOINT,
        headers: { 'Content-Type': 'application/json', 'X-Agent-Key': X_AGENT_KEY },
        data: JSON.stringify({
          user_id: USER_ID, session_id: SESSION_ID,
          message: messageText, write_memory: writeMemory,
        }),
        onload: function (res) {
          clearTimeout(timer);
          if (res.status !== 200) { reject(new Error('HTTP ' + res.status)); return; }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) { resolve(body.injected_context); }
            else { reject(new Error('no context')); }
          } catch (e) { reject(new Error('parse')); }
        },
        onerror: function () { clearTimeout(timer); reject(new Error('network')); },
      });
    });
  }

  // ======================== INTERCEPT SETUP ========================
  var pw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  LOG('v3.6.0 DIAGNOSTIC — wrapping fetch + XHR on: ' + (typeof unsafeWindow !== 'undefined' ? 'unsafeWindow' : 'window'));

  // -------------------- METHOD 1: FETCH via defineProperty --------------------
  // Using defineProperty makes the override resilient: even if ChatGPT's code
  // does "const f = window.fetch" after our script, it gets our wrapper.
  var realFetch = pw.fetch;
  var fetchCallCount = 0;

  function wrappedFetch(input, init) {
    // Extract URL
    var url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && input.url) url = input.url;
      else if (input && input.toString) url = input.toString();
    } catch (e) {}

    fetchCallCount++;
    var id = 'F' + fetchCallCount;

    // LOG EVERY SINGLE FETCH CALL
    var shortUrl = url.length > 120 ? url.substring(0, 120) + '...' : url;
    LOG('[' + id + '] FETCH: ' + shortUrl);

    // Only process conversation endpoints
    if (url.indexOf('conversation') === -1 && url.indexOf('sentinel') === -1 && url.indexOf('chat') === -1) {
      return realFetch.apply(pw, arguments);
    }

    LOG('[' + id + '] *** CONVERSATION-RELATED URL DETECTED ***');
    LOG('[' + id + '] Full URL: ' + url);
    LOG('[' + id + '] input type: ' + (input ? (input.constructor ? input.constructor.name : typeof input) : 'null'));
    LOG('[' + id + '] init present: ' + !!init);
    if (init) {
      LOG('[' + id + '] init.method: ' + (init.method || 'undefined'));
      LOG('[' + id + '] init.body type: ' + (init.body == null ? 'null/undefined' : (typeof init.body === 'string' ? 'string(' + init.body.length + ')' : (init.body.constructor ? init.body.constructor.name : typeof init.body))));
      LOG('[' + id + '] init keys: ' + Object.keys(init).join(', '));
    }

    // Determine if POST
    var method = 'GET';
    if (init && init.method) method = init.method.toUpperCase();
    else if (input && input.method) method = input.method.toUpperCase();

    if (method !== 'POST') {
      LOG('[' + id + '] Method is ' + method + ', not POST — passing through');
      return realFetch.apply(pw, arguments);
    }

    // Async processing for POST requests
    return (async function () {
      // Read body
      var bodyStr = null;

      if (init && init.body != null) {
        if (typeof init.body === 'string') {
          bodyStr = init.body;
          LOG('[' + id + '] Body: string (' + bodyStr.length + ' chars)');
        } else if (init.body.getReader) {
          LOG('[' + id + '] Body: ReadableStream — reading...');
          try {
            var reader = init.body.getReader();
            var chunks = [];
            while (true) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); }
            bodyStr = chunks.map(function (c) { return new TextDecoder().decode(c); }).join('');
            LOG('[' + id + '] Stream read: ' + bodyStr.length + ' chars');
          } catch (e) { WARN('[' + id + '] Stream read failed: ' + e.message); }
        } else if (init.body instanceof Blob || (pw.Blob && init.body instanceof pw.Blob)) {
          LOG('[' + id + '] Body: Blob — reading...');
          try { bodyStr = await init.body.text(); } catch (e) { WARN('[' + id + '] Blob read failed'); }
        } else {
          LOG('[' + id + '] Body: ' + (init.body.constructor ? init.body.constructor.name : typeof init.body));
          try { bodyStr = init.body.toString(); } catch (e) {}
        }
      }

      if (!bodyStr && input && typeof input === 'object' && input.clone) {
        LOG('[' + id + '] Trying Request.clone().text()...');
        try {
          bodyStr = await input.clone().text();
          LOG('[' + id + '] Request body: ' + bodyStr.length + ' chars');
        } catch (e) { WARN('[' + id + '] Request read failed: ' + e.message); }
      }

      if (!bodyStr) {
        WARN('[' + id + '] No body readable, passing through');
        return realFetch.apply(pw, [input, init]);
      }

      LOG('[' + id + '] Body preview: ' + bodyStr.substring(0, 300));

      // Parse
      var body;
      try { body = JSON.parse(bodyStr); } catch (e) {
        LOG('[' + id + '] Not JSON, passing through');
        var fi = {}; if (init) { for (var k in init) { if (k !== 'body') fi[k] = init[k]; } } fi.body = bodyStr; fi.method = 'POST';
        return realFetch.call(pw, url, fi);
      }

      LOG('[' + id + '] JSON keys: ' + Object.keys(body).join(', '));
      LOG('[' + id + '] action: ' + (body.action === undefined ? 'UNDEFINED' : '"' + body.action + '"'));
      if (body.model) LOG('[' + id + '] model: ' + body.model);

      // Only inject on action:next
      if (body.action !== 'next') {
        LOG('[' + id + '] Not action:next, passing through');
        var si = {}; if (init) { for (var sk in init) { if (sk !== 'body') si[sk] = init[sk]; } } si.body = bodyStr; si.method = 'POST';
        return realFetch.call(pw, url, si);
      }

      LOG('[' + id + '] *** ACTION:NEXT — PROCESSING ***');

      var rawMsg = extractUserMessage(body);
      if (!rawMsg) {
        WARN('[' + id + '] User message extraction failed');
        try { LOG('[' + id + '] Payload dump: ' + JSON.stringify(body).substring(0, 600)); } catch (e) {}
        var ei = {}; if (init) { for (var ek in init) { if (ek !== 'body') ei[ek] = init[ek]; } } ei.body = bodyStr; ei.method = 'POST';
        return realFetch.call(pw, url, ei);
      }

      LOG('[' + id + '] User message: "' + rawMsg.substring(0, 100) + '"');

      var mem = parseMemoryTrigger(rawMsg);

      try {
        LOG('[' + id + '] Calling backend...');
        var context = await fetchContext(mem.stripped, mem.writeMemory);

        body.messages.unshift({
          id: uuidv4(),
          author: { role: 'system' },
          content: { content_type: 'text', parts: [context] },
          metadata: {},
        });

        var newInit = { method: 'POST', body: JSON.stringify(body) };
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

        LOG('[' + id + '] INJECTION SUCCESS (' + context.length + ' chars)');
        return realFetch.call(pw, url, newInit);
      } catch (err) {
        WARN('[' + id + '] Backend failed (' + err.message + ') — fail-safe');
        var fi2 = {}; if (init) { for (var fk in init) { if (fk !== 'body') fi2[fk] = init[fk]; } } fi2.body = bodyStr; fi2.method = 'POST';
        return realFetch.call(pw, url, fi2);
      }
    })();
  }

  // Apply fetch override using multiple methods for maximum coverage
  try {
    pw.fetch = wrappedFetch;
    LOG('fetch override applied (direct assignment)');
  } catch (e) {
    WARN('Direct fetch assignment failed: ' + e.message);
  }

  // Also try defineProperty to make it stick
  try {
    Object.defineProperty(pw, 'fetch', {
      value: wrappedFetch,
      writable: true,
      configurable: true,
    });
    LOG('fetch override applied (defineProperty)');
  } catch (e) {
    WARN('defineProperty failed: ' + e.message);
  }

  // -------------------- METHOD 2: XHR OVERRIDE --------------------
  var xhrProto = pw.XMLHttpRequest.prototype;
  var origOpen = xhrProto.open;
  var origSend = xhrProto.send;
  var xhrCallCount = 0;

  xhrProto.open = function (method, url) {
    this._bMethod = method;
    this._bUrl = url;

    // Log conversation-related XHR
    if (url && (url.indexOf('conversation') !== -1 || url.indexOf('sentinel') !== -1)) {
      xhrCallCount++;
      this._bId = 'X' + xhrCallCount;
      LOG('[' + this._bId + '] XHR OPEN: ' + method + ' ' + url);
    }

    return origOpen.apply(this, arguments);
  };

  xhrProto.send = function (body) {
    var xhr = this;
    var url = xhr._bUrl || '';

    if (url.indexOf('conversation') === -1 && url.indexOf('sentinel') === -1) {
      return origSend.apply(xhr, arguments);
    }

    var id = xhr._bId || ('X' + (++xhrCallCount));
    var method = (xhr._bMethod || '').toUpperCase();

    LOG('[' + id + '] XHR SEND: ' + method + ' ' + url);
    LOG('[' + id + '] body type: ' + (body == null ? 'null' : typeof body));
    if (typeof body === 'string') {
      LOG('[' + id + '] body length: ' + body.length);
      LOG('[' + id + '] body preview: ' + body.substring(0, 300));
    }

    if (method !== 'POST' || typeof body !== 'string') {
      return origSend.apply(xhr, arguments);
    }

    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      return origSend.call(xhr, body);
    }

    LOG('[' + id + '] action: ' + (parsed.action || 'undefined'));

    if (parsed.action !== 'next') {
      return origSend.call(xhr, body);
    }

    LOG('[' + id + '] *** XHR ACTION:NEXT ***');
    var rawMsg = extractUserMessage(parsed);
    if (!rawMsg) {
      WARN('[' + id + '] Extraction failed');
      return origSend.call(xhr, body);
    }

    var mem = parseMemoryTrigger(rawMsg);
    fetchContext(mem.stripped, mem.writeMemory).then(function (context) {
      parsed.messages.unshift({
        id: uuidv4(), author: { role: 'system' },
        content: { content_type: 'text', parts: [context] }, metadata: {},
      });
      LOG('[' + id + '] XHR INJECTION SUCCESS');
      origSend.call(xhr, JSON.stringify(parsed));
    }).catch(function (err) {
      WARN('[' + id + '] Backend failed — fail-safe');
      origSend.call(xhr, body);
    });
  };

  // -------------------- METHOD 3: SERVICE WORKER CHECK --------------------
  if (pw.navigator && pw.navigator.serviceWorker) {
    LOG('Service Worker controller: ' + (pw.navigator.serviceWorker.controller ? 'ACTIVE (' + pw.navigator.serviceWorker.controller.scriptURL + ')' : 'none'));
    pw.navigator.serviceWorker.addEventListener('controllerchange', function () {
      LOG('Service Worker controller CHANGED: ' + (pw.navigator.serviceWorker.controller ? pw.navigator.serviceWorker.controller.scriptURL : 'none'));
    });
  }

  // -------------------- METHOD 4: Also wrap on sandbox window --------------------
  // In case some code goes through the sandbox's fetch
  if (pw !== window) {
    try {
      var sandboxRealFetch = window.fetch;
      window.fetch = function () {
        var url = '';
        try {
          if (typeof arguments[0] === 'string') url = arguments[0];
          else if (arguments[0] && arguments[0].url) url = arguments[0].url;
        } catch (e) {}
        if (url.indexOf('conversation') !== -1 || url.indexOf('sentinel') !== -1) {
          LOG('[SANDBOX] fetch detected: ' + url);
        }
        return sandboxRealFetch.apply(window, arguments);
      };
      LOG('Sandbox window.fetch also wrapped');
    } catch (e) {}
  }

  LOG('v3.6.0 ready — logging ALL fetch/XHR URLs. Send a message and check console.');
})();
