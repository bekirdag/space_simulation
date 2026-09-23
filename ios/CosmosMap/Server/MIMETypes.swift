import Foundation

/// Content types for the bundled web build. Mirrors `MIME_TYPES` in server/index.mjs,
/// plus a few types the build may grow into (wgsl, woff2, webp, tif...).
enum MIMETypes {
    static let fallback = "application/octet-stream"

    private static let table: [String: String] = [
        "html": "text/html; charset=utf-8",
        "htm": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8",
        "geojson": "application/geo+json; charset=utf-8",
        "txt": "text/plain; charset=utf-8",
        "wgsl": "text/plain; charset=utf-8",
        "bin": "application/octet-stream",
        "wasm": "application/wasm",
        "glb": "model/gltf-binary",
        "gltf": "model/gltf+json",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
        "avif": "image/avif",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "ktx2": "image/ktx2",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "otf": "font/otf",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "wav": "audio/wav",
    ]

    static func contentType(forPath path: String) -> String {
        let name = (path as NSString).lastPathComponent
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return fallback }
        let ext = name[name.index(after: dot)...].lowercased()
        return table[ext] ?? fallback
    }
}
