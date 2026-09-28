(function connectMobileWebShell(global) {
  // The native iOS container resolves its default in SceneDelegate so its
  // Server settings page remains available on demand. Standalone browser use
  // of this shell should open the same default dashboard automatically.
  if (global.webkit?.messageHandlers?.coinpilotConnect) return;

  const policy = global.CoinPilotServerUrlPolicy;
  if (!policy?.DEFAULT_DASHBOARD_URL) return;

  const storageKey = 'coinpilot.ios.dashboardUrl';
  let target = policy.DEFAULT_DASHBOARD_URL;
  try {
    target = localStorage.getItem(storageKey) || target;
    localStorage.setItem(storageKey, target);
  } catch {
    // File and private browsing contexts can reject localStorage; navigation
    // can still use the built-in server address.
  }

  try {
    target = policy.normalizeDashboardUrl(target);
  } catch {
    target = policy.DEFAULT_DASHBOARD_URL;
  }

  global.location.replace(target);
})(window);
