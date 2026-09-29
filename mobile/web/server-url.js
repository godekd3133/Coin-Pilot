(function exposeCoinPilotServerUrlPolicy(global) {
  function parseIPv4(hostname) {
    const normalized = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    const octets = normalized.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
      return null;
    }
    return octets;
  }

  function isPrivateIPv4(hostname) {
    const octets = parseIPv4(hostname);
    if (!octets) return false;
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254);
  }

  function isLoopbackIPv4(hostname) {
    return parseIPv4(hostname)?.[0] === 127;
  }

  function isUniqueLocalIPv6(hostname) {
    // URL.hostname includes brackets for IPv6 literals. URL parsing validates
    // the address; fc00::/7 is the only IPv6 range allowed over local HTTP.
    return /^\[(?:fc|fd)[0-9a-f:]+\]$/i.test(hostname);
  }

  function isLoopbackHostname(hostname) {
    return hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      isLoopbackIPv4(hostname) ||
      hostname === '[::1]';
  }

  function normalizeDashboardUrl(value) {
    const candidate = String(value || '').trim();
    if (!candidate) throw new Error('서버 주소를 입력해 주세요.');

    let url;
    try {
      url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
    } catch {
      throw new Error('서버 주소를 확인해 주세요. 예: https://coinpilot.example.com');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('외부 서버는 HTTPS 주소로 연결해 주세요. 로컬 서버는 같은 Wi-Fi에서 내부 주소를 사용할 수 있습니다.');
    }
    if (url.username || url.password) {
      throw new Error('서버 주소에 로그인 정보는 넣을 수 없습니다.');
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error('서버 주소만 입력해 주세요. 주소 뒤에 페이지 경로나 검색어를 붙이지 마세요.');
    }

    const hostname = url.hostname.toLowerCase();
    const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (isLoopbackHostname(normalizedHostname)) {
      throw new Error('기기 자체 주소는 사용할 수 없습니다. 서버가 실행 중인 컴퓨터의 주소를 입력해 주세요.');
    }

    const localHost = normalizedHostname.endsWith('.local') ||
      isPrivateIPv4(normalizedHostname) ||
      isUniqueLocalIPv6(hostname);

    if (url.protocol === 'http:' && !localHost) {
      throw new Error('외부 서버는 HTTPS 주소로 연결해 주세요. 같은 Wi-Fi의 로컬 서버는 HTTP 주소를 사용할 수 있습니다.');
    }

    return url.origin;
  }

  global.CoinPilotServerUrlPolicy = Object.freeze({
    normalizeDashboardUrl
  });
})(globalThis);
