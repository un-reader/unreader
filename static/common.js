//! DON'T FORGET TO CHANGE TO `false` BEFORE PUSHING
const DEBUG = false;
const DO_LOGGING = true;
var MESSAGE_REACTIONS = {};
var MESSAGE_REACTION_TAGS = {};
var MESSAGE_REACTIONS_LOADED = false;

function parseReactionCsvRow(line) {
  var fields = [];
  var field = '';
  var quoted = false;
  for (var i = 0; i < line.length; i++) {
    var character = line.charAt(i);
    if (character === '"' && quoted && line.charAt(i + 1) === '"') {
      field += '"';
      i++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}
var MESSAGE_REACTIONS_READY = new Promise(function (resolve) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'reaction-emoticons.csv', true);
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      var lines = xhr.responseText.replace(/^\uFEFF/, '').split(/\r?\n/);
      for (var i = 1; i < lines.length; i++) {
        var columns = parseReactionCsvRow(lines[i]);
        var code = Number(columns[0]);
        var emoticon = columns[1];
        if (Number.isInteger(code) && code > 0 && code <= 32767 && emoticon) {
          MESSAGE_REACTIONS[code] = emoticon;
          MESSAGE_REACTION_TAGS[code] = columns[2] || '';
        }
      }
    }
    MESSAGE_REACTIONS_LOADED = true;
    resolve();
  };
  xhr.onerror = function () {
    MESSAGE_REACTIONS_LOADED = true;
    resolve();
  };
  xhr.send();
});
if (DEBUG) {
  const debugScript = document.createElement('script');
  debugScript.src = 'debug-console.js';
  document.head.appendChild(debugScript);
}
var BACKEND_URL = DEBUG ?
  'http://127.0.0.1:80' :
  window.location.origin;
var WS_URL = DEBUG ?
  'ws://127.0.0.1:80' :
  window.location.origin.replace('https', 'wss').replace('http', 'ws');

var UnreaderBotPasswordVault = (function () {
  // The saved BotPassword is locked with a PIN that exists only in the user's
  // head and browser. It is never sent to the server and is unrelated to the
  // account password.
  //
  // Optionally the browser can also remember the *derived key* on this device
  // (a non-exportable CryptoKey kept in IndexedDB). That lets the key fill
  // itself in with no PIN, because Fandom BotPasswords are long and cannot be
  // changed, so retyping them is the whole problem this vault exists to solve.
  // The remembered key can decrypt but can never be read out or copied.
  var iterations = 600000;
  var minPinLength = 6;
  var contextName = 'unreader-fandom-botpassword-pin-v2';
  var context = new TextEncoder().encode(contextName);
  var DEVICE_DB = 'unreader-vault';
  var DEVICE_STORE = 'keys';
  var DEVICE_KEY = 'fandom-botpassword';

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function pinProblem(pin) {
    if (typeof pin !== 'string' || pin.length < minPinLength) return 'Your PIN must be at least ' + minPinLength + ' characters.';
    return '';
  }

  function recordProblem(record) {
    if (record && record.version === 1) return 'This saved key uses an older format. Save it again with a PIN to replace it.';
    if (!record || record.version !== 2 || record.context !== contextName || record.kdf !== 'PBKDF2-SHA-256' || record.iterations !== iterations || record.cipher !== 'AES-GCM-256') {
      return 'Saved Fandom credential format is unsupported.';
    }
    return '';
  }

  function deriveKey(pin, salt) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error('Encrypted credential storage requires HTTPS and Web Crypto support.'));
    return window.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'])
      .then(function (material) {
        return window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // Encrypts with a fresh salt and returns both the record and the key, so the
  // key can be remembered on this device without deriving it a second time.
  function encryptWithNewKey(pin, value) {
    var problem = pinProblem(pin);
    if (problem) return Promise.reject(new Error(problem));
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pin, salt).then(function (key) {
      return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: context }, key,
        new TextEncoder().encode(JSON.stringify(value))).then(function (encrypted) {
          return {
            key: key,
            data: {
              version: 2,
              context: contextName,
              kdf: 'PBKDF2-SHA-256',
              iterations: iterations,
              cipher: 'AES-GCM-256',
              salt: bytesToBase64(salt),
              iv: bytesToBase64(iv),
              ciphertext: bytesToBase64(new Uint8Array(encrypted))
            }
          };
        });
    });
  }

  function openWithKey(key, record) {
    return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv), additionalData: context }, key, base64ToBytes(record.ciphertext))
      .then(function (clear) {
        return JSON.parse(new TextDecoder().decode(clear));
      }, function () {
        throw new Error('Could not unlock the saved Fandom BotPassword. Check your PIN.');
      });
  }

  // ---- remembered key, per device (IndexedDB; every failure is non-fatal) ----
  function deviceOp(mode, run) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('This browser cannot remember a key.'));
      var open = window.indexedDB.open(DEVICE_DB, 1);
      open.onupgradeneeded = function () { open.result.createObjectStore(DEVICE_STORE); };
      open.onerror = function () { reject(open.error || new Error('Could not open device storage.')); };
      open.onsuccess = function () {
        var db = open.result;
        try {
          var tx = db.transaction(DEVICE_STORE, mode);
          var req = run(tx.objectStore(DEVICE_STORE));
          tx.oncomplete = function () {
            db.close();
            resolve(req.result);
          };
          tx.onerror = tx.onabort = function () {
            db.close();
            reject(tx.error || new Error('Device storage failed.'));
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }

  // Resolves true if the key is now remembered, false if the browser refused.
  function rememberKey(salt, key) {
    return deviceOp('readwrite', function (store) { return store.put({ salt: salt, key: key }, DEVICE_KEY); })
      .then(function () { return true; }, function () { return false; });
  }

  function forgetDevice() {
    return deviceOp('readwrite', function (store) { return store.delete(DEVICE_KEY); })
      .then(function () { return true; }, function () { return false; });
  }

  function request(method, data) {
    var token = localStorage.getItem('token');
    if (!token) return Promise.reject(new Error('Sign in to your Unreader account first.'));
    var options = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
    return fetch(BACKEND_URL + '/api/user/fandom-botpassword', options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Credential vault request failed.');
        return body;
      });
    });
  }

  // Resolves { remembered } (whether this device will now fill the key in unaided).
  function save(username, password, pin, remember) {
    return encryptWithNewKey(pin, { username: username, password: password }).then(function (result) {
      return request('PUT', { data: result.data }).then(function () {
        return remember ? rememberKey(result.data.salt, result.key) : forgetDevice().then(function () { return false; });
      });
    }).then(function (remembered) { return { remembered: remembered }; });
  }

  // Unlocks with the PIN. Resolves { username, password, remembered }.
  function load(pin, remember) {
    var record;
    return request('GET').then(function (response) {
      if (!response.data) throw new Error('No saved Fandom BotPassword was found.');
      record = response.data;
      var problem = recordProblem(record);
      if (problem) throw new Error(problem);
      return deriveKey(pin, base64ToBytes(record.salt));
    }).then(function (key) {
      return openWithKey(key, record).then(function (clear) {
        var after = remember ? rememberKey(record.salt, key) : forgetDevice().then(function () { return false; });
        return after.then(function (remembered) {
          return { username: clear.username, password: clear.password, remembered: remembered };
        });
      });
    });
  }

  // Tries to unlock using only the key remembered on this device. Resolves
  // { saved: false }, { saved: true, credential: null } when a PIN is needed,
  // or { saved: true, credential: { username, password } }.
  function unlockOnDevice() {
    return request('GET').then(function (response) {
      var record = response.data;
      if (!record) return forgetDevice().then(function () { return { saved: false }; });
      if (recordProblem(record)) return { saved: true, credential: null };
      return deviceOp('readonly', function (store) { return store.get(DEVICE_KEY); }).then(function (cached) {
        // A key remembered for an older save has a different salt: ignore it.
        if (!cached || !cached.key || cached.salt !== record.salt) return { saved: true, credential: null };
        return openWithKey(cached.key, record).then(function (clear) {
          return { saved: true, credential: { username: clear.username, password: clear.password } };
        }, function () {
          return forgetDevice().then(function () { return { saved: true, credential: null }; });
        });
      }, function () { return { saved: true, credential: null }; });
    });
  }

  function hasSaved() {
    return request('GET').then(function (response) { return !!response.data; });
  }

  return {
    minPinLength: minPinLength,
    pinProblem: pinProblem,
    save: save,
    load: load,
    unlockOnDevice: unlockOnDevice,
    hasSaved: hasSaved,
    forgetDevice: forgetDevice,
    remove: function () { return request('DELETE').then(function (r) { return forgetDevice().then(function () { return r; }); }); }
  };
}());

var UnreaderGitHubTokenVault = (function () {
  var iterations = 600000;
  var minPinLength = 6;
  var contextName = 'unreader-github-token-pin-v2';
  var context = new TextEncoder().encode(contextName);

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function pinProblem(pin) {
    if (typeof pin !== 'string' || pin.length < minPinLength) return 'Your PIN must be at least ' + minPinLength + ' characters.';
    return '';
  }

  function recordProblem(record) {
    if (record && record.version === 1) return 'This saved GitHub key uses an older format. Save it again with a PIN.';
    if (!record || record.version !== 2 || record.context !== contextName || record.kdf !== 'PBKDF2-SHA-256' || record.iterations !== iterations || record.cipher !== 'AES-GCM-256') {
      return 'Saved GitHub key format is unsupported.';
    }
    return '';
  }

  function deriveKey(pin, salt) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error('Encrypted key storage requires HTTPS and Web Crypto support.'));
    return window.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'])
      .then(function (material) {
        return window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  function request(method, data) {
    var token = localStorage.getItem('token');
    if (!token) return Promise.reject(new Error('Sign in to your Unreader account to save or load a GitHub key.'));
    var options = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
    return fetch(BACKEND_URL + '/api/user/github-token-vault', options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'GitHub key vault request failed.');
        return body;
      });
    });
  }

  function save(value, pin) {
    var problem = pinProblem(pin);
    if (problem) return Promise.reject(new Error(problem));
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pin, salt).then(function (key) {
      return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: context }, key,
        new TextEncoder().encode(JSON.stringify(value)));
    }).then(function (encrypted) {
      return request('PUT', { data: {
        version: 2,
        context: contextName,
        kdf: 'PBKDF2-SHA-256',
        iterations: iterations,
        cipher: 'AES-GCM-256',
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted))
      } });
    });
  }

  function load(pin, record) {
    var problem = pinProblem(pin);
    if (problem) return Promise.reject(new Error(problem));
    var invalid = recordProblem(record);
    if (invalid) return Promise.reject(new Error(invalid));
    return deriveKey(pin, base64ToBytes(record.salt)).then(function (key) {
      return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv), additionalData: context }, key, base64ToBytes(record.ciphertext)).catch(function () {
        throw new Error('Could not unlock the saved GitHub key. Check your PIN.');
      });
    }).then(function (clear) {
      return JSON.parse(new TextDecoder().decode(clear));
    });
  }

  return {
    minPinLength: minPinLength,
    pinProblem: pinProblem,
    status: function () { return request('GET'); },
    save: save,
    load: load,
    remove: function () { return request('DELETE'); }
  };
}());

function startRichPresence(mode) {
  const token = localStorage.getItem('token');
  if (!token) return;

  let socket;
  let stopped = false;
  let reconnectTimer;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(WS_URL);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
    socket.onmessage = (event) => {
      try {
        const type = JSON.parse(event.data).type;
        if (type === 'terminated') {
          stopped = true;
          socket.close();
        } else if (type === 'auth_success' && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'switch_context', mode, target: '' }));
        }
      } catch (error) {
        log('Invalid rich presence packet:', error);
      }
    };
    socket.onclose = () => {
      if (!stopped) reconnectTimer = setTimeout(connect, 5000);
    };
  };
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
  }, { once: true });
  connect();
}

function log(...args) {
  if (DO_LOGGING) console.log(`[CLIENT]`, ...args);
}

function hide(selector) {
  if (typeof selector === 'string') selector = document.querySelector(selector);
  selector.classList.add('hide');
}

function show(selector) {
  if (typeof selector === 'string') selector = document.querySelector(selector);
  selector.classList.remove('hide');
}

function profilePictureDataUrl(imageData) {
  return typeof imageData === 'string' && imageData.length <= 700000 && /^[A-Za-z0-9+/]+={0,2}$/.test(imageData) ?
    `data:image/png;base64,${imageData}` :
    '';
}

function profilePictureDimensions(imageData) {
  if (!profilePictureDataUrl(imageData)) return 0;
  try {
    const bytes = atob(imageData.slice(0, 32));
    return bytes.length >= 24 ? new DataView(Uint8Array.from(bytes, (char) => char.charCodeAt(0)).buffer).getUint32(16) : 0;
  } catch (error) {
    return 0;
  }
}

function createProfilePicture(imageData, size) {
  const image = document.createElement('img');
  const displaySize = size === undefined ? 24 : size;
  image.className = 'profile-picture';
  image.alt = profilePictureDataUrl(imageData) ? 'Profile picture' : '';
  image.width = image.height = displaySize;
  image.style.width = image.style.height = displaySize + 'px';
  image.style.imageRendering = 'pixelated';
  image.src = profilePictureDataUrl(imageData) || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  return image;
}

function renderMessageReactions(messageContainer, data, socket) {
  if (!MESSAGE_REACTIONS_LOADED) {
    MESSAGE_REACTIONS_READY.then(function () {
      renderMessageReactions(messageContainer, data, socket);
    });
    return;
  }
  if (!Object.keys(MESSAGE_REACTIONS).length) return;
  var oldBar = messageContainer.querySelector('.message-reactions');
  if (oldBar) oldBar.parentNode.removeChild(oldBar);
  if (data.is_deleted || data.id === -1) return;

  var bar = document.createElement('div');
  bar.className = 'message-reactions';
  var message = messageContainer.querySelector('.message');
  var messageSide = message && message.style.float === 'right' ? 'right' : 'left';
  bar.style.float = messageSide;
  bar.style.clear = messageSide;
  var reactions = data.reactions || [];
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'message-reactions-toggle';
  toggle.textContent = 'REACTIONS';
  var menu = document.createElement('div');
  menu.className = 'message-reactions-menu';
  menu.style.display = 'none';
  toggle.onclick = function () {
    menu.style.display = menu.style.display === 'none' ? 'grid' : 'none';
  };
  bar.appendChild(toggle);
  var summary = document.createElement('span');
  summary.className = 'message-reaction-summary';
  for (var s = 0; s < reactions.length; s++) {
    var summaryItem = document.createElement('button');
    summaryItem.type = 'button';
    summaryItem.className = 'message-reaction-count' + (reactions[s].mine ? ' selected' : '');
    summaryItem.textContent = (MESSAGE_REACTIONS[Number(reactions[s].code)] || '?') + ' ' + reactions[s].count;
    summaryItem.setAttribute('aria-label', (reactions[s].mine ? 'Remove your ' : 'Add ') + (MESSAGE_REACTIONS[Number(reactions[s].code)] || 'reaction') + ' reaction');
    summaryItem.onclick = (function (reactionCode, messageId) {
      return function () {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'message_reaction', id: messageId, code: reactionCode }));
        }
      };
    })(Number(reactions[s].code), data.id);
    summary.appendChild(summaryItem);
  }
  bar.appendChild(summary);

  var search = document.createElement('input');
  search.type = 'text';
  search.className = 'message-reaction-search';
  search.placeholder = 'Search faces or tags';
  search.setAttribute('aria-label', 'Search reactions by face or tag');
  menu.appendChild(search);
  var noMatches = document.createElement('div');
  noMatches.className = 'message-reaction-no-matches';
  noMatches.textContent = 'No matching reactions.';
  noMatches.style.display = 'none';
  menu.appendChild(noMatches);
  var codes = Object.keys(MESSAGE_REACTIONS);
  var reactionButtons = [];
  for (var c = 0; c < codes.length; c++) {
    var code = Number(codes[c]);
    var current = null;
    for (var i = 0; i < reactions.length; i++) {
      if (Number(reactions[i].code) === code) current = reactions[i];
    }
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-reaction' + (current && current.mine ? ' selected' : '');
    button.textContent = MESSAGE_REACTIONS[code] + (current ? ' ' + current.count : '');
    button.setAttribute('aria-label', MESSAGE_REACTIONS[code] + ' reaction ' + MESSAGE_REACTION_TAGS[code]);
    button._searchText = (MESSAGE_REACTIONS[code] + ' ' + (MESSAGE_REACTION_TAGS[code] || '')).toLowerCase();
    button.onclick = (function (reactionCode, messageId) {
      return function () {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'message_reaction', id: messageId, code: reactionCode }));
          menu.style.display = 'none';
        }
      };
    })(code, data.id);
    menu.appendChild(button);
    reactionButtons.push(button);
  }
  search.oninput = function () {
    var terms = search.value.toLowerCase().trim().split(/\s+/);
    var visibleCount = 0;
    for (var i = 0; i < reactionButtons.length; i++) {
      var visible = true;
      for (var termIndex = 0; termIndex < terms.length; termIndex++) {
        if (terms[termIndex] && reactionButtons[i]._searchText.indexOf(terms[termIndex]) === -1) visible = false;
      }
      reactionButtons[i].style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    }
    noMatches.style.display = visibleCount ? 'none' : 'block';
  };
  bar.appendChild(menu);
  messageContainer.appendChild(bar);
}

function updateMessageReactions(data, socket) {
  var message = document.getElementById('msg-id-' + data.id);
  if (!message || !message.parentNode) return;
  renderMessageReactions(message.parentNode, data, socket);
}

function setupProfilePictureEditor(imageData = '') {
  const canvas = document.getElementById('edit-picture-canvas');
  const size = document.getElementById('edit-picture-size');
  const red = document.getElementById('edit-picture-red');
  const green = document.getElementById('edit-picture-green');
  const blue = document.getElementById('edit-picture-blue');
  const colorPreview = document.getElementById('edit-picture-color-preview');
  const file = document.getElementById('edit-picture-file');
  const clear = document.getElementById('edit-picture-clear');
  const undoButton = document.getElementById('edit-picture-undo');
  const redoButton = document.getElementById('edit-picture-redo');
  const preview = document.getElementById('picture-preview');
  const swatches = document.querySelectorAll('.profile-color-swatch');
  const ctx = canvas.getContext('2d');
  let selectedColor = '#000000';
  let original = document.createElement('canvas');
  let hasOriginal = false;
  let drawing = false;
  let lastPoint = null;
  let history = [];
  let historyIndex = -1;
  let historyLimit = 20;
  const updateColor = () => {
    const channels = [red, green, blue].map((input) => Math.max(0, Math.min(255, Number(input.value) || 0)));
    selectedColor = 'rgb(' + channels.join(',') + ')';
    colorPreview.style.backgroundColor = selectedColor;
    const hexColor = '#' + channels.map((value) => value.toString(16).padStart(2, '0')).join('');
    ['red', 'green', 'blue'].forEach((name, index) => {
      document.getElementById('edit-picture-' + name + '-value').textContent = channels[index];
    });
    swatches.forEach((swatch) => swatch.setAttribute('aria-pressed', String(swatch.dataset.color.toLowerCase() === hexColor)));
  };
  [red, green, blue].forEach((input) => input.oninput = updateColor);
  swatches.forEach((swatch) => {
    swatch.onclick = () => {
      const color = swatch.dataset.color;
      red.value = parseInt(color.slice(1, 3), 16);
      green.value = parseInt(color.slice(3, 5), 16);
      blue.value = parseInt(color.slice(5, 7), 16);
      updateColor();
    };
  });
  updateColor();
  const resize = (width, height, preserve) => {
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
    if (preserve) ctx.drawImage(preserve, 0, 0, width, height);
    canvas.parentElement.style.setProperty('--pixel-cell-size', (256 / width) + 'px');
  };
  const remember = () => {
    original = document.createElement('canvas');
    original.width = canvas.width;
    original.height = canvas.height;
    original.getContext('2d').drawImage(canvas, 0, 0);
    hasOriginal = true;
  };
  const updatePreview = () => {
    if (preview) preview.src = canvas.toDataURL('image/png');
  };
  const updateHistoryButtons = () => {
    if (undoButton) undoButton.disabled = historyIndex <= 0;
    if (redoButton) redoButton.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
  };
  const recordHistory = () => {
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot);
    if (history.length > historyLimit) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
    updatePreview();
  };
  const restoreHistory = (index) => {
    if (index < 0 || index >= history.length) return;
    historyIndex = index;
    const snapshot = history[historyIndex];
    size.value = String(snapshot.width);
    resize(snapshot.width, snapshot.height, snapshot);
    remember();
    updateHistoryButtons();
    updatePreview();
  };
  resize(Number(size.value), Number(size.value));
  size.onchange = () => {
    resize(Number(size.value), Number(size.value), hasOriginal ? original : canvas);
    remember();
    recordHistory();
  };

  const getPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width);
    const y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return { x: x, y: y };
  };
  const paintLine = (start, end) => {
    const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    ctx.fillStyle = selectedColor;
    for (let step = 0; step <= steps; step++) {
      const progress = steps ? step / steps : 0;
      const x = Math.round(start.x + (end.x - start.x) * progress);
      const y = Math.round(start.y + (end.y - start.y) * progress);
      ctx.fillRect(x, y, 1, 1);
    }
  };
  const finishStroke = () => {
    if (!drawing) return;
    drawing = false;
    lastPoint = null;
    remember();
    recordHistory();
  };
  canvas.onpointerdown = (event) => {
    event.preventDefault();
    drawing = true;
    lastPoint = getPoint(event);
    if (canvas.setPointerCapture && event.pointerId !== undefined) canvas.setPointerCapture(event.pointerId);
    if (lastPoint) paintLine(lastPoint, lastPoint);
  };
  canvas.onpointermove = (event) => {
    if (!drawing) return;
    event.preventDefault();
    const point = getPoint(event);
    if (!point) return;
    if (lastPoint) paintLine(lastPoint, point);
    else paintLine(point, point);
    lastPoint = point;
  };
  canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = finishStroke;
  clear.onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    remember();
    recordHistory();
  };
  if (undoButton) undoButton.onclick = () => restoreHistory(historyIndex - 1);
  if (redoButton) redoButton.onclick = () => restoreHistory(historyIndex + 1);

  let picker = file.parentElement;
  if (!picker.classList.contains('profile-picture-file')) {
    const wrapper = document.createElement('span');
    wrapper.className = 'profile-picture-file';
    file.parentNode.insertBefore(wrapper, file);
    wrapper.appendChild(file);
    file.classList.add('profile-picture-file-input');
    const browse = document.createElement('button');
    browse.type = 'button';
    browse.className = 'paper-btn';
    browse.textContent = 'CHOOSE IMAGE';
    browse.onclick = () => file.click();
    const name = document.createElement('span');
    name.textContent = 'No image selected';
    name.setAttribute('role', 'status');
    wrapper.appendChild(browse);
    wrapper.appendChild(name);
  }
  picker = file.parentElement;
  picker.querySelector('button').onclick = () => file.click();
  file.onchange = () => {
    const selected = file.files[0];
    if (!selected) return;
    picker.querySelector('[role="status"]').textContent = selected.name;
    const image = new Image();
    image.onload = () => {
      const dimensions = [8, 16, 32, 64];
      if (image.naturalWidth === image.naturalHeight && dimensions.indexOf(image.naturalWidth) !== -1) {
        size.value = String(image.naturalWidth);
        resize(image.naturalWidth, image.naturalHeight);
      }
      remember();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      remember();
      recordHistory();
      URL.revokeObjectURL(image.src);
      file.value = '';
    };
    image.onerror = () => {
      URL.revokeObjectURL(image.src);
      unAlert('Could not import that image.');
    };
    image.src = URL.createObjectURL(selected);
  };

  if (imageData) {
    const image = new Image();
    image.onload = () => {
      const dimensions = [8, 16, 32, 64];
      const nativeSize = image.naturalWidth === image.naturalHeight && dimensions.indexOf(image.naturalWidth) !== -1 ? image.naturalWidth : 16;
      size.value = String(nativeSize);
      resize(nativeSize, nativeSize);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      remember();
      recordHistory();
    };
    image.src = `data:image/png;base64,${imageData}`;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    remember();
    recordHistory();
  }
}

function getProfilePictureBase64() {
  const canvas = document.getElementById('edit-picture-canvas');
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels.some((value, index) => index % 4 === 3 && value !== 0)) return '';
  return canvas.toDataURL('image/png').split(',')[1];
}

function showProfilePicture(imageData, fallback) {
  const element = document.getElementById('info-avatar');
  while (element.firstChild) element.removeChild(element.firstChild);
  if (!profilePictureDataUrl(imageData)) {
    element.textContent = fallback || '';
    return;
  }
  const image = document.createElement('img');
  image.src = profilePictureDataUrl(imageData);
  image.alt = 'Profile picture';
  image.width = image.height = 64;
  image.style.width = image.style.height = image.width + 'px';
  image.style.imageRendering = 'pixelated';
  element.appendChild(image);
}

function applySavedPreferences() {
  if (
    localStorage.getItem('unreader-token') &&
    !localStorage.getItem('token')
  ) {
    localStorage.setItem('token', localStorage.getItem('unreader-token'));
  }
  if (
    localStorage.getItem('unreader-username') &&
    !localStorage.getItem('username')
  ) {
    localStorage.setItem('username', localStorage.getItem('unreader-username'));
  }
  if (
    localStorage.getItem('token') &&
    !localStorage.getItem('unreader-token')
  ) {
    localStorage.setItem('unreader-token', localStorage.getItem('token'));
  }
  if (
    localStorage.getItem('username') &&
    !localStorage.getItem('unreader-username')
  ) {
    localStorage.setItem('unreader-username', localStorage.getItem('username'));
  }

  const savedDarkMode = localStorage.getItem('unreader-darkmode');
  if (
    savedDarkMode === 'enabled' ||
    (savedDarkMode === null && localStorage.getItem('dark-mode') === 'true')
  ) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  const savedContrast = localStorage.getItem('unreader-contrast') || 'normal';
  if (savedContrast !== 'normal') {
    document.body.classList.add(`contrast-${savedContrast}`);
  }
  const savedFont = localStorage.getItem('unreader-font') || 'sans';
  if (savedFont === 'mono') {
    document.documentElement.style.setProperty('--body-font', 'monospace');
    document.body.style.fontFamily = 'monospace';
  }
}

function installSharedThemeStyles() {
  applySavedPreferences();
  if (!document.getElementById('shared-theme-styles')) {
    const themeStyles = document.createElement('link');
    themeStyles.id = 'shared-theme-styles';
    themeStyles.rel = 'stylesheet';
    themeStyles.href = 'theme.css';
    document.head.appendChild(themeStyles);
  }
}

document.addEventListener('DOMContentLoaded', installSharedThemeStyles);

function parseMarkdownForKindle(text) {
  if (!text) return '';
  // replace bold text: '**text**' -> '<strong>text</strong>'
  text = text.replace(
    /([\*_])([\*_](.*?)[\*_])([\*_])/g,
    '<strong>$2</strong>',
  );
  // replace italic text: '*text*' -> '<i>text</i>'
  text = text.replace(/([\*_])(.*?)([\*_])/g, '<i>$2</i>');
  // replace links: '[text](url)' -> '<a href="url">text</a>'
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
  // replace images: '![alt text](url)' -> '<img src="url" alt="alt text">'
  text = text.replace(/\!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1">');
  // replace headers: # H1 -> <h1>H1</h1>
  text = text.replace(/\#{1} (.*?)/g, '<h1>$1</h1>');
  text = text.replace(/\#{2} (.*?)/g, '<h2>$1</h2>');
  text = text.replace(/\#{3} (.*?)/g, '<h3>$1</h3>');
  text = text.replace(/\#{4} (.*?)/g, '<h4>$1</h4>');
  text = text.replace(/\#{5} (.*?)/g, '<h5>$1</h5>');
  text = text.replace(/\#{6} (.*?)/g, '<h6>$1</h6>');
  // replace unordered lists: '- item' -> '<li>item</li>'
  text = text.replace(/^(-|\*) (.*?)/g, '<li>$2</li>');
  // replace ordered lists: '1. item' -> '<li>item</li>'
  text = text.replace(/^\d\. (.*?)/g, '<li>$1</li>');
  // replace code blocks: '```code```' -> '<pre><code>code</code></pre>'
  text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // replace inline code: '`code`' -> '<code>code</code>'
  text = text.replace(/`(.*?)`/g, '<code>$1</code>');
  // replace blockquotes: '> quote' -> '<blockquote>quote</blockquote>'
  text = text.replace(/\>(.*?)/g, '<blockquote>$1</blockquote>');
  // replace horizontal rules: '---' -> '<hr>'
  text = text.replace(/\-\-\- /g, '<hr>');
  // replace strikethrough: '~text~' -> '<del>text</del>'
  text = text.replace(/~(.*?)~/g, '<del>$1</del>');
  return text;
}

function parseMarkup(text) {
  if (!text) return '';
  const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (navigator.userAgent.toLowerCase().includes('kindle')) return escaped;
  if (typeof marked === 'undefined' || typeof marked.parse !== 'function') {
    return typeof DOMPurify === 'undefined' ?
      escaped.trim() :
      DOMPurify.sanitize(escaped).trim();
  }
  return DOMPurify.sanitize(marked.parse(escaped)).trim();
}

function censor(text) {
  const curses = [
    'fuck',
    'shit',
    'bitch',
    'pussy',
    'dildo',
    'dick',
    'penis',
    'vagina',
    'tit',
    'tits',
    'cock',
    'cunt',
    'sex',
    'porn',
    'boob',
    'pedo',
    'pedophile',
    'rape',
    'molest',
    'orgy',
    'nigger',
    'hitler',
    'nazis',
  ];
  for (let i = 0; i < curses.length; i++) {
    text = text.replace(
      new RegExp(curses[i], 'gi'),
      '█'.repeat(curses[i].length),
    );
  }
  return text;
}

function formatTimeToken(unixTimestamp) {
  if (!unixTimestamp) return 'MOMENTS AGO';
  var parsedNum = Number(unixTimestamp);
  if (isNaN(parsedNum)) return 'MOMENTS AGO';
  var d = new Date(parsedNum);
  return (
    d.toLocaleDateString() +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

// Modal implementations
function createModalContainer() {
  const container = document.createElement('div');
  container.className = 'modal-overlay';
  document.body.appendChild(container);
  return container;
}

function unAlert(message) {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    container.querySelector('#modal-ok').onclick = function () {
      document.body.removeChild(container);
      resolve();
    };
  });
}

function unConfirm(message) {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-cancel">CANCEL</button>
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    container.querySelector('#modal-ok').onclick = function () {
      document.body.removeChild(container);
      resolve(true);
    };
    container.querySelector('#modal-cancel').onclick = function () {
      document.body.removeChild(container);
      resolve(false);
    };
  });
}

function unPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <input type="text" class="modal-input" id="modal-input" value="${defaultValue}">
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-cancel">CANCEL</button>
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    const input = container.querySelector('#modal-input');
    input.focus();
    input.onkeydown = function (e) {
      if (e.key === 'Enter') container.querySelector('#modal-ok').click();
    };
    container.querySelector('#modal-ok').onclick = function () {
      const value = input.value;
      document.body.removeChild(container);
      resolve(value);
    };
    container.querySelector('#modal-cancel').onclick = function () {
      document.body.removeChild(container);
      resolve(null);
    };
  });
}

// Global replacement of alert, confirm, prompt if needed
// But it's better to explicitly use unAlert, unConfirm, unPrompt
// and update calls to use await.
