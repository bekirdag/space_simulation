import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Telemetry.configure()
        return true
    }
}

@main
struct CosmosMapApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var server = LocalServerController()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(server)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var server: LocalServerController
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color("LaunchBackground")
                .ignoresSafeArea()

            switch server.state {
            case .starting:
                EmptyView()
            case .running(let url):
                WebView(url: url)
                    .ignoresSafeArea()
            case .failed(let message):
                ServerFailureView(message: message) { server.restart() }
            }
        }
        .statusBarHidden(true)
        // Auto-hides the home indicator (SwiftUI's prefersHomeIndicatorAutoHidden).
        .persistentSystemOverlays(.hidden)
        .preferredColorScheme(.dark)
        .onAppear { server.startIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { server.startIfNeeded() }
        }
    }
}

struct ServerFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Text("CosmosMap")
                .font(.system(.title, design: .monospaced).weight(.semibold))
            Text(message)
                .font(.system(.body, design: .monospaced))
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 520)
            Button("Try Again", action: retry)
                .buttonStyle(.bordered)
        }
        .foregroundStyle(Color(red: 200 / 255, green: 208 / 255, blue: 1))
        .padding(32)
    }
}
