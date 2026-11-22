(function () {
  var params = new URLSearchParams(location.search);
  var connected = params.get('connected') === '1';
  var error = params.get('error') || '';

  var title = document.querySelector('#callback-title');
  var message = document.querySelector('#callback-message');

  if (error) {
    title.textContent = 'Google Drive could not be connected';
    message.textContent = error;
  } else if (connected) {
    title.textContent = 'Google Drive connected';
    message.textContent = 'You can close this window and return to Gurukul Olympics.';
  } else {
    title.textContent = 'Unexpected response';
    message.textContent = 'Return to Gurukul Olympics and try connecting again.';
  }

  try {
    if (window.opener) {
      window.opener.postMessage(
        { type: 'mosaic-drive-oauth', connected: connected, error: error },
        location.origin
      );
    }
  } catch (ignored) {
    // Cross-window messaging can be disabled; the status page still explains the result.
  }

  if (!error && connected) setTimeout(function () { window.close(); }, 900);
})();
