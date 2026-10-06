import ActivityKit
import AppIntents
import Foundation

/// A button on the lock-screen card or in the Dynamic Island: answer Claude's
/// permission prompt without opening the app. It runs in the app's process.
///
/// Buttons on a Live Activity work while the iPhone is locked, so without this
/// anyone holding the phone could let a command through on the Mac. The policy
/// makes iOS unlock the phone first (Face ID, or the passcode), and only then
/// does the answer go out.
struct PermissionIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Odpovědět Claudovi"
    static var openAppWhenRun = false
    static var isDiscoverable: Bool { false }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    @Parameter(title: "Žádost") var permId: String
    @Parameter(title: "Odpověď") var answer: String

    init() {}
    init(permId: String, answer: String) {
        self.permId = permId
        self.answer = answer
    }

    func perform() async throws -> some IntentResult {
        try await Relay.send(["kind": "perm", "permId": permId, "answer": answer])
        // Show at once that it went out; the next refresh brings the real state.
        let said = ["allow": "Povoleno", "always": "Povoleno i příště", "deny": "Zamítnuto"][answer] ?? "Odesláno"
        for a in Activity<DispecinkActivity>.activities {
            var s = a.content.state
            s.mode = "done"
            s.title = "\(said) · Mac to převezme do 10 s"
            s.detail = ""
            s.permId = nil
            s.perms = max(0, s.perms - 1)
            await a.update(ActivityContent(state: s, staleDate: nil))
        }
        return .result()
    }
}
