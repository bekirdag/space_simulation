import Foundation
import Network

/// One accepted TCP connection. Requests are handled strictly one at a time (no pipelining
/// concurrency); after each response the connection either reads the next request
/// (keep-alive) or closes. All state is confined to `queue`.
final class HTTPConnection {
    static let chunkSize = 256 * 1024
    static let idleTimeout: TimeInterval = 30

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let context: HTTPServerContext
    private let onClose: (HTTPConnection) -> Void

    private var buffer = Data()
    private var closed = false
    private var idleTimer: DispatchWorkItem?

    init(connection: NWConnection, context: HTTPServerContext, onClose: @escaping (HTTPConnection) -> Void) {
        self.connection = connection
        self.context = context
        self.onClose = onClose
        self.queue = DispatchQueue(label: "org.cosmosmap.http.connection")
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.close()
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.async { self.readNextRequest() }
    }

    func cancel() {
        queue.async { self.close() }
    }

    // MARK: - Reading

    private func readNextRequest() {
        guard !closed else { return }
        switch HTTPParser.parse(buffer) {
        case .incomplete:
            armIdleTimer()
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
                guard let self else { return }
                self.idleTimer?.cancel()
                if let data, !data.isEmpty { self.buffer.append(data) }
                if error != nil || (isComplete && (data?.isEmpty ?? true)) {
                    self.close()
                    return
                }
                self.readNextRequest()
            }
        case .error(let status):
            buffer.removeAll()
            sendSimple(status: status, message: HTTPResponseHead.reason(for: status), keepAlive: false, isHead: false)
        case .request(let request, let consumed):
            buffer.removeFirst(consumed)
            handle(request)
        }
    }

    private func armIdleTimer() {
        idleTimer?.cancel()
        let timer = DispatchWorkItem { [weak self] in self?.close() }
        idleTimer = timer
        queue.asyncAfter(deadline: .now() + Self.idleTimeout, execute: timer)
    }

    // MARK: - Routing

    private func handle(_ request: HTTPRequest) {
        let isHead = request.method == "HEAD"
        // Bodies are never expected; refusing them keeps the framing trivially correct.
        if request.declaresBody {
            sendSimple(status: 405, message: "Request bodies are not supported", keepAlive: false, isHead: isHead,
                       extraHeaders: [("Allow", "GET, HEAD")])
            return
        }
        let keepAlive = request.wantsKeepAlive

        if APIProxy.handles(path: request.path) {
            context.proxy.forward(request) { [weak self] response in
                guard let self else { return }
                self.queue.async { self.sendProxied(response, keepAlive: keepAlive, isHead: isHead) }
            }
            return
        }

        guard request.method == "GET" || isHead else {
            sendSimple(status: 405, message: "Method not allowed", keepAlive: keepAlive, isHead: isHead,
                       extraHeaders: [("Allow", "GET, HEAD")])
            return
        }

        switch context.resolver.resolve(requestPath: request.path) {
        case .forbidden:
            sendSimple(status: 400, message: "Bad request path", keepAlive: keepAlive, isHead: isHead)
        case .notFound:
            sendSimple(status: 404, message: "Not found", keepAlive: keepAlive, isHead: isHead)
        case .file(let url):
            sendFile(url, request: request, keepAlive: keepAlive, isHead: isHead)
        }
    }

    // MARK: - Responses

    private func baseHead(status: Int, keepAlive: Bool) -> HTTPResponseHead {
        var head = HTTPResponseHead(status: status)
        head.set("Server", "CosmosMap-iPad")
        head.set("Cache-Control", "no-cache")
        head.set("Cross-Origin-Opener-Policy", "same-origin")
        head.set("Cross-Origin-Embedder-Policy", "require-corp")
        head.set("Cross-Origin-Resource-Policy", "same-origin")
        head.set("X-Content-Type-Options", "nosniff")
        head.set("Connection", keepAlive ? "keep-alive" : "close")
        return head
    }

    private func sendSimple(status: Int, message: String, keepAlive: Bool, isHead: Bool,
                            extraHeaders: [(String, String)] = []) {
        var head = baseHead(status: status, keepAlive: keepAlive)
        for (name, value) in extraHeaders { head.set(name, value) }
        let body = Data((message + "\n").utf8)
        head.set("Content-Type", "text/plain; charset=utf-8")
        head.set("Content-Length", String(body.count))
        send(head: head, body: isHead ? nil : body, keepAlive: keepAlive)
    }

    private func sendProxied(_ response: APIProxy.Response, keepAlive: Bool, isHead: Bool) {
        var head = baseHead(status: response.status, keepAlive: keepAlive)
        for (name, value) in response.headers { head.set(name, value) }
        let bodyAllowed = !HTTPResponseHead.forbidsBody(response.status)
        if bodyAllowed, !isHead {
            head.set("Content-Length", String(response.body.count))
        } else if !bodyAllowed {
            head.headers.removeAll { $0.0.caseInsensitiveCompare("Content-Length") == .orderedSame }
        } else if head.value("Content-Length") == nil {
            head.set("Content-Length", "0")
        }
        send(head: head, body: (isHead || !bodyAllowed) ? nil : response.body, keepAlive: keepAlive)
    }

    private func sendFile(_ url: URL, request: HTTPRequest, keepAlive: Bool, isHead: Bool) {
        let handle: FileHandle
        let size: Int
        do {
            handle = try FileHandle(forReadingFrom: url)
            // seekToEnd() gives the size without touching file-timestamp (required-reason) APIs.
            size = Int(try handle.seekToEnd())
        } catch {
            sendSimple(status: 404, message: "Not found", keepAlive: keepAlive, isHead: isHead)
            return
        }

        let etag = context.etag(size: size)
        var head = baseHead(status: 200, keepAlive: keepAlive)
        head.set("Content-Type", MIMETypes.contentType(forPath: url.path))
        head.set("Accept-Ranges", "bytes")
        head.set("ETag", etag)
        if url.lastPathComponent == "index.html" { head.set("Cache-Control", "no-store") }

        if let ifNoneMatch = request.header("if-none-match"), Self.etagMatches(ifNoneMatch, etag) {
            try? handle.close()
            head.status = 304
            head.headers.removeAll { $0.0 == "Content-Type" }
            send(head: head, body: nil, keepAlive: keepAlive)
            return
        }

        var rangeHeader = request.header("range")
        if let ifRange = request.header("if-range"), ifRange.trimmingCharacters(in: .whitespaces) != etag {
            rangeHeader = nil
        }

        var start = 0
        var length = size
        switch RangeRequest.parse(rangeHeader, size: size) {
        case .none:
            break
        case .unsatisfiable:
            try? handle.close()
            var errorHead = baseHead(status: 416, keepAlive: keepAlive)
            errorHead.set("Content-Range", "bytes */\(size)")
            errorHead.set("Content-Length", "0")
            send(head: errorHead, body: nil, keepAlive: keepAlive)
            return
        case .partial(let range):
            head.status = 206
            head.set("Content-Range", range.contentRangeHeader(totalSize: size))
            start = range.start
            length = range.length
        }
        head.set("Content-Length", String(length))

        if isHead || length == 0 {
            try? handle.close()
            send(head: head, body: nil, keepAlive: keepAlive)
            return
        }

        do {
            try handle.seek(toOffset: UInt64(start))
        } catch {
            try? handle.close()
            close()
            return
        }
        connection.send(content: head.serialized(), completion: .contentProcessed { [weak self] error in
            guard let self else { try? handle.close(); return }
            if error != nil { try? handle.close(); self.close(); return }
            self.streamChunks(from: handle, remaining: length, keepAlive: keepAlive)
        })
    }

    /// Sends the file in fixed-size chunks, reading the next chunk only once the previous
    /// one has been handed to the network stack, so memory stays bounded for big files.
    private func streamChunks(from handle: FileHandle, remaining: Int, keepAlive: Bool) {
        guard !closed else { try? handle.close(); return }
        if remaining <= 0 {
            try? handle.close()
            finishResponse(keepAlive: keepAlive)
            return
        }
        let chunk: Data
        do {
            chunk = try handle.read(upToCount: min(Self.chunkSize, remaining)) ?? Data()
        } catch {
            try? handle.close()
            close()
            return
        }
        if chunk.isEmpty {
            // File shrank underneath us; the declared length can no longer be honoured.
            try? handle.close()
            close()
            return
        }
        connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
            guard let self else { try? handle.close(); return }
            if error != nil { try? handle.close(); self.close(); return }
            self.streamChunks(from: handle, remaining: remaining - chunk.count, keepAlive: keepAlive)
        })
    }

    private func send(head: HTTPResponseHead, body: Data?, keepAlive: Bool) {
        var payload = head.serialized()
        if let body { payload.append(body) }
        connection.send(content: payload, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            if error != nil { self.close(); return }
            self.finishResponse(keepAlive: keepAlive)
        })
    }

    private func finishResponse(keepAlive: Bool) {
        if keepAlive {
            readNextRequest()
        } else {
            // Let the final bytes flush, then close our side.
            connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
                self?.close()
            })
        }
    }

    private func close() {
        guard !closed else { return }
        closed = true
        idleTimer?.cancel()
        idleTimer = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        onClose(self)
    }

    static func etagMatches(_ header: String, _ etag: String) -> Bool {
        let opaque = etag.replacingOccurrences(of: "W/", with: "")
        return header.split(separator: ",").contains { raw in
            let tag = raw.trimmingCharacters(in: .whitespaces)
            return tag == "*" || tag.replacingOccurrences(of: "W/", with: "") == opaque
        }
    }
}
