import express from 'express';

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4 && octets[0] === '127' &&
    octets.slice(1).every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isTrustedSecureRequest(req) {
  if (req.socket?.encrypted === true) return true;
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  return forwardedProto === 'https' && isLoopbackAddress(req.socket?.remoteAddress);
}

function hasExactlyCredentialFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === 'accessKey' && keys[1] === 'secretKey' &&
    typeof body.accessKey === 'string' && typeof body.secretKey === 'string' &&
    body.accessKey.length > 0 && body.secretKey.length > 0 &&
    body.accessKey.length <= 512 && body.secretKey.length <= 512 &&
    body.accessKey.trim() === body.accessKey && body.secretKey.trim() === body.secretKey;
}

function respond(res, status, code, error) {
  return res.status(status).json({ success: false, code, error });
}

/**
 * Native-only enrollment of the credentials used by this server's LIVE
 * account. The mobile token may submit keys, but no endpoint returns them.
 */
export default function createLiveCredentialsRoutes(server) {
  const router = express.Router();

  router.post('/live/credentials', async (req, res) => {
    if (req.dashboardAuthRole !== 'mobile_operator') {
      return respond(res, 403, 'mobile_operator_required', '모바일 앱에서만 거래소 키를 등록할 수 있습니다.');
    }
    if (server.tradingSystem?.dryRun !== false) {
      return respond(res, 409, 'live_server_required', '실거래 서버에서만 거래소 키를 등록할 수 있습니다.');
    }
    if (server.tradingSystem?.isRunning === true) {
      return respond(res, 409, 'live_server_running', '서버가 멈춘 상태에서만 처음 키를 등록할 수 있습니다.');
    }
    if (server.liveCredentialSetupMode !== true && server.tradingSystem?.liveCredentialSetupMode !== true) {
      return respond(res, 409, 'credential_setup_unavailable', '키 등록 설정 모드가 아닙니다.');
    }
    if (!isTrustedSecureRequest(req)) {
      return respond(res, 426, 'https_required', '보안을 위해 HTTPS 연결에서만 키를 등록할 수 있습니다.');
    }
    if (!hasExactlyCredentialFields(req.body)) {
      return respond(res, 400, 'invalid_credential_request', 'Access Key와 Secret Key만 입력해 주세요.');
    }

    const store = server.liveCredentialStore;
    if (server.liveCredentialEnrollmentReady !== true || !store ||
        typeof store.save !== 'function' || typeof store.notifyUpdate !== 'function') {
      return respond(res, 503, 'credential_setup_unavailable', '서버에서 키 등록 기능을 사용할 수 없습니다.');
    }
    try {
      if (store.status() === true) {
        return respond(res, 409, 'credentials_already_configured', '이미 키가 등록되어 있습니다.');
      }
    } catch {
      return respond(res, 503, 'credential_storage_unavailable', '서버의 키 등록 상태를 확인할 수 없습니다.');
    }

    const credentials = { accessKey: req.body.accessKey, secretKey: req.body.secretKey };
    try {
      await store.save(credentials);
    } catch (error) {
      if (error?.code === 'LIVE_CREDENTIALS_ALREADY_CONFIGURED') {
        return respond(res, 409, 'credentials_already_configured', '이미 키가 등록되어 있습니다.');
      }
      if (error?.code === 'LIVE_CREDENTIALS_REJECTED') {
        return respond(res, 422, 'credential_validation_failed', 'Upbit 키를 확인하지 못했습니다. 권한과 입력 내용을 확인해 주세요.');
      }
      if (error?.code === 'LIVE_CREDENTIALS_VALIDATION_UNAVAILABLE') {
        return respond(res, 503, 'credential_validation_unavailable', 'Upbit 키 확인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      if (error?.code === 'LIVE_CREDENTIALS_INVALID_INPUT') {
        return respond(res, 400, 'invalid_credential_request', 'Access Key와 Secret Key만 입력해 주세요.');
      }
      return respond(res, 503, 'credential_storage_unavailable', '서버에서 키를 안전하게 저장하지 못했습니다.');
    }

    try {
      await store.notifyUpdate(credentials);
    } catch {
      return respond(res, 503, 'credential_apply_failed', '키는 저장됐지만 실거래 연결을 준비하지 못했습니다. 서버 상태를 확인해 주세요.');
    }

    return res.json({ success: true, upbitCredentialsConfigured: true });
  });

  return router;
}
