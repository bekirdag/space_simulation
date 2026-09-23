import Foundation
import Network

/// Shared, immutable per-server state handed to each connection.
final class HTTPServerContext {
    let resolver: StaticFileResolver
    let proxy: APIProxy
    private let etagSeed: String

    init(resolver: StaticFileResolver, proxy: APIProxy, etagSeed: String) {
        self.resolver = resolver
        self.proxy = proxy
        self.etagSeed = etagSeed
    }

    /// Bundle files only change with a new build, so size + build identity is a sufficient
    /// validator per URL (and avoids file-timestamp APIs entirely).
    func etag(size: Int) -> String {
        "\"\(String(size, radix: 16))-\(etagSeed)\""
    }
}

/// A minimal HTTP/1.1 server bound to 127.0.0.1 that serves the bundled web build and
/// proxies `/api/*` to the public backend.
final class LocalHTTPServer {
    enum Event {
        case ready(port: UInt16)
        case failed(Error)
    }

    enum ServerError: LocalizedError {
        case webContentMissing(String)
        case portUnavailable

        var errorDescription: String? {
            switch self {
            case .webContentMissing(let path): return "Bundled web content is missing (\(path))."
            case .portUnavailable: return "The listener did not report a port."
            }
        }
    }

    private let context: HTTPServerContext
    private let queue = DispatchQueue(label: "org.cosmosmap.http.listener")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]
    private let onEvent: (Event) -> Void

    init(context: HTTPServerContext, onEvent: @escaping (Event) -> Void) {
        self.context = context
        self.onEvent = onEvent
    }

    /// Starts listening on loopback. `port` 0 asks the system for an ephemeral port.
    func start(port: UInt16) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = false
        // Loopback-only comes from binding to 127.0.0.1 (plus the peer check in accept()).
        // Do NOT set `acceptLocalOnly`: in the iOS 18 simulator it silently resets every
        // loopback connection (WebKit's networking process included) before it is accepted.
        let nwPort = NWEndpoint.Port(rawValue: port) ?? .any
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)

        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let port = listener?.port?.rawValue, port != 0 {
                    self.onEvent(.ready(port: port))
                } else {
                    self.onEvent(.failed(ServerError.portUnavailable))
                }
            case .failed(let error):
                listener?.cancel()
                self.onEvent(.failed(error))
            case .waiting(let error):
                // A loopback listener only waits when the port can't be bound; treat it as failure.
                listener?.cancel()
                self.onEvent(.failed(error))
            default:
                break
            }
        }
        self.listener = listener
        listener.start(queue: queue)
    }

    func stop() {
        queue.async {
            self.listener?.stateUpdateHandler = nil
            self.listener?.newConnectionHandler = nil
            self.listener?.cancel()
            self.listener = nil
            for connection in self.connections.values { connection.cancel() }
            self.connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        // Defence in depth: the listener is bound to 127.0.0.1, but refuse anything else anyway.
        if case .hostPort(let host, _) = connection.endpoint, !Self.isLoopback(host) {
            connection.cancel()
            return
        }
        let handler = HTTPConnection(connection: connection, context: context) { [weak self] closed in
            self?.queue.async { self?.connections.removeValue(forKey: ObjectIdentifier(closed)) }
        }
        connections[ObjectIdentifier(handler)] = handler
        handler.start()
    }

    static func isLoopback(_ host: NWEndpoint.Host) -> Bool {
        switch host {
        case .ipv4(let address): return address.isLoopback
        case .ipv6(let address):
            if address.isLoopback { return true }
            // IPv4-mapped 127.0.0.0/8.
            let raw = [UInt8](address.rawValue)
            return raw.count == 16 && raw[0..<10].allSatisfy { $0 == 0 } && raw[10] == 0xff && raw[11] == 0xff && raw[12] == 127
        case .name(let name, _): return name == "localhost"
        @unknown default: return false
        }
    }
}
