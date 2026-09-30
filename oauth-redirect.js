msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
  document.querySelector('#oauth-status').textContent = 'Sign-in could not return to Gather. Close this window and reconnect from the app.';
});
