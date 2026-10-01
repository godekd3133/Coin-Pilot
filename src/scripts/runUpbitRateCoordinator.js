import { pathToFileURL } from 'node:url';
import { startUpbitRateCoordinatorServer } from '../api/upbitRateCoordinator.js';

export async function startConfiguredUpbitRateCoordinator({
  env = process.env,
  logger = console,
  processApi = process
} = {}) {
  const coordinatorRequired = ['true', '1', 'yes', 'on']
    .includes(String(env.UPBIT_RATE_COORDINATOR_REQUIRED ?? '').trim().toLowerCase());
  const configuredStateDir = typeof env.UPBIT_RATE_COORDINATOR_STATE_DIR === 'string'
    ? env.UPBIT_RATE_COORDINATOR_STATE_DIR.trim()
    : '';
  if (coordinatorRequired && !configuredStateDir) {
    const error = new Error(
      'UPBIT_RATE_COORDINATOR_STATE_DIR is required when host-wide Upbit coordination is enabled.'
    );
    error.code = 'UPBIT_RATE_COORDINATOR_STATE_ROOT_REQUIRED';
    throw error;
  }
  const server = await startUpbitRateCoordinatorServer({
    stateDir: configuredStateDir || env.COINPILOT_STATE_DIR
  });
  logger.info?.(`Upbit public rate coordinator listening at ${server.socketPath}`);

  let shutdownPromise = null;
  const shutdown = signal => {
    if (shutdownPromise) return shutdownPromise;
    logger.info?.(`Stopping Upbit public rate coordinator (${signal}).`);
    shutdownPromise = server.close().catch(error => {
      logger.error?.(`Upbit rate coordinator shutdown failed: ${error.message}`);
      processApi.exitCode = 1;
    });
    return shutdownPromise;
  };
  const onSigint = () => { void shutdown('SIGINT'); };
  const onSigterm = () => { void shutdown('SIGTERM'); };
  processApi.once('SIGINT', onSigint);
  processApi.once('SIGTERM', onSigterm);

  return {
    server,
    shutdown,
    removeSignalHandlers() {
      processApi.removeListener('SIGINT', onSigint);
      processApi.removeListener('SIGTERM', onSigterm);
    }
  };
}

async function main() {
  await startConfiguredUpbitRateCoordinator();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Upbit rate coordinator failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
