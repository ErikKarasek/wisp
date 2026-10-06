import AppIntents

/// Co dělá tlačítko v Ovládacím centru: otevře Wisp. Appka startuje na Přehledu,
/// kde to, co na tebe čeká, stojí nahoře. Je ve Shared, protože ho ohlašuje
/// rozšíření s widgety, ale spouští ho appka.
struct OpenWaitingIntent: AppIntent {
    static var title: LocalizedStringResource = "Otevřít, co čeká"
    static var description = IntentDescription("Otevře Wisp u toho, co po tobě Claude a agenti chtějí.")
    static var openAppWhenRun = true
    static var isDiscoverable: Bool { false }

    func perform() async throws -> some IntentResult { .result() }
}
