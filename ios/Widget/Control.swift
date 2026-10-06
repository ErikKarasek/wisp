import AppIntents
import SwiftUI
import WidgetKit

/// Tlačítko v Ovládacím centru (iOS 18): kolik věcí čeká na tebe, a klepnutím Wisp otevře.
@available(iOS 18.0, *)
struct WaitingControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "cz.erikkarasek.dispecink.phone.waiting", provider: WaitingProvider()) { count in
            ControlWidgetButton(action: OpenWaitingIntent()) {
                Label(count == 0 ? "Nikdo nic nechce" : "Čeká na tebe \(count)", systemImage: count == 0 ? "checkmark.circle" : "bell.badge")
            }
        }
        .displayName("Kdo tě potřebuje")
        .description("Kolik věcí čeká na tebe, a otevře je.")
    }
}

@available(iOS 18.0, *)
struct WaitingProvider: ControlValueProvider {
    var previewValue: Int { 2 }

    func currentValue() async throws -> Int {
        // Mlčí, když Mac neodpoví: nula je tu „nevím o ničem“, ne tvrzení, že je klid.
        guard let (s, _) = try? await Relay.state() else { return 0 }
        return s.waiting.count + (s.perms?.count ?? 0)
    }
}
