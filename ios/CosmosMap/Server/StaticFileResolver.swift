import Foundation

/// Maps request paths onto files inside the bundled `Web/` folder.
///
/// Traversal safety does not rely on a single check:
/// 1. the path is percent-decoded exactly once and rejected if it contains NUL, a backslash
///    or any `..` segment (so encoded `%2e%2e` is caught after decoding);
/// 2. the remaining segments are appended to the root one by one;
/// 3. the final URL is standardized and symlink-resolved and must still sit under the
///    (equally resolved) root directory.
struct StaticFileResolver {
    enum Resolution: Equatable {
        case file(URL)
        case notFound
        /// The path could not be decoded or tried to escape the root.
        case forbidden
    }

    /// Prefixes that always hold real files; a miss there is a 404, never the SPA shell.
    /// Mirrors `SPA_ASSET_PREFIXES` in server/index.mjs.
    static let assetPrefixes = ["/assets/", "/cache/", "/data/", "/draco/", "/models/", "/textures/", "/api/"]

    let root: URL
    private let rootPath: String
    private let fileManager: FileManager

    init(root: URL, fileManager: FileManager = .default) {
        let resolved = root.standardizedFileURL.resolvingSymlinksInPath()
        self.root = resolved
        self.rootPath = resolved.path.hasSuffix("/") ? resolved.path : resolved.path + "/"
        self.fileManager = fileManager
    }

    /// Decodes and validates a request path, returning its segments, or nil if unsafe.
    static func safeSegments(forRequestPath rawPath: String) -> [String]? {
        guard rawPath.hasPrefix("/") else { return nil }
        guard let decoded = rawPath.removingPercentEncoding else { return nil }
        if decoded.contains("\0") || decoded.contains("\\") { return nil }
        var segments: [String] = []
        for segment in decoded.split(separator: "/", omittingEmptySubsequences: true) {
            if segment == "." { continue }
            if segment == ".." { return nil }
            segments.append(String(segment))
        }
        return segments
    }

    func resolve(requestPath: String) -> Resolution {
        guard let segments = Self.safeSegments(forRequestPath: requestPath) else { return .forbidden }

        if let url = contained(segments) {
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) {
                if !isDirectory.boolValue { return .file(url) }
                let index = url.appendingPathComponent("index.html")
                var indexIsDirectory: ObjCBool = false
                if fileManager.fileExists(atPath: index.path, isDirectory: &indexIsDirectory), !indexIsDirectory.boolValue {
                    return .file(index)
                }
            }
        } else {
            return .forbidden
        }

        if Self.isAssetRequest(decodedPath: "/" + segments.joined(separator: "/")) { return .notFound }
        let shell = root.appendingPathComponent("index.html")
        return fileManager.fileExists(atPath: shell.path) ? .file(shell) : .notFound
    }

    /// True for paths that should 404 instead of falling back to index.html.
    static func isAssetRequest(decodedPath: String) -> Bool {
        if assetPrefixes.contains(where: { decodedPath.hasPrefix($0) }) { return true }
        let last = (decodedPath as NSString).lastPathComponent
        return !(last as NSString).pathExtension.isEmpty
    }

    private func contained(_ segments: [String]) -> URL? {
        var url = root
        for segment in segments { url.appendPathComponent(segment, isDirectory: false) }
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        let path = resolved.path
        guard path + "/" == rootPath || path.hasPrefix(rootPath) else { return nil }
        return resolved
    }
}
