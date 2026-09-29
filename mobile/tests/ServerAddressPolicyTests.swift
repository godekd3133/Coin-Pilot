import Foundation

@main
struct ServerAddressPolicyTests {
    static func main() throws {
        let cases: [(String, Bool)] = [
            ("https://coinpilot.example.com", true),
            ("https://coinpilot.example.com/live", true),
            ("https://coinpilot.example.com/live/", false),
            ("https://coinpilot.example.com/dashboard", false),
            ("http://192.168.1.229:3000", true),
            ("http://192.168.1.229:3000/live", true),
            ("http://coinpilot.local:3000", true),
            ("http://[fd12:3456:789a::10]:3000", true),
            ("http://[fc12:3456:789a::10]:3000", true),
            ("http://fc-upbit.example.com:3000", false),
            ("http://fd.example.org:3000", false),
            ("http://[2001:db8::10]:3000", false),
            ("http://127.0.0.2:3000", false),
            ("https://127.0.0.2:3000", false),
            ("http://[::1]:3000", false),
            ("https://localhost:3000", false),
            ("http://user:pass@192.168.1.229:3000", false),
            ("http://192.168.1.229:3000/dashboard", false),
            ("https://coinpilot.example.com/live?token=secret", false),
            ("http://192.168.1.229:3000/?token=secret", false)
        ]

        for (value, expected) in cases {
            guard let url = URL(string: value) else {
                fatalError("Test URL did not parse: \(value)")
            }
            let actual = ServerAddressPolicy.allows(url)
            guard actual == expected else {
                fatalError("Unexpected allowlist result for \(value): expected \(expected), got \(actual)")
            }
        }

        print("Server address policy: \(cases.count) cases passed")
    }
}
