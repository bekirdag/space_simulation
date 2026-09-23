import FirebaseAnalytics
import FirebaseCore
import FirebaseCrashlytics
import Foundation
import os

/// Firebase Crashlytics + Analytics, enabled only when the build contains
/// GoogleService-Info.plist (CI adds it from a secret; local builds usually don't have it).
///
/// Privacy: the app links FirebaseAnalyticsCore (no IDFA / AdSupport), Info.plist turns off
/// IDFV collection, ad storage, ad personalization and ad-network registration, and no user
/// identifier is ever set.
@MainActor
enum Telemetry {
    private(set) static var isEnabled = false
    private static let logger = Logger(subsystem: "com.wodo.cosmosmap", category: "telemetry")

    static func configure() {
        guard !isEnabled else { return }
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            logger.info("GoogleService-Info.plist not bundled; Firebase disabled")
            return
        }
        FirebaseApp.configure()
        isEnabled = true

        let crashlytics = Crashlytics.crashlytics()
        crashlytics.setCustomValue(appVersion, forKey: "app_version")
        crashlytics.setCustomValue(webBundlePresent, forKey: "web_bundle_present")

        Analytics.logEvent(AnalyticsEventScreenView, parameters: [
            AnalyticsParameterScreenName: "cosmosmap",
            AnalyticsParameterScreenClass: "WebView",
        ])
    }

    /// Forwards a validated event from the web app to Firebase Analytics.
    static func log(_ event: NativeAnalyticsEvent) {
        guard isEnabled else { return }
        Analytics.logEvent(event.name, parameters: event.parameters.isEmpty ? nil : event.parameters)
    }

    /// Records a non-fatal error in Crashlytics (grouped by `kind`; the underlying error's
    /// description goes along as user info).
    static func recordNonFatal(_ kind: TelemetryError, underlying: Error? = nil) {
        guard isEnabled else { return }
        var userInfo: [String: Any] = [:]
        if let underlying {
            userInfo[NSUnderlyingErrorKey] = underlying as NSError
            userInfo["underlying_description"] = String(describing: underlying)
        }
        Crashlytics.crashlytics().record(
            error: NSError(domain: TelemetryError.errorDomain, code: kind.rawValue, userInfo: userInfo)
        )
    }

    /// Web sessions whose GPU errors were already recorded as a non-fatal.
    private static var gpuNonFatalSessions = Set<String>()

    /// The web app's WebGPU diagnostics report (POST /api/client-diagnostics, seen by the
    /// local /api proxy): a Crashlytics log line, custom keys, and one non-fatal per web
    /// session that reported GPU errors.
    static func recordClientDiagnostics(_ body: Data) {
        guard isEnabled else { return }
        let crashlytics = Crashlytics.crashlytics()
        crashlytics.log("client-diagnostics: \(String(decoding: body.prefix(16 * 1024), as: UTF8.self))")
        guard let summary = ClientDiagnosticsSummary(json: body) else { return }
        if !summary.adapter.isEmpty { crashlytics.setCustomValue(summary.adapter, forKey: "gpu_adapter") }
        crashlytics.setCustomValue(summary.errorCount, forKey: "gpu_error_count")
        guard summary.errorCount > 0, gpuNonFatalSessions.count < 20,
              gpuNonFatalSessions.insert(summary.session).inserted else { return }
        var userInfo: [String: Any] = [
            "gpu_adapter": summary.adapter,
            "gpu_error_count": summary.errorCount,
            "report_reason": summary.reason,
        ]
        if !summary.brokenPipelines.isEmpty {
            userInfo["broken_pipelines"] = summary.brokenPipelines.joined(separator: ", ")
        }
        for (index, message) in summary.firstErrors.enumerated() {
            userInfo["gpu_error_\(index + 1)"] = message
        }
        crashlytics.record(error: NSError(domain: TelemetryError.errorDomain,
                                          code: TelemetryError.webGPUErrors.rawValue,
                                          userInfo: userInfo))
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "0") (\(info?["CFBundleVersion"] as? String ?? "0"))"
    }

    private static var webBundlePresent: Bool {
        guard let index = Bundle.main.resourceURL?.appendingPathComponent("Web/index.html") else { return false }
        return FileManager.default.fileExists(atPath: index.path)
    }
}

/// Non-fatal errors reported to Crashlytics.
enum TelemetryError: Int, Error, CustomNSError {
    case webContentProcessTerminated = 1
    case localServerStartFailed = 2
    case webBundleMissing = 3
    /// The web app reported WebGPU shader/pipeline/validation errors (client diagnostics).
    case webGPUErrors = 4

    static var errorDomain: String { "com.wodo.cosmosmap.telemetry" }
}
