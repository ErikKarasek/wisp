import AppIntents
import WidgetKit

// Buttons right on the home-screen widgets (iOS 17): they run without opening the app.

/// Fetch the Mac's state again now, instead of waiting for iOS's next refresh.
struct RefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Obnovit Wisp"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

/// Wake an agent from the widget: the same as "Probudit" in the app.
struct WakeAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Probudit agenta"
    static var openAppWhenRun = false

    @Parameter(title: "Agent") var agentId: String

    init() {}
    init(agentId: String) { self.agentId = agentId }

    func perform() async throws -> some IntentResult {
        try await Relay.send(["kind": "agent", "agentId": agentId, "action": "agentInvoke"])
        // The Mac picks it up within 10 s; look again a little later.
        try? await Task.sleep(for: .seconds(12))
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
