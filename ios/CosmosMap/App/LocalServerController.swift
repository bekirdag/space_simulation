import Foundation
import os

/// Owns the loopback server's lifecycle and publishes the URL the web view should load.
///
/// The server prefers a fixed port so the page origin (and therefore the web app's
/// localStorage / cache, which are origin-keyed) stays the same across launches. If that
/// port is taken it falls back to an ephemeral one. If iOS reclaims the listening socket
/// while the app is suspended, the listener fails and is restarted on the same port.
@MainActor
final class LocalServerController: ObservableObject {
    enum State: Equatable {
        case starting
        case running(URL)
        case failed(String)
    }

    /// Outside the Darwin ephemeral range (49152-65535) and not on WebKit's blocked-port list.
    static let preferredPort: UInt16 = 41_873
    static let upstream = URL(string: "https://cosmosmap.org")!

    @Published private(set) var state: State = .starting

    private let log = Logger(subsystem: "com.wodo.cosmosmap", category: "server")
    private var server: LocalHTTPServer?
    private var generation = 0
    private var lastPort: UInt16?
    private var attemptedFallback = false
    private lazy var proxy = APIProxy(upstream: Self.upstream)

    var webRoot: URL? { Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) }

    func startIfNeeded() {
        switch state {
        case .running: return
        case .starting where server != nil: return
        default: start()
        }
    }

    func restart() {
        server?.stop()
        server = nil
        state = .starting
        start()
    }

    private func start() {
        guard let webRoot, FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            state = .failed("The bundled web content is missing. Rebuild the app after running ios/scripts/sync-web.sh.")
            Telemetry.recordNonFatal(.webBundleMissing)
            return
        }
        attemptedFallback = false
        proxy.warmUp()
        launch(on: lastPort ?? Self.preferredPort, webRoot: webRoot)
    }

    private func launch(on port: UInt16, webRoot: URL) {
        generation += 1
        let token = generation
        let info = Bundle.main.infoDictionary
        let seed = "\(info?["CFBundleShortVersionString"] as? String ?? "0")-\(info?["CFBundleVersion"] as? String ?? "0")"
            .replacingOccurrences(of: "\"", with: "")
        let context = HTTPServerContext(resolver: StaticFileResolver(root: webRoot), proxy: proxy, etagSeed: seed)
        let server = LocalHTTPServer(context: context) { [weak self] event in
            Task { @MainActor in self?.handle(event, token: token, webRoot: webRoot) }
        }
        self.server?.stop()
        self.server = server
        do {
            try server.start(port: port)
        } catch {
            handle(.failed(error), token: token, webRoot: webRoot)
        }
    }

    private func handle(_ event: LocalHTTPServer.Event, token: Int, webRoot: URL) {
        guard token == generation else { return }
        switch event {
        case .ready(let port):
            lastPort = port
            log.info("Local server listening on 127.0.0.1:\(port, privacy: .public)")
            let url = URL(string: "http://127.0.0.1:\(port)/")!
            if state != .running(url) { state = .running(url) }
        case .failed(let error):
            log.error("Local server failed: \(String(describing: error), privacy: .public)")
            server?.stop()
            server = nil
            if case .running = state {
                // Died after serving (e.g. socket reclaimed during suspension): rebind the same port.
                state = .starting
                attemptedFallback = false
                launch(on: lastPort ?? Self.preferredPort, webRoot: webRoot)
            } else if !attemptedFallback {
                attemptedFallback = true
                launch(on: 0, webRoot: webRoot)
            } else {
                state = .failed("CosmosMap couldn't start its local content server.\n\(error.localizedDescription)")
                Telemetry.recordNonFatal(.localServerStartFailed, underlying: error)
            }
        }
    }
}
