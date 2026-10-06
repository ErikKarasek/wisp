import AppIntents
import Intents

/// Zapnuté soustředění: Wisp pustí jen to, co po tobě Claude vysloveně chce
/// (povolení k příkazu), a mlčí o tom, že někdo doběhl nebo spadl.
///
/// Nastavení se jen uloží. Jestli se podle něj jede, se rozhoduje až v
/// okamžiku upozornění podle toho, jestli je soustředění opravdu zapnuté
/// (viz `focusQuiet`). Kdyby iOS přestal říkat, že filtr skončil, upozornění
/// se tím vrátí sama, místo aby navždycky zmizela.
struct QuietFocusFilter: SetFocusFilterIntent {
    static var title: LocalizedStringResource = "Jen to, co čeká na tebe"
    static var description: IntentDescription? = IntentDescription(
        "Při tomhle soustředění Wisp upozorní jen na povolení, která po tobě Claude chce, a zbytek nechá být."
    )

    @Parameter(title: "Jen povolení a otázky", default: true)
    var onlyApprovals: Bool

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: onlyApprovals ? "Jen povolení a otázky" : "Všechno jako jindy",
            subtitle: onlyApprovals ? "O doběhnutých a spadlých agentech Wisp pomlčí" : nil
        )
    }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(onlyApprovals, forKey: focusQuietKey)
        return .result()
    }
}

let focusQuietKey = "focusOnlyApprovals"

/// Má se teď mlčet o všem kromě povolení? Jen když je soustředění opravdu
/// zapnuté. Když se iOS na stav zeptat nedá (nedal svolení, starší systém),
/// odpověď je ne: lepší upozornění navíc než ztracené.
@MainActor
func focusQuiet() -> Bool {
    guard UserDefaults.standard.bool(forKey: focusQuietKey) else { return false }
    guard INFocusStatusCenter.default.authorizationStatus == .authorized else { return false }
    return INFocusStatusCenter.default.focusStatus.isFocused == true
}
