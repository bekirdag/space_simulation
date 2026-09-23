import Network
import XCTest
@testable import CosmosMap

final class RangeParsingTests: XCTestCase {
    func testAbsentOrMalformedRangeServesFullBody() {
        XCTAssertEqual(RangeRequest.parse(nil, size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("items=0-1", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=abc-", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=5-2", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=0-1,5-6", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=-", size: 100), .none)
        XCTAssertEqual(RangeRequest.parse("bytes=+1-2", size: 100), .none)
    }

    func testClosedOpenAndSuffixRanges() {
        XCTAssertEqual(RangeRequest.parse("bytes=0-9", size: 100), .partial(ByteRange(start: 0, end: 9)))
        XCTAssertEqual(RangeRequest.parse("bytes=90-", size: 100), .partial(ByteRange(start: 90, end: 99)))
        XCTAssertEqual(RangeRequest.parse("bytes=90-500", size: 100), .partial(ByteRange(start: 90, end: 99)))
        XCTAssertEqual(RangeRequest.parse("bytes=-10", size: 100), .partial(ByteRange(start: 90, end: 99)))
        XCTAssertEqual(RangeRequest.parse("bytes=-1000", size: 100), .partial(ByteRange(start: 0, end: 99)))
        XCTAssertEqual(RangeRequest.parse("Bytes=0-0", size: 1), .partial(ByteRange(start: 0, end: 0)))
    }

    func testUnsatisfiableRanges() {
        XCTAssertEqual(RangeRequest.parse("bytes=100-", size: 100), .unsatisfiable)
        XCTAssertEqual(RangeRequest.parse("bytes=-0", size: 100), .unsatisfiable)
        XCTAssertEqual(RangeRequest.parse("bytes=0-", size: 0), .unsatisfiable)
    }

    func testContentRangeHeader() {
        XCTAssertEqual(ByteRange(start: 10, end: 19).contentRangeHeader(totalSize: 50), "bytes 10-19/50")
        XCTAssertEqual(ByteRange(start: 10, end: 19).length, 10)
    }
}

final class MIMETypeTests: XCTestCase {
    func testKnownTypes() {
        XCTAssertEqual(MIMETypes.contentType(forPath: "/index.html"), "text/html; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/assets/index-abc.js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/a/b.CSS"), "text/css; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/data/x.json"), "application/json; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/data/x.geojson"), "application/geo+json; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/data/galaxies-100k.bin"), "application/octet-stream")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/t/earth.jpg"), "image/jpeg")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/t/earth.png"), "image/png")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/t/earth.webp"), "image/webp")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/logo.svg"), "image/svg+xml")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/draco/draco_decoder.wasm"), "application/wasm")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/shaders/a.wgsl"), "text/plain; charset=utf-8")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/m/a.glb"), "model/gltf-binary")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/f/a.woff2"), "font/woff2")
    }

    func testUnknownAndExtensionless() {
        XCTAssertEqual(MIMETypes.contentType(forPath: "/README"), "application/octet-stream")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/.hidden"), "application/octet-stream")
        XCTAssertEqual(MIMETypes.contentType(forPath: "/x.unknownext"), "application/octet-stream")
    }
}

final class HTTPParserTests: XCTestCase {
    func testParsesRequestAndHeaders() {
        let raw = Data("GET /api/object-info?q=M31&x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-1\r\nX-A: 1\r\nx-a: 2\r\n\r\nGET".utf8)
        guard case .request(let request, let consumed) = HTTPParser.parse(raw) else { return XCTFail("expected request") }
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/api/object-info")
        XCTAssertEqual(request.query, "q=M31&x=1")
        XCTAssertEqual(request.header("range"), "bytes=0-1")
        XCTAssertEqual(request.header("X-A"), "1, 2")
        XCTAssertTrue(request.wantsKeepAlive)
        XCTAssertEqual(consumed, raw.count - 3)
    }

    func testIncompleteAndErrors() {
        XCTAssertEqual(HTTPParser.parse(Data("GET / HTTP/1.1\r\nHost: x\r\n".utf8)), .incomplete)
        XCTAssertEqual(HTTPParser.parse(Data("GET http://evil/ HTTP/1.1\r\n\r\n".utf8)), .error(status: 400))
        XCTAssertEqual(HTTPParser.parse(Data("GET / HTTP/2.0\r\n\r\n".utf8)), .error(status: 505))
        XCTAssertEqual(HTTPParser.parse(Data("GARBAGE\r\n\r\n".utf8)), .error(status: 400))
        XCTAssertEqual(HTTPParser.parse(Data(repeating: 65, count: HTTPParser.maxHeadSize + 1)), .error(status: 431))
    }

    func testConnectionSemantics() {
        func parse(_ s: String) -> HTTPRequest? {
            if case .request(let r, _) = HTTPParser.parse(Data(s.utf8)) { return r }
            return nil
        }
        XCTAssertEqual(parse("GET / HTTP/1.1\r\nConnection: close\r\n\r\n")?.wantsKeepAlive, false)
        XCTAssertEqual(parse("GET / HTTP/1.0\r\n\r\n")?.wantsKeepAlive, false)
        XCTAssertEqual(parse("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n")?.wantsKeepAlive, true)
        XCTAssertEqual(parse("POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\n")?.declaresBody, true)
        XCTAssertEqual(parse("GET / HTTP/1.1\r\nContent-Length: 0\r\n\r\n")?.declaresBody, false)
    }

    func testHeaderValuesCannotInjectCRLF() {
        var head = HTTPResponseHead(status: 200)
        head.set("X-Test", "a\r\nSet-Cookie: x=1")
        let text = String(data: head.serialized(), encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("\r\nSet-Cookie"))
    }
}

final class StaticFileResolverTests: XCTestCase {
    private var root: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        root = base.appendingPathComponent("Web", isDirectory: true)
        outside = base.appendingPathComponent("secret.txt")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("docs"), withIntermediateDirectories: true)
        try Data("<html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data("js".utf8).write(to: root.appendingPathComponent("assets/app.js"))
        try Data("docs".utf8).write(to: root.appendingPathComponent("docs/index.html"))
        try Data("a b".utf8).write(to: root.appendingPathComponent("assets/a b.js"))
        try Data("secret".utf8).write(to: outside)
        try fm.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: base)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    private func name(_ resolution: StaticFileResolver.Resolution) -> String {
        switch resolution {
        case .file(let url):
            let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
            return url.path.replacingOccurrences(of: rootPath, with: "")
        case .notFound: return "404"
        case .forbidden: return "403"
        }
    }

    func testServesFilesAndDirectoryIndexes() {
        let resolver = StaticFileResolver(root: root)
        XCTAssertEqual(name(resolver.resolve(requestPath: "/")), "/index.html")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/assets/app.js")), "/assets/app.js")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/assets/a%20b.js")), "/assets/a b.js")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/docs")), "/docs/index.html")
        XCTAssertEqual(name(resolver.resolve(requestPath: "//assets//./app.js")), "/assets/app.js")
    }

    func testSPAFallbackAndAssetMisses() {
        let resolver = StaticFileResolver(root: root)
        XCTAssertEqual(name(resolver.resolve(requestPath: "/some/deep/link")), "/index.html")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/missing.js")), "404")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/assets/missing")), "404")
        XCTAssertEqual(name(resolver.resolve(requestPath: "/data/nothing")), "404")
    }

    func testTraversalIsImpossible() {
        let resolver = StaticFileResolver(root: root)
        for attempt in [
            "/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt",
            "/assets/..%2f..%2fsecret.txt", "/..\\secret.txt", "/assets%5c..%5c..%5csecret.txt",
            "/index.html%00.js", "/%ZZ", "/escape/secret.txt", "/escape",
        ] {
            let result = resolver.resolve(requestPath: attempt)
            if case .file(let url) = result {
                XCTAssertFalse(url.path.hasSuffix("secret.txt"), "\(attempt) escaped to \(url.path)")
                XCTAssertTrue(url.path.hasPrefix(root.standardizedFileURL.resolvingSymlinksInPath().path), attempt)
            }
        }
        XCTAssertEqual(resolver.resolve(requestPath: "/../secret.txt"), .forbidden)
        XCTAssertEqual(resolver.resolve(requestPath: "/%2e%2e/secret.txt"), .forbidden)
        XCTAssertEqual(resolver.resolve(requestPath: "/escape/secret.txt"), .forbidden)
        XCTAssertEqual(resolver.resolve(requestPath: "relative"), .forbidden)
    }
}

final class APIProxyTests: XCTestCase {
    private func request(_ target: String, method: String = "GET") -> HTTPRequest {
        HTTPRequest(method: method, target: target, version: "HTTP/1.1", headers: [:])
    }

    func testUpstreamURLKeepsPathAndQueryButNeverHost() {
        let proxy = APIProxy(upstream: URL(string: "https://cosmosmap.org")!)
        XCTAssertEqual(proxy.upstreamURL(for: request("/api/object-info?name=M%2031&x=1"))?.absoluteString,
                       "https://cosmosmap.org/api/object-info?name=M%2031&x=1")
        XCTAssertEqual(proxy.upstreamURL(for: request("/api/health"))?.absoluteString, "https://cosmosmap.org/api/health")
        XCTAssertEqual(proxy.upstreamURL(for: request("/api//evil.com/x"))?.host, "cosmosmap.org")
        XCTAssertEqual(proxy.upstreamURL(for: request("/api/@evil.com"))?.host, "cosmosmap.org")
        XCTAssertNil(proxy.upstreamURL(for: request("/apix")))
        XCTAssertNil(proxy.upstreamURL(for: request("/index.html")))
    }

    func testRejectsNonReadMethods() {
        let proxy = APIProxy(upstream: URL(string: "https://cosmosmap.org")!)
        let done = expectation(description: "response")
        proxy.forward(request("/api/health", method: "POST")) { response in
            XCTAssertEqual(response.status, 405)
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
    }

    func testDiagnosticsPostIsTheOnlyAllowedBody() {
        XCTAssertTrue(APIProxy.allows(request("/api/client-diagnostics", method: "POST")))
        XCTAssertFalse(APIProxy.allows(request("/api/client-diagnostics/x", method: "POST")))
        XCTAssertFalse(APIProxy.allows(request("/api/horizons", method: "POST")))
        XCTAssertFalse(APIProxy.allows(request("/api/client-diagnostics", method: "PUT")))

        let proxy = APIProxy(upstream: URL(string: "http://127.0.0.1:9")!, requestTimeout: 2, resourceTimeout: 2)
        let done = expectation(description: "response")
        var post = request("/api/client-diagnostics", method: "POST")
        post.body = Data("{}".utf8)
        // No application/json content type: refused before anything is sent upstream.
        proxy.forward(post) { response in
            XCTAssertEqual(response.status, 415)
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
    }

    func testClientDiagnosticsSummary() throws {
        let json = #"""
        {"session":"abc123","reason":"probe","adapter":{"vendor":"apple","architecture":"common-3"},
         "brokenPipelines":["black-hole-postprocess-pipeline"],
         "entries":[{"kind":"pipeline","severity":"error","label":"black-hole-postprocess-pipeline [validation]","message":"boom"},
                    {"kind":"probe","severity":"warning","label":"render-probe","message":"x"}]}
        """#
        let summary = try XCTUnwrap(ClientDiagnosticsSummary(json: Data(json.utf8)))
        XCTAssertEqual(summary.session, "abc123")
        XCTAssertEqual(summary.adapter, "apple / common-3")
        XCTAssertEqual(summary.errorCount, 1)
        XCTAssertEqual(summary.brokenPipelines, ["black-hole-postprocess-pipeline"])
        XCTAssertEqual(summary.firstErrors, ["pipeline black-hole-postprocess-pipeline [validation]: boom"])
        XCTAssertNil(ClientDiagnosticsSummary(json: Data("[1,2]".utf8)))
        XCTAssertNil(ClientDiagnosticsSummary(json: Data("not json".utf8)))
    }

    func testOfflineResponseShape() throws {
        let response = APIProxy.offline()
        XCTAssertEqual(response.status, 503)
        let json = try JSONSerialization.jsonObject(with: response.body) as? [String: String]
        XCTAssertEqual(json?["error"], "offline")
    }

    func testUnreachableUpstreamBecomesOffline503() {
        // Port 9 on loopback is closed: connection refused immediately.
        let proxy = APIProxy(upstream: URL(string: "http://127.0.0.1:9")!, requestTimeout: 2, resourceTimeout: 2)
        let done = expectation(description: "response")
        proxy.forward(request("/api/health")) { response in
            XCTAssertEqual(response.status, 503)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
    }
}

final class LoopbackTests: XCTestCase {
    func testLoopbackDetection() {
        XCTAssertTrue(LocalHTTPServer.isLoopback(.ipv4(.loopback)))
        XCTAssertTrue(LocalHTTPServer.isLoopback(.ipv6(.loopback)))
        XCTAssertTrue(LocalHTTPServer.isLoopback(.ipv6(IPv6Address("::ffff:127.0.0.1")!)))
        XCTAssertFalse(LocalHTTPServer.isLoopback(.ipv4(IPv4Address("192.168.1.2")!)))
        XCTAssertFalse(LocalHTTPServer.isLoopback(.ipv6(IPv6Address("fe80::1")!)))
    }
}

/// End-to-end: real listener + URLSession against a temp web root.
final class LocalHTTPServerIntegrationTests: XCTestCase {
    private var root: URL!
    private var server: LocalHTTPServer!
    private var port: UInt16 = 0

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("data"), withIntermediateDirectories: true)
        try Data("<!doctype html><title>t</title>".utf8).write(to: root.appendingPathComponent("index.html"))
        var big = Data(count: 1_000_000)
        for i in 0..<big.count { big[i] = UInt8(truncatingIfNeeded: i) }
        try big.write(to: root.appendingPathComponent("data/big.bin"))

        let ready = expectation(description: "ready")
        let context = HTTPServerContext(resolver: StaticFileResolver(root: root),
                                        proxy: APIProxy(upstream: URL(string: "http://127.0.0.1:9")!, requestTimeout: 2, resourceTimeout: 2),
                                        etagSeed: "test")
        server = LocalHTTPServer(context: context) { [weak self] event in
            if case .ready(let port) = event { self?.port = port; ready.fulfill() }
        }
        try server.start(port: 0)
        wait(for: [ready], timeout: 5)
    }

    override func tearDownWithError() throws {
        server.stop()
        try? FileManager.default.removeItem(at: root)
    }

    private func fetch(_ path: String, method: String = "GET", headers: [String: String] = [:],
                       body: Data? = nil) -> (HTTPURLResponse, Data) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let done = expectation(description: path)
        var result: (HTTPURLResponse, Data)?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse { result = (http, data ?? Data()) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return result!
    }

    func testServesIndexWithIsolationHeaders() {
        let (response, body) = fetch("/")
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        XCTAssertEqual(response.value(forHTTPHeaderField: "Cross-Origin-Opener-Policy"), "same-origin")
        XCTAssertEqual(response.value(forHTTPHeaderField: "Cross-Origin-Embedder-Policy"), "require-corp")
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("<title>t</title>"))
        XCTAssertEqual(fetch("/deep/link").0.statusCode, 200)
        XCTAssertEqual(fetch("/data/missing.bin").0.statusCode, 404)
    }

    func testStreamsLargeFileAndRanges() {
        let (full, body) = fetch("/data/big.bin")
        XCTAssertEqual(full.statusCode, 200)
        XCTAssertEqual(body.count, 1_000_000)
        XCTAssertEqual(body[999_999], UInt8(truncatingIfNeeded: 999_999))

        let (partial, slice) = fetch("/data/big.bin", headers: ["Range": "bytes=500000-500009"])
        XCTAssertEqual(partial.statusCode, 206)
        XCTAssertEqual(partial.value(forHTTPHeaderField: "Content-Range"), "bytes 500000-500009/1000000")
        XCTAssertEqual(Array(slice), (500_000..<500_010).map { UInt8(truncatingIfNeeded: $0) })

        XCTAssertEqual(fetch("/data/big.bin", headers: ["Range": "bytes=2000000-"]).0.statusCode, 416)

        let (head, headBody) = fetch("/data/big.bin", method: "HEAD")
        XCTAssertEqual(head.statusCode, 200)
        XCTAssertEqual(head.value(forHTTPHeaderField: "Content-Length"), "1000000")
        XCTAssertTrue(headBody.isEmpty)

        let etag = full.value(forHTTPHeaderField: "ETag") ?? ""
        XCTAssertEqual(fetch("/data/big.bin", headers: ["If-None-Match": etag]).0.statusCode, 304)
    }

    func testDiagnosticsPostBodyIsReadAndForwarded() {
        let json = ["Content-Type": "application/json"]
        // The body is read and forwarded; the (closed) upstream makes that a 503.
        let (offline, body) = fetch("/api/client-diagnostics", method: "POST", headers: json,
                                    body: Data(#"{"v":1,"entries":[]}"#.utf8))
        XCTAssertEqual(offline.statusCode, 503)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"error":"offline"}"#)
        // Bigger than 64 KB: refused without contacting the upstream.
        XCTAssertEqual(fetch("/api/client-diagnostics", method: "POST", headers: json,
                             body: Data(count: 70 * 1024)).0.statusCode, 413)
        // Any other POST with a body is still refused.
        XCTAssertEqual(fetch("/api/horizons", method: "POST", headers: json, body: Data("{}".utf8)).0.statusCode, 405)
    }

    func testMethodAndProxyErrors() {
        XCTAssertEqual(fetch("/", method: "DELETE").0.statusCode, 405)
        let (offline, body) = fetch("/api/health")
        XCTAssertEqual(offline.statusCode, 503)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"error":"offline"}"#)
    }
}
