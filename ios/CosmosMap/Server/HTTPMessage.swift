import Foundation

/// A parsed HTTP/1.x request head. Bodies are only read for the one proxied POST
/// endpoint (`APIProxy.diagnosticsPath`); every other request with a body is refused.
struct HTTPRequest: Equatable {
    let method: String
    /// Raw request-target as sent (origin-form, still percent-encoded, with query).
    let target: String
    let version: String
    /// Header names are lower-cased; repeated headers are joined with ", ".
    let headers: [String: String]
    /// Request body (filled in by the connection for accepted POSTs only).
    var body = Data()

    var path: String {
        if let q = target.firstIndex(where: { $0 == "?" || $0 == "#" }) { return String(target[..<q]) }
        return target
    }

    var query: String? {
        guard let q = target.firstIndex(of: "?") else { return nil }
        let afterQ = target[target.index(after: q)...]
        if let hash = afterQ.firstIndex(of: "#") { return String(afterQ[..<hash]) }
        return String(afterQ)
    }

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    var wantsKeepAlive: Bool {
        let tokens = (header("connection") ?? "").lowercased()
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        if tokens.contains("close") { return false }
        if version == "HTTP/1.1" { return true }
        return tokens.contains("keep-alive")
    }

    /// The declared Content-Length, or nil when absent or malformed.
    var contentLength: Int? {
        guard let cl = header("content-length") else { return nil }
        return Int(cl.trimmingCharacters(in: .whitespaces))
    }

    var hasTransferEncoding: Bool {
        !(header("transfer-encoding") ?? "").isEmpty
    }

    var declaresBody: Bool {
        if let te = header("transfer-encoding"), !te.isEmpty { return true }
        if let cl = header("content-length"), let n = Int(cl.trimmingCharacters(in: .whitespaces)), n > 0 { return true }
        if let cl = header("content-length"), Int(cl.trimmingCharacters(in: .whitespaces)) == nil { return true }
        return false
    }
}

enum HTTPParseResult: Equatable {
    /// More bytes are needed before a complete head is available.
    case incomplete
    /// A complete head; `consumed` bytes (head + CRLFCRLF) should be dropped from the buffer.
    case request(HTTPRequest, consumed: Int)
    /// The head is malformed or too large; respond with `status` and close.
    case error(status: Int)
}

enum HTTPParser {
    static let maxHeadSize = 16 * 1024
    private static let terminator = Data("\r\n\r\n".utf8)

    static func parse(_ buffer: Data) -> HTTPParseResult {
        guard let end = buffer.range(of: terminator) else {
            return buffer.count > maxHeadSize ? .error(status: 431) : .incomplete
        }
        let headLength = end.lowerBound - buffer.startIndex
        if headLength > maxHeadSize { return .error(status: 431) }
        let consumed = end.upperBound - buffer.startIndex
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8)
                ?? String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .isoLatin1) else {
            return .error(status: 400)
        }

        var lines = head.components(separatedBy: "\r\n")
        // Tolerate stray CRLFs before the request line (RFC 9112 §2.2).
        while let first = lines.first, first.isEmpty { lines.removeFirst() }
        guard let requestLine = lines.first else { return .error(status: 400) }

        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return .error(status: 400) }
        let method = String(parts[0])
        let target = String(parts[1])
        let version = String(parts[2])
        guard !method.isEmpty, method.allSatisfy({ $0.isASCII && ($0.isLetter || $0 == "-") }) else {
            return .error(status: 400)
        }
        guard version == "HTTP/1.1" || version == "HTTP/1.0" else { return .error(status: 505) }
        guard target.hasPrefix("/") else { return .error(status: 400) }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { return .error(status: 400) }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            guard !name.isEmpty, !name.contains(" ") else { return .error(status: 400) }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let existing = headers[name] {
                headers[name] = existing + ", " + value
            } else {
                headers[name] = value
            }
        }

        return .request(HTTPRequest(method: method, target: target, version: version, headers: headers), consumed: consumed)
    }
}

/// A response head. The body is sent separately (in memory or streamed from a file).
struct HTTPResponseHead {
    var status: Int
    var headers: [(String, String)] = []

    init(status: Int, headers: [(String, String)] = []) {
        self.status = status
        self.headers = headers
    }

    mutating func set(_ name: String, _ value: String) {
        headers.removeAll { $0.0.caseInsensitiveCompare(name) == .orderedSame }
        headers.append((name, value))
    }

    func value(_ name: String) -> String? {
        headers.first { $0.0.caseInsensitiveCompare(name) == .orderedSame }?.1
    }

    func serialized() -> Data {
        var text = "HTTP/1.1 \(status) \(HTTPResponseHead.reason(for: status))\r\n"
        for (name, value) in headers {
            // Never let a header value smuggle a CRLF into the head.
            let clean = value.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
            text += "\(name): \(clean)\r\n"
        }
        text += "\r\n"
        return Data(text.utf8)
    }

    static func reason(for status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 206: return "Partial Content"
        case 301: return "Moved Permanently"
        case 302: return "Found"
        case 304: return "Not Modified"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 408: return "Request Timeout"
        case 411: return "Length Required"
        case 413: return "Content Too Large"
        case 415: return "Unsupported Media Type"
        case 416: return "Range Not Satisfiable"
        case 429: return "Too Many Requests"
        case 431: return "Request Header Fields Too Large"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        case 504: return "Gateway Timeout"
        case 505: return "HTTP Version Not Supported"
        default: return HTTPURLResponse.localizedString(forStatusCode: status).capitalized
        }
    }

    /// Statuses that must never carry a body.
    static func forbidsBody(_ status: Int) -> Bool {
        (100..<200).contains(status) || status == 204 || status == 304
    }
}
