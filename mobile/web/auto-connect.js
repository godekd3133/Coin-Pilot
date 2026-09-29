(function preserveExplicitServerChoice(global) {
  // A standalone browser stays on this setup page until the user submits a
  // server address. Native navigation is handled by SceneDelegate.
  if (global.webkit?.messageHandlers?.coinpilotConnect) return;
})(window);
