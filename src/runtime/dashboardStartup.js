/** Run trading runtime initialization only after the configured dashboard binds. */
export async function runAfterDashboardReady(dashboardServer, startRuntime) {
  if (dashboardServer) await dashboardServer.start();
  return startRuntime();
}
