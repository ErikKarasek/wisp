import AppIntents

/// What the Control Center button does: it opens Wisp. The app starts on Přehled, where whatever
/// is waiting for you sits at the top. It lives in Shared because the widget extension announces
/// it, while the app is what runs it.
struct OpenWaitingIntent: AppIntent {
    static var title: LocalizedStringResource = "Otevřít, co čeká"
    static var description = IntentDescription("Otevře Wisp u toho, co po tobě Claude a agenti chtějí.")
    static var openAppWhenRun = true
    static var isDiscoverable: Bool { false }

    func perform() async throws -> some IntentResult { .result() }
}
