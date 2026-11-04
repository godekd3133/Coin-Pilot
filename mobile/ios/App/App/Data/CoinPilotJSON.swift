import Foundation

/// Lenient decoding helpers for feature models. Server payloads grow over time
/// and some fields are `null` while an engine warms up, so every field decodes
/// as optional and a type mismatch becomes `nil` instead of failing the whole
/// response.
extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// Numbers sometimes arrive as strings from older servers.
    func lenientDouble(_ key: Key) -> Double? {
        if let value: Double = lenient(key) { return value.isFinite ? value : nil }
        if let text: String = lenient(key) { return Double(text) }
        return nil
    }

    func lenientInt(_ key: Key) -> Int? {
        if let value: Int = lenient(key) { return value }
        if let value = lenientDouble(key), value.isFinite { return Int(value) }
        return nil
    }

    func lenientArray<T: Decodable>(_ key: Key) -> [T] {
        guard var nested = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var result: [T] = []
        while !nested.isAtEnd {
            if let value = try? nested.decode(T.self) {
                result.append(value)
            } else {
                _ = try? nested.decode(CoinPilotJSONSkip.self)
            }
        }
        return result
    }

    func lenientDictionary<T: Decodable>(_ key: Key) -> [String: T] {
        guard let nested = try? nestedContainer(keyedBy: CoinPilotDynamicKey.self, forKey: key) else { return [:] }
        var result: [String: T] = [:]
        for dynamicKey in nested.allKeys {
            if let value = try? nested.decode(T.self, forKey: dynamicKey) {
                result[dynamicKey.stringValue] = value
            }
        }
        return result
    }
}

struct CoinPilotDynamicKey: CodingKey {
    let stringValue: String
    let intValue: Int?
    init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

/// Consumes one array element of any shape so a bad element can be skipped.
struct CoinPilotJSONSkip: Decodable {
    init(from decoder: Decoder) throws {}
}

enum CoinPilotFeatureDecoding {
    /// Re-encodes a JSONSerialization object and decodes it leniently.
    static func decode<T: Decodable>(_ type: T.Type, from object: Any) -> T? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
