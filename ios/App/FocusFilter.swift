import AppIntents
import Intents

/// Focus on: Wisp only lets through what Claude explicitly wants from you (permission for a
/// command) and stays quiet about somebody finishing or failing.
///
/// The setting is merely stored. Whether it is acted on is decided at the moment of the alert,
/// from whether Focus really is on (see `focusQuiet`). Were iOS to stop saying that the filter
/// ended, the alerts come back on their own instead of disappearing forever.
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

/// Should everything but permissions stay quiet right now? Only when Focus really is on. When
/// iOS cannot be asked for the state (no permission given, an older system), the answer is no:
/// better one alert too many than one lost.
@MainActor
func focusQuiet() -> Bool {
    guard UserDefaults.standard.bool(forKey: focusQuietKey) else { return false }
    guard INFocusStatusCenter.default.authorizationStatus == .authorized else { return false }
    return INFocusStatusCenter.default.focusStatus.isFocused == true
}
