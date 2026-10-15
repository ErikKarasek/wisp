import AppIntents
import SwiftUI
import WidgetKit

/// The Control Center button (iOS 18): how many things are waiting for you, and a tap opens Wisp.
@available(iOS 18.0, *)
struct WaitingControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "cz.erikkarasek.dispecink.phone.waiting", provider: WaitingProvider()) { count in
            ControlWidgetButton(action: OpenWaitingIntent()) {
                switch count {
                case .none: Label("Mac se neozývá", systemImage: "wifi.slash")
                case 0: Label("Nikdo nic nechce", systemImage: "checkmark.circle")
                case let .some(n): Label("Čeká na tebe \(n)", systemImage: "bell.badge")
                }
            }
        }
        .displayName("Kdo tě potřebuje")
        .description("Kolik věcí čeká na tebe, a otevře je.")
    }
}

@available(iOS 18.0, *)
struct WaitingProvider: ControlValueProvider {
    var previewValue: Int? { 2 }

    /// nil means "do not know", not "all quiet". If a relay outage or a stale snapshot (the Mac
    /// silent for over 300 s, same as in `statusLine`) counted as zero, a dead connection would
    /// pose as good news, which is the worse of the two lies.
    func currentValue() async throws -> Int? {
        guard let (s, at) = try? await Relay.state(), Date().timeIntervalSince(at) <= 300 else { return nil }
        return s.waiting.count + (s.perms?.count ?? 0)
    }
}
