import Foundation

/// Forwards same-origin `/api/*` requests from the web view to the public backend, so the
/// web code keeps using relative `/api/...` URLs unchanged. Any network failure turns into
/// `503 {"error":"offline"}`, which the web app already treats as "backend unavailable".
final class APIProxy {
    struct Response {
        var status: Int
        var headers: [(String, String)]
        var body: Data
    }

    static let allowedMethods: Set<String> = ["GET", "HEAD", "OPTIONS"]

    /// Request headers worth forwarding upstream (everything else is dropped).
    private static let forwardedRequestHeaders = [
        "accept", "accept-language", "if-none-match", "if-modified-since", "range",
    ]
    /// Upstream response headers passed back to the web view.
    private static let passedResponseHeaders = [
        "Content-Type", "Cache-Control", "Retry-After", "ETag", "Last-Modified",
        "Content-Range", "Accept-Ranges", "Content-Disposition", "Allow",
    ]

    let upstream: URL
    private let session: URLSession

    init(upstream: URL, requestTimeout: TimeInterval = 15, resourceTimeout: TimeInterval = 120) {
        self.upstream = upstream
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = resourceTimeout
        config.waitsForConnectivity = false
        // WebKit does its own HTTP caching; don't keep a second copy here.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpAdditionalHeaders = ["User-Agent": APIProxy.userAgent]
        self.session = URLSession(configuration: config)
    }

    static var userAgent: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "CosmosMap-iPad/\(version) (\(build))"
    }

    static func handles(path: String) -> Bool {
        path == "/api" || path.hasPrefix("/api/")
    }

    /// Builds the upstream URL. The origin is fixed, so a request can never be pointed at
    /// another host; only path and query from the (already origin-form) target are reused.
    func upstreamURL(for request: HTTPRequest) -> URL? {
        guard Self.handles(path: request.path) else { return nil }
        // Reuse the target byte-for-byte (keeps the web app's percent-encoding), but only
        // after the origin: URL(string:) rejects anything malformed instead of trapping the
        // way URLComponents' percentEncoded* setters do.
        var target = request.path
        if let query = request.query, !query.isEmpty { target += "?" + query }
        guard target.allSatisfy({ $0.isASCII && !$0.isWhitespace && $0 != "\\" }) else { return nil }
        var base = upstream.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + target),
              url.scheme == upstream.scheme, url.host == upstream.host, url.port == upstream.port else { return nil }
        return url
    }

    func warmUp() {
        guard let url = URL(string: "/api/health", relativeTo: upstream) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        session.dataTask(with: request) { _, _, _ in }.resume()
    }

    func forward(_ request: HTTPRequest, completion: @escaping (Response) -> Void) {
        guard Self.allowedMethods.contains(request.method) else {
            completion(Response(status: 405, headers: [("Allow", "GET, HEAD, OPTIONS"), ("Content-Type", "application/json; charset=utf-8")],
                                body: Data(#"{"error":"method_not_allowed"}"#.utf8)))
            return
        }
        guard let url = upstreamURL(for: request) else {
            completion(Response(status: 400, headers: [("Content-Type", "application/json; charset=utf-8")],
                                body: Data(#"{"error":"bad_request"}"#.utf8)))
            return
        }

        var upstreamRequest = URLRequest(url: url)
        upstreamRequest.httpMethod = request.method
        for name in Self.forwardedRequestHeaders {
            if let value = request.header(name) { upstreamRequest.setValue(value, forHTTPHeaderField: name) }
        }

        session.dataTask(with: upstreamRequest) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion(Self.offline())
                return
            }
            var headers: [(String, String)] = []
            for name in Self.passedResponseHeaders {
                if let value = http.value(forHTTPHeaderField: name) { headers.append((name, value)) }
            }
            // URLSession has already decoded any Content-Encoding, so for GET the length is
            // recomputed by the connection from `body`. HEAD has no body to measure.
            if request.method == "HEAD", let length = http.value(forHTTPHeaderField: "Content-Length") {
                headers.append(("Content-Length", length))
            }
            completion(Response(status: http.statusCode, headers: headers, body: data ?? Data()))
        }.resume()
    }

    static func offline() -> Response {
        Response(status: 503,
                 headers: [("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", "no-store")],
                 body: Data(#"{"error":"offline"}"#.utf8))
    }
}
