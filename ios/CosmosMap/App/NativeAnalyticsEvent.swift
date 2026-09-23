import Foundation

/// An analytics event posted by the web app through the `cosmosmapAnalytics` script message
/// handler (`window.CosmosMapNative.logEvent(name, params)`), validated before it reaches
/// Firebase Analytics. The web page is our own bundled build, but the bridge still treats
/// the message body as untrusted input.
struct NativeAnalyticsEvent: Equatable {
    static let maxParameters = 25
    static let maxNameLength = 40
    static let maxStringValueLength = 100
    /// Prefixes Firebase reserves for its own events and parameters.
    static let reservedPrefixes = ["firebase_", "google_", "ga_"]

    let name: String
    /// Values are `String`, `Int` or `Double` only.
    let parameters: [String: NSObject]

    /// Returns nil when the message is malformed, the event name is invalid or there are more
    /// than `maxParameters` parameters. Individual parameters with an invalid key or an
    /// unsupported value (objects, arrays, null, NaN/Infinity) are dropped; strings longer
    /// than `maxStringValueLength` are truncated; booleans become 0/1.
    init?(messageBody body: Any) {
        guard let dictionary = body as? [String: Any],
              let name = dictionary["name"] as? String,
              Self.isValidName(name)
        else { return nil }

        var parameters: [String: NSObject] = [:]
        if let rawParameters = dictionary["params"], !(rawParameters is NSNull) {
            guard let rawParameters = rawParameters as? [String: Any],
                  rawParameters.count <= Self.maxParameters
            else { return nil }
            for (key, value) in rawParameters where Self.isValidName(key) {
                if let value = Self.sanitize(value) { parameters[key] = value }
            }
        }
        self.name = name
        self.parameters = parameters
    }

    /// `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, and not using a Firebase-reserved prefix.
    static func isValidName(_ name: String) -> Bool {
        guard (1...maxNameLength).contains(name.utf8.count) else { return false }
        for (index, byte) in name.utf8.enumerated() {
            let isLetter = (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
            let isDigit = byte >= 0x30 && byte <= 0x39
            if index == 0 ? !isLetter : !(isLetter || isDigit || byte == 0x5F) { return false }
        }
        let lowercased = name.lowercased()
        return !reservedPrefixes.contains { lowercased.hasPrefix($0) }
    }

    private static func sanitize(_ value: Any) -> NSObject? {
        if let string = value as? String {
            return String(string.prefix(maxStringValueLength)) as NSString
        }
        guard let number = value as? NSNumber else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return NSNumber(value: number.boolValue ? 1 : 0)
        }
        let double = number.doubleValue
        guard double.isFinite else { return nil }
        if double == double.rounded(), abs(double) < 9_007_199_254_740_992 {
            return NSNumber(value: Int64(double))
        }
        return NSNumber(value: double)
    }
}
