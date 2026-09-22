import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the optional dashboard TLS pair without silently downgrading a
 * partially configured HTTPS deployment to HTTP. The returned key/certificate
 * bytes are consumed only by the local HTTPS listener; callers should never
 * expose them through an API response or log.
 */
export function resolveDashboardTls(env = {}, projectRoot = process.cwd()) {
  const certificateInput = String(env.DASHBOARD_TLS_CERT_FILE || '').trim();
  const keyInput = String(env.DASHBOARD_TLS_KEY_FILE || '').trim();
  const configured = Boolean(certificateInput || keyInput);

  if (!configured) {
    return {
      enabled: false,
      configured: false,
      certFile: null,
      keyFile: null,
      cert: null,
      key: null,
      error: null
    };
  }

  if (!certificateInput || !keyInput) {
    return {
      enabled: false,
      configured: true,
      certFile: certificateInput || null,
      keyFile: keyInput || null,
      cert: null,
      key: null,
      error: 'DASHBOARD_TLS_CERT_FILE과 DASHBOARD_TLS_KEY_FILE을 함께 설정해야 합니다.'
    };
  }

  const certFile = path.isAbsolute(certificateInput)
    ? certificateInput
    : path.resolve(projectRoot, certificateInput);
  const keyFile = path.isAbsolute(keyInput)
    ? keyInput
    : path.resolve(projectRoot, keyInput);

  try {
    return {
      enabled: true,
      configured: true,
      certFile,
      keyFile,
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
      error: null
    };
  } catch (error) {
    return {
      enabled: false,
      configured: true,
      certFile,
      keyFile,
      cert: null,
      key: null,
      error: `dashboard TLS 인증서/키를 읽을 수 없습니다: ${error.message}`
    };
  }
}
