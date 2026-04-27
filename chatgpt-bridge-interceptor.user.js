// ==UserScript==
// @name         ChatGPT Bridge — Network Interceptor
// @namespace    https://midnightswitchboard.net/bridge
// @version      3.0.0
// @description  Pure context pipeline: intercepts /backend-api/conversation, fetches raw context (time+memory+identity) from Laravel, injects as system message. ChatGPT operates with bridge context natively.
// @author       hezarfen4
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
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
  const MEMORY_TOKEN = /(^|\s)\/remember(?=\s|$)/gi;  // Standalone token only, case-insensitive, global
  // ===============================================================

  // Session ID — persistent across page loads
  let SESSION_ID = localStorage.getItem('bridge_session_id');
  if (!SESSION_ID) {
    SESSION_ID = 'Steer-Primary-Context';
    localStorage.setItem('bridge_session_id', SESSION_ID);
  }

  // Generate a UUID v4 for injected message IDs
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Extract the user's message text from ChatGPT's payload
  function extractUserMessage(payload) {
    if (!payload || !payload.messages || !payload.messages.length) return '';
    // The last message in the array is typically the user's message
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

  // Check for /remember trigger token. Returns { stripped, writeMemory }.
  // Strips ALL standalone occurrences and normalizes whitespace.
  function parseMemoryTrigger(text) {
    MEMORY_TOKEN.lastIndex = 0;  // Reset regex state (global flag)
    const hasToken = MEMORY_TOKEN.test(text);
    if (!hasToken) return { stripped: text, writeMemory: false };
    MEMORY_TOKEN.lastIndex = 0;  // Reset again after test()
    const stripped = text.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
    return { stripped, writeMemory: true };
  }

  // Fetch context from the Laravel backend using GM_xmlhttpRequest (bypasses CORS)
  function fetchContext(messageText, writeMemory) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge timeout')), TIMEOUT_MS);

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
        onload(res) {
          clearTimeout(timer);
          try {
            const body = JSON.parse(res.responseText);
            if (body.success && body.injected_context) {
              resolve(body.injected_context);
            } else {
              reject(new Error('backend returned success=false or empty context'));
            }
          } catch (e) {
            reject(new Error('bridge parse error: ' + e.message));
          }
        },
        onerror() {
          clearTimeout(timer);
          reject(new Error('bridge network error'));
        },
      });
    });
  }

  // Dedup guard: track in-flight requests by a hash of the user message
  const pendingRequests = new Set();

  function messageHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString();
  }

  // ======================== FETCH OVERRIDE ========================
  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    // Determine the URL
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    } else if (input && input.toString) {
      url = input.toString();
    }

    // STRICT SCOPE: Only intercept POST to /backend-api/conversation
    const isConversation = url.includes('/backend-api/conversation');
    const isPost = init && init.method && init.method.toUpperCase() === 'POST';

    if (!isConversation || !isPost) {
      return originalFetch.call(this, input, init);
    }

    // Parse the request body
    let body;
    try {
      body = JSON.parse(init.body);
    } catch (e) {
      // Can't parse body — pass through unchanged (fail-safe)
      console.warn('[Bridge] Could not parse request body, passing through');
      return originalFetch.call(this, input, init);
    }

    // Extract user message
    const rawUserMessage = extractUserMessage(body);
    if (!rawUserMessage) {
      // No user message found — pass through unchanged
      return originalFetch.call(this, input, init);
    }

    // Parse memory trigger token
    const { stripped: userMessage, writeMemory } = parseMemoryTrigger(rawUserMessage);

    // If trigger token was present, strip it from the ChatGPT payload too
    if (writeMemory) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i];
        if (msg.author && msg.author.role === 'user' && msg.content && msg.content.parts) {
          msg.content.parts = msg.content.parts.map(function (p) {
            if (typeof p !== 'string') return p;
            MEMORY_TOKEN.lastIndex = 0;
            return p.replace(MEMORY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim();
          });
          break;
        }
      }
      console.log('[Bridge] MEMORY WRITE REQUESTED — /remember token detected and stripped');
    }

    // ONE-CALL SANITY: Dedup guard
    const hash = messageHash(rawUserMessage);
    if (pendingRequests.has(hash)) {
      // Already processing this exact message — pass through
      return originalFetch.call(this, input, init);
    }

    pendingRequests.add(hash);

    try {
      // Fetch context from Laravel backend (exactly one call)
      console.log('[Bridge] Intercepted /backend-api/conversation — fetching context (write_memory: ' + writeMemory + ')...');
      const context = await fetchContext(userMessage, writeMemory);

      // IMMUTABILITY: Insert the context as-is, no trimming or alteration
      // Create a system message in ChatGPT's expected format
      const systemMessage = {
        id: uuidv4(),
        author: { role: 'system' },
        content: {
          content_type: 'text',
          parts: [context],
        },
        metadata: {},
      };

      // Prepend the system message before the user's message
      body.messages.unshift(systemMessage);

      // Replace the body with the modified payload
      init.body = JSON.stringify(body);

      console.log('[Bridge] Context injected successfully. Sending modified request.');
    } catch (err) {
      // FAIL-SAFE: If backend call fails, send original message unchanged
      console.warn('[Bridge] Backend call failed (' + err.message + ') — sending original message');
    } finally {
      pendingRequests.delete(hash);
    }

    return originalFetch.call(this, input, init);
  };

  console.log('[Bridge] ChatGPT Network Interceptor v3.0.0 loaded — pure context pipeline active');
  console.log('[Bridge] Memory gate: type /remember anywhere in your message to trigger a memory write');
})();
