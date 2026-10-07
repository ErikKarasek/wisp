import AppIntents
import SwiftUI
import WidgetKit

/// Tlačítko v Ovládacím centru (iOS 18): kolik věcí čeká na tebe, a klepnutím Wisp otevře.
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

    /// nil znamená „nevím“, ne „je klid“. Kdyby se výpadek relay nebo starý snímek (Mac
    /// mlčí přes 300 s, stejně jako ve `statusLine`) počítal jako nula, tvářilo by se
    /// spadlé spojení jako dobrá zpráva, což je ta horší ze dvou lží.
    func currentValue() async throws -> Int? {
        guard let (s, at) = try? await Relay.state(), Date().timeIntervalSince(at) <= 300 else { return nil }
        return s.waiting.count + (s.perms?.count ?? 0)
    }
}
