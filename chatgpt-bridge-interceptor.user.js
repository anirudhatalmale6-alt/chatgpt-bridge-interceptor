// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.5.0
// @description  Aggressive message extraction for all model payloads (gpt-5-4-thinking etc). Fetch + XHR intercept, action:next injection.
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

  // Deep-inspect a single message object and try to extract text
  function getTextFromMessage(msg) {
    if (!msg) return '';
    // content.parts[] (standard ChatGPT format)
    if (msg.content && msg.content.parts && Array.isArray(msg.content.parts)) {
      var textParts = msg.content.parts.filter(function (p) { return typeof p === 'string' && p.trim(); });
      if (textParts.length > 0) return textParts.join('\n');
    }
    // content as string
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
    // content.text
    if (msg.content && msg.content.text && typeof msg.content.text === 'string') {
      return msg.content.text;
    }
    // text field directly on message
    if (msg.text && typeof msg.text === 'string' && msg.text.trim()) {
      return msg.text;
    }
    // parts at top level of message
    if (msg.parts && Array.isArray(msg.parts)) {
      var tp = msg.parts.filter(function (p) { return typeof p === 'string' && p.trim(); });
      if (tp.length > 0) return tp.join('\n');
    }
    return '';
  }

  function extractUserMessage(payload) {
    // Dump full message structure for diagnostics
    if (payload.messages && Array.isArray(payload.messages)) {
      LOG('  EXTRACT: messages array has ' + payload.messages.length + ' items');
      for (var d = 0; d < payload.messages.length; d++) {
        var dm = payload.messages[d];
        var dRole = 'none';
        if (dm.author && dm.author.role) dRole = 'author.role=' + dm.author.role;
        else if (dm.role) dRole = 'role=' + dm.role;
        var dContentType = 'none';
        if (dm.content) {
          if (typeof dm.content === 'string') dContentType = 'string(' + dm.content.length + ')';
          else if (dm.content.parts) dContentType = 'parts[' + dm.content.parts.length + ']';
          else if (dm.content.text) dContentType = 'text(' + dm.content.text.length + ')';
          else dContentType = 'object(keys:' + Object.keys(dm.content).join(',') + ')';
        }
        var dKeys = Object.keys(dm).join(',');
        LOG('  EXTRACT: [' + d + '] ' + dRole + ' | content: ' + dContentType + ' | keys: ' + dKeys);
        var dText = getTextFromMessage(dm);
        if (dText) LOG('  EXTRACT: [' + d + '] text preview: "' + dText.substring(0, 80) + '"');
      }
    }

    // Pass 1: Look for role=user (standard)
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var i = payload.messages.length - 1; i >= 0; i--) {
        var msg = payload.messages[i];
        var role = (msg.author && msg.author.role) || msg.role || '';
        if (role === 'user') {
          var text = getTextFromMessage(msg);
          if (text) { LOG('  EXTRACT: Found via role=user at [' + i + ']'); return text; }
        }
      }
    }

    // Pass 2: Look for any message with text content (last one that has text, skip system/tool)
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var j = payload.messages.length - 1; j >= 0; j--) {
        var msg2 = payload.messages[j];
        var role2 = (msg2.author && msg2.author.role) || msg2.role || '';
        if (role2 === 'system' || role2 === 'tool') continue;
        var text2 = getTextFromMessage(msg2);
        if (text2) { LOG('  EXTRACT: Found via fallback at [' + j + '] (role=' + role2 + ')'); return text2; }
      }
    }

    // Pass 3: ANY message with text, regardless of role
    if (payload.messages && Array.isArray(payload.messages)) {
      for (var k = payload.messages.length - 1; k >= 0; k--) {
        var text3 = getTextFromMessage(payload.messages[k]);
        if (text3) { LOG('  EXTRACT: Found via any-message at [' + k + ']'); return text3; }
      }
    }

    // Pass 4: Singular message object
    if (payload.message) {
      var text4 = getTextFromMessage(payload.message);
      if (text4) { LOG('  EXTRACT: Found via payload.message'); return text4; }
    }

    // Pass 5: prompt field
    if (payload.prompt && typeof payload.prompt === 'string') {
      LOG('  EXTRACT: Found via payload.prompt');
      return payload.prompt;
    }

    // Pass 6: Deep search — look for any string in the payload that looks like user text
    LOG('  EXTRACT: All passes failed. Dumping payload structure...');
    try { LOG('  EXTRACT: Full payload: ' + JSON.stringify(payload).substring(0, 500)); } catch (e) {}
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
    LOG('  -> Calling backend: ' + API_ENDPOINT);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        WARN('  -> Backend timed out');
        reject(new Error('timeout'));
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
          LOG('  -> Backend HTTP ' + res.status);
          if (res.status !== 200) {
            WARN('  -> Error: ' + (res.responseText || '').substring(0, 300));
            reject(new Error('HTTP ' + res.status));
            return;
          }
          try {
            var body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) {
              LOG('  -> Context: ' + body.injected_context.length + ' chars');
              resolve(body.injected_context);
            } else {
              WARN('  -> No context (success=' + body.success + ')');
              reject(new Error('no context'));
            }
          } catch (e) {
            WARN('  -> Parse error');
            reject(new Error('parse'));
          }
        },
        onerror: function () {
          clearTimeout(timer);
          WARN('  -> Network error');
          reject(new Error('network'));
        },
      });
    });
  }

  // Describe a value's type in detail
  function describeType(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    var t = typeof val;
    if (t === 'string') return 'string(' + val.length + ')';
    if (t === 'number' || t === 'boolean') return t + '(' + val + ')';
    if (t === 'object' || t === 'function') {
      var name = '';
      try { name = val.constructor ? val.constructor.name : ''; } catch (e) {}
      if (!name) name = Object.prototype.toString.call(val);
      return name || t;
    }
    return t;
  }

  // Attempt to read body from ANY source, with logging at every step
  async function readBodyExhaustive(input, init, pw) {
    var attempts = [];

    // Attempt 1: init.body as string
    if (init && init.body != null && typeof init.body === 'string') {
      attempts.push('init.body(string) = SUCCESS');
      return { text: init.body, attempts: attempts };
    }

    // Attempt 2: init.body as other type
    if (init && init.body != null) {
      var bodyType = describeType(init.body);
      attempts.push('init.body type: ' + bodyType);

      // ReadableStream (check multiple ways)
      var isStream = false;
      try { isStream = (pw.ReadableStream && init.body instanceof pw.ReadableStream); } catch (e) {}
      if (!isStream) { try { isStream = (init.body.getReader && typeof init.body.getReader === 'function'); } catch (e) {} }

      if (isStream) {
        attempts.push('init.body is ReadableStream, reading...');
        try {
          var reader = init.body.getReader();
          var chunks = [];
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
          }
          var text = chunks.map(function (c) { return new TextDecoder().decode(c); }).join('');
          attempts.push('ReadableStream read: ' + text.length + ' chars');
          return { text: text, attempts: attempts };
        } catch (e) {
          attempts.push('ReadableStream FAILED: ' + e.message);
        }
      }

      // Blob
      var isBlob = false;
      try { isBlob = (init.body instanceof Blob) || (pw.Blob && init.body instanceof pw.Blob); } catch (e) {}
      if (isBlob) {
        attempts.push('init.body is Blob, reading...');
        try {
          var bt = await init.body.text();
          attempts.push('Blob read: ' + bt.length + ' chars');
          return { text: bt, attempts: attempts };
        } catch (e) { attempts.push('Blob FAILED: ' + e.message); }
      }

      // ArrayBuffer
      var isAB = false;
      try { isAB = (init.body instanceof ArrayBuffer) || (pw.ArrayBuffer && init.body instanceof pw.ArrayBuffer); } catch (e) {}
      if (isAB) {
        attempts.push('init.body is ArrayBuffer');
        try {
          var abt = new TextDecoder().decode(init.body);
          return { text: abt, attempts: attempts };
        } catch (e) { attempts.push('ArrayBuffer FAILED: ' + e.message); }
      }

      // TypedArray
      try {
        if (ArrayBuffer.isView && ArrayBuffer.isView(init.body)) {
          attempts.push('init.body is TypedArray');
          var tat = new TextDecoder().decode(init.body);
          return { text: tat, attempts: attempts };
        }
      } catch (e) {}

      // toString fallback
      attempts.push('Trying init.body.toString()...');
      try {
        var s = init.body.toString();
        if (s && s !== '[object Object]' && s !== '[object ReadableStream]') {
          attempts.push('toString: ' + s.length + ' chars');
          return { text: s, attempts: attempts };
        } else {
          attempts.push('toString unhelpful: "' + s.substring(0, 50) + '"');
        }
      } catch (e) { attempts.push('toString FAILED'); }
    } else {
      attempts.push('init.body is ' + (init ? describeType(init.body) : 'no init'));
    }

    // Attempt 3: Read from Request object (input)
    if (input && typeof input === 'object') {
      var isRequest = false;
      try { isRequest = (input instanceof Request); } catch (e) {}
      if (!isRequest) { try { isRequest = (pw.Request && input instanceof pw.Request); } catch (e) {} }
      if (!isRequest) { try { isRequest = (typeof input.clone === 'function' && typeof input.text === 'function'); } catch (e) {} }

      if (isRequest) {
        attempts.push('input is Request, cloning and reading...');
        try {
          var cloned = input.clone();
          var reqText = await cloned.text();
          attempts.push('Request.text(): ' + reqText.length + ' chars');
          return { text: reqText, attempts: attempts };
        } catch (e) { attempts.push('Request.text() FAILED: ' + e.message); }

        // Try arrayBuffer fallback
        try {
          var cloned2 = input.clone();
          var ab = await cloned2.arrayBuffer();
          var decoded = new TextDecoder().decode(ab);
          attempts.push('Request.arrayBuffer(): ' + decoded.length + ' chars');
          return { text: decoded, attempts: attempts };
        } catch (e) { attempts.push('Request.arrayBuffer() FAILED: ' + e.message); }
      } else {
        attempts.push('input is not a Request (type: ' + describeType(input) + ')');
      }
    }

    return { text: null, attempts: attempts };
  }

  // ======================== INTERCEPT SETUP ========================
  var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // -------------------- FETCH OVERRIDE --------------------
  var originalFetch = pageWindow.fetch.bind(pageWindow);
  var fetchCallCount = 0;

  pageWindow.fetch = async function (input, init) {
    // Get URL from any input type
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input === 'object') {
      try { url = input.url || ''; } catch (e) {}
    }

    // BROAD MATCH: log anything with "conversation" in URL
    if (url.indexOf('conversation') === -1) {
      return originalFetch(input, init);
    }

    fetchCallCount++;
    var callId = 'F' + fetchCallCount;

    LOG('========================================');
    LOG('[' + callId + '] FETCH DETECTED');
    LOG('[' + callId + '] URL: ' + url);
    LOG('[' + callId + '] input type: ' + describeType(input));
    LOG('[' + callId + '] init present: ' + !!init);
    if (init) {
      LOG('[' + callId + '] init.method: ' + (init.method || 'undefined'));
      LOG('[' + callId + '] init.body type: ' + describeType(init.body));
      LOG('[' + callId + '] init keys: ' + Object.keys(init).join(', '));
    }

    // Read body
    var result = await readBodyExhaustive(input, init, pageWindow);
    LOG('[' + callId + '] Body read attempts:');
    for (var a = 0; a < result.attempts.length; a++) {
      LOG('[' + callId + ']   ' + result.attempts[a]);
    }

    if (!result.text) {
      WARN('[' + callId + '] BODY READ FAILED — all attempts exhausted, passing through');
      LOG('========================================');
      return originalFetch(input, init);
    }

    LOG('[' + callId + '] Body length: ' + result.text.length);
    LOG('[' + callId + '] Body preview: ' + result.text.substring(0, 300));

    // Parse JSON
    var body;
    try {
      body = JSON.parse(result.text);
    } catch (e) {
      WARN('[' + callId + '] NOT JSON: ' + e.message);
      LOG('========================================');
      // Re-send with string body (stream was consumed)
      var fi = {};
      if (init) { for (var k in init) { if (k !== 'body') fi[k] = init[k]; } }
      fi.body = result.text;
      if (!fi.method) fi.method = 'POST';
      return originalFetch(url, fi);
    }

    LOG('[' + callId + '] JSON keys: ' + Object.keys(body).join(', '));
    LOG('[' + callId + '] action: ' + (body.action === undefined ? 'UNDEFINED' : '"' + body.action + '"'));
    if (body.messages) {
      LOG('[' + callId + '] messages: ' + (Array.isArray(body.messages) ? body.messages.length + ' items' : describeType(body.messages)));
      if (Array.isArray(body.messages)) {
        for (var mi = 0; mi < body.messages.length; mi++) {
          var mm = body.messages[mi];
          var rr = (mm.author && mm.author.role) || mm.role || 'no-role';
          var preview = '';
          if (mm.content && mm.content.parts) preview = (mm.content.parts[0] || '').substring(0, 50);
          else if (mm.content && typeof mm.content === 'string') preview = mm.content.substring(0, 50);
          LOG('[' + callId + ']   [' + mi + '] role=' + rr + ' content="' + preview + '"');
        }
      }
    }
    if (body.model) LOG('[' + callId + '] model: ' + body.model);

    // Check if this is a primary send (action: "next")
    var action = body.action === undefined ? '' : body.action;
    if (action !== 'next') {
      LOG('[' + callId + '] SKIPPING — action is not "next"');
      LOG('========================================');
      var si = {};
      if (init) { for (var sk in init) { if (sk !== 'body') si[sk] = init[sk]; } }
      si.body = result.text;
      if (!si.method) si.method = 'POST';
      return originalFetch(url, si);
    }

    // === PRIMARY SEND: action:"next" ===
    LOG('[' + callId + '] *** PRIMARY SEND DETECTED (action:next) ***');

    var rawUserMessage = extractUserMessage(body);
    if (!rawUserMessage) {
      WARN('[' + callId + '] Could not extract user message from payload');
      LOG('========================================');
      var ni = {};
      if (init) { for (var nk in init) { if (nk !== 'body') ni[nk] = init[nk]; } }
      ni.body = result.text;
      if (!ni.method) ni.method = 'POST';
      return originalFetch(url, ni);
    }

    LOG('[' + callId + '] User message: "' + rawUserMessage.substring(0, 100) + '"');

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
      LOG('[' + callId + '] /remember stripped');
    }

    // Fetch context and inject
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

      var modifiedBody = JSON.stringify(body);
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

      LOG('[' + callId + '] INJECTION SUCCESS (' + context.length + ' chars)');
      LOG('========================================');
      return originalFetch(url, newInit);
    } catch (err) {
      WARN('[' + callId + '] Backend failed (' + err.message + ') — fail-safe');
      LOG('========================================');
    }

    // Fail-safe: send with original body string
    var fallback = {};
    if (init) { for (var fk in init) { if (fk !== 'body') fallback[fk] = init[fk]; } }
    fallback.body = result.text;
    if (!fallback.method) fallback.method = 'POST';
    return originalFetch(url, fallback);
  };

  // -------------------- XHR OVERRIDE --------------------
  var OrigXHR = pageWindow.XMLHttpRequest;
  var xhrProto = OrigXHR.prototype;
  var origOpen = xhrProto.open;
  var origSend = xhrProto.send;
  var xhrCallCount = 0;

  xhrProto.open = function (method, url) {
    this._bridgeMethod = method;
    this._bridgeUrl = url;
    return origOpen.apply(this, arguments);
  };

  xhrProto.send = function (body) {
    var xhr = this;
    var url = xhr._bridgeUrl || '';

    if (url.indexOf('conversation') === -1) {
      return origSend.apply(xhr, arguments);
    }

    xhrCallCount++;
    var callId = 'X' + xhrCallCount;
    var method = (xhr._bridgeMethod || '').toUpperCase();

    LOG('========================================');
    LOG('[' + callId + '] XHR DETECTED');
    LOG('[' + callId + '] URL: ' + url);
    LOG('[' + callId + '] Method: ' + method);
    LOG('[' + callId + '] Body type: ' + describeType(body));
    if (typeof body === 'string') {
      LOG('[' + callId + '] Body length: ' + body.length);
      LOG('[' + callId + '] Body preview: ' + body.substring(0, 300));
    }

    if (method !== 'POST' || typeof body !== 'string') {
      LOG('[' + callId + '] Not a POST with string body, passing through');
      LOG('========================================');
      return origSend.apply(xhr, arguments);
    }

    // Try to parse and check action
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      LOG('[' + callId + '] Not JSON, passing through');
      LOG('========================================');
      return origSend.apply(xhr, arguments);
    }

    LOG('[' + callId + '] JSON keys: ' + Object.keys(parsed).join(', '));
    LOG('[' + callId + '] action: ' + (parsed.action === undefined ? 'UNDEFINED' : '"' + parsed.action + '"'));

    if (parsed.action !== 'next') {
      LOG('[' + callId + '] Not action:next, passing through');
      LOG('========================================');
      return origSend.call(xhr, body);
    }

    LOG('[' + callId + '] *** PRIMARY SEND (XHR, action:next) ***');

    var rawMsg = extractUserMessage(parsed);
    LOG('[' + callId + '] User message: "' + (rawMsg || 'NOT FOUND').substring(0, 100) + '"');

    if (!rawMsg) {
      LOG('========================================');
      return origSend.call(xhr, body);
    }

    var mem = parseMemoryTrigger(rawMsg);

    fetchContext(mem.stripped, mem.writeMemory).then(function (context) {
      var sysMsg = {
        id: uuidv4(),
        author: { role: 'system' },
        content: { content_type: 'text', parts: [context] },
        metadata: {},
      };
      if (parsed.messages && Array.isArray(parsed.messages)) {
        parsed.messages.unshift(sysMsg);
      } else {
        parsed.messages = [sysMsg];
      }
      LOG('[' + callId + '] INJECTION SUCCESS (XHR, ' + context.length + ' chars)');
      LOG('========================================');
      origSend.call(xhr, JSON.stringify(parsed));
    }).catch(function (err) {
      WARN('[' + callId + '] Backend failed: ' + err.message + ' — fail-safe');
      LOG('========================================');
      origSend.call(xhr, body);
    });
  };

  LOG('v3.5.0 loaded — aggressive extraction for all model payloads');
  LOG('Watching: fetch + XHR, filter: action:next');
  LOG('Memory gate: /remember triggers write');
})();
