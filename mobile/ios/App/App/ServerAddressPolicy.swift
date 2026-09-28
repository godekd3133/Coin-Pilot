import Darwin
import Foundation

enum ServerAddressPolicy {
    static func allows(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              let rawHost = url.host?.lowercased(),
              url.user == nil,
              url.password == nil,
              url.path.isEmpty || url.path == "/",
              url.query == nil,
              url.fragment == nil else {
            return false
        }

        let host = normalizedHost(rawHost)
        guard !isLoopbackHostname(host) else { return false }
        if scheme == "https" { return true }
        guard scheme == "http" else { return false }

        return host.hasSuffix(".local") || isPrivateIPv4(host) || isUniqueLocalIPv6(host)
    }

    private static func normalizedHost(_ host: String) -> String {
        guard !host.contains(":"), host.hasSuffix(".") else { return host }
        return String(host.dropLast())
    }

    private static func parseIPv4(_ host: String) -> [UInt8]? {
        let candidate = host.hasSuffix(".") ? String(host.dropLast()) : host
        let components = candidate.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 4 else { return nil }

        let octets = components.compactMap { UInt8($0) }
        return octets.count == 4 ? octets : nil
    }

    private static func isPrivateIPv4(_ host: String) -> Bool {
        guard let octets = parseIPv4(host) else { return false }
        return octets[0] == 10 ||
            (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 169 && octets[1] == 254)
    }

    private static func isLoopbackHostname(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        if parseIPv4(host)?.first == 127 { return true }

        guard let bytes = parseIPv6(host) else { return false }
        let ipv6Loopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
        let mappedIPv4Loopback = bytes[0..<10].allSatisfy { $0 == 0 } &&
            bytes[10] == 255 && bytes[11] == 255 && bytes[12] == 127
        return ipv6Loopback || mappedIPv4Loopback
    }

    private static func isUniqueLocalIPv6(_ host: String) -> Bool {
        guard let bytes = parseIPv6(host) else { return false }
        // RFC 4193 unique-local addresses occupy fc00::/7. Link-local addresses
        // are deliberately excluded because they need an interface scope ID.
        return bytes[0] & 0xfe == 0xfc
    }

    private static func parseIPv6(_ host: String) -> [UInt8]? {
        let address = host.hasPrefix("[") && host.hasSuffix("]")
            ? String(host.dropFirst().dropLast())
            : host
        guard address.contains(":"), !address.contains("%") else { return nil }

        var parsed = in6_addr()
        guard address.withCString({ inet_pton(AF_INET6, $0, &parsed) }) == 1 else { return nil }
        return withUnsafeBytes(of: parsed) { Array($0.prefix(16)) }
    }
}
