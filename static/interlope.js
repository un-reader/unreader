(function () {
  var unlocked = false;
  var address = 's.interlope.pull:27015';

  Object.defineProperty(window, 'INTERLOPE', {
    configurable: true,
    get: function () {
      unlocked = true;
      throw new Error('Unknown command: INTERLOPE');
    }
  });

  window.get = function (target) {
    if (!unlocked) throw new Error('Unknown command: get');
    if (target !== address) throw new Error('Unknown command: ' + String(target));

    if (/\/portal-2d\.html$/.test(window.location.pathname)) {
      window.dispatchEvent(new CustomEvent('interlope:pull'));
    } else {
      window.location.href = 'portal-2d.html?interlope=1';
    }
  };
})();
