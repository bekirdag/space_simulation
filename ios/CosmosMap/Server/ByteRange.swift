import Foundation

/// A single satisfiable byte range (inclusive bounds), as used by `Range: bytes=...`.
struct ByteRange: Equatable {
    let start: Int
    let end: Int

    var length: Int { end - start + 1 }

    func contentRangeHeader(totalSize: Int) -> String {
        "bytes \(start)-\(end)/\(totalSize)"
    }
}

enum RangeRequest: Equatable {
    /// No usable Range header (absent, malformed, multi-range or not bytes): serve the full body.
    case none
    /// A single satisfiable range: serve 206.
    case partial(ByteRange)
    /// Syntactically valid but unsatisfiable for this size: serve 416.
    case unsatisfiable

    /// Parses an RFC 9110 `Range` header value against a representation of `size` bytes.
    ///
    /// Only a single byte range is honoured; multiple ranges fall back to a full response,
    /// which the RFC permits and which WebKit handles fine.
    static func parse(_ header: String?, size: Int) -> RangeRequest {
        guard let header else { return .none }
        let trimmed = header.trimmingCharacters(in: .whitespaces)
        guard trimmed.lowercased().hasPrefix("bytes=") else { return .none }
        let spec = trimmed.dropFirst("bytes=".count).trimmingCharacters(in: .whitespaces)
        guard !spec.isEmpty, !spec.contains(",") else { return .none }
        guard let dash = spec.firstIndex(of: "-") else { return .none }

        let first = spec[..<dash].trimmingCharacters(in: .whitespaces)
        let last = spec[spec.index(after: dash)...].trimmingCharacters(in: .whitespaces)

        if first.isEmpty {
            // Suffix range: last N bytes.
            guard let suffix = parseNumber(last) else { return .none }
            guard suffix > 0, size > 0 else { return .unsatisfiable }
            let length = min(suffix, size)
            return .partial(ByteRange(start: size - length, end: size - 1))
        }

        guard let start = parseNumber(first) else { return .none }
        var end: Int
        if last.isEmpty {
            end = size - 1
        } else {
            guard let parsedEnd = parseNumber(last) else { return .none }
            guard parsedEnd >= start else { return .none }
            end = parsedEnd
        }
        guard start < size else { return .unsatisfiable }
        end = min(end, size - 1)
        return .partial(ByteRange(start: start, end: end))
    }

    private static func parseNumber(_ text: String) -> Int? {
        guard !text.isEmpty, text.count <= 18, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(text)
    }
}
