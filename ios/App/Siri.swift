import AppIntents
import Foundation

// Siri a Zkratky: zeptat se, co agenti dělají, a zadat jim úkol, aniž bys appku otevřel.

/// 1 agent, 2 agenti, 5 agentů.
func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
    "\(n) " + (n == 1 ? one : (2...4).contains(n) ? few : many)
}

/// Jedna věta o všem, pro Siri i pro Ovládací centrum.
func statusLine(_ s: PhoneState, pushed: Date) -> String {
    if Date().timeIntervalSince(pushed) > 300 {
        return "Mac se neozval \(agoText(pushed)), takže nevím, co je nového."
    }
    let bad = s.items.filter { $0.state == "bad" }
    let waiting = s.waiting.filter { $0.state != "bad" }
    let perms = s.perms?.count ?? 0
    var parts: [String] = []
    if s.counts.run > 0 { parts.append("pracuje \(plural(s.counts.run, "agent", "agenti", "agentů"))") }
    if perms > 0 { parts.append("\(plural(perms, "povolení čeká", "povolení čekají", "povolení čeká")) na tebe") }
    if !waiting.isEmpty { parts.append("\(plural(waiting.count, "agent chce", "agenti chtějí", "agentů chce")) něco vědět") }
    if !bad.isEmpty { parts.append("selhal\(bad.count == 1 ? "" : "o") \(bad.map(\.name).joined(separator: " a "))") }
    if parts.isEmpty { return "Klid, nikdo nic nechce." }
    // „Pracují dva agenti a Hlídač závislostí selhal.“
    let last = parts.removeLast()
    let text = parts.isEmpty ? last : parts.joined(separator: ", ") + " a " + last
    return text.prefix(1).uppercased() + text.dropFirst() + "."
}

/// „Co dělají agenti v aplikaci Wisp“: Siri se zeptá Macu a přečte odpověď.
struct AgentsStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Co dělají agenti"
    static var description = IntentDescription("Zeptá se Macu, kdo pracuje, co čeká na tebe a co selhalo.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        guard let (s, at) = try? await Relay.state() else {
            let text = "Mac se mi neozval."
            return .result(value: text, dialog: IntentDialog(stringLiteral: text))
        }
        let text = statusLine(s, pushed: at)
        return .result(value: text, dialog: IntentDialog(stringLiteral: text))
    }
}

/// Agent jako věc, kterou jde ve Zkratkách vybrat ze seznamu.
struct AgentEntity: AppEntity {
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
    static var defaultQuery = AgentQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct AgentQuery: EntityQuery {
    func entities(for ids: [AgentEntity.ID]) async throws -> [AgentEntity] {
        try await all().filter { ids.contains($0.id) }
    }

    func suggestedEntities() async throws -> [AgentEntity] { try await all() }

    private func all() async throws -> [AgentEntity] {
        guard let (s, _) = try? await Relay.state() else { return [] }
        return s.agents.map { AgentEntity(id: $0.id, name: $0.name) }
    }
}

/// „Zadat úkol v aplikaci Wisp“: nadiktuješ ho a Mac ho do deseti vteřin převezme.
struct SendTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Zadat agentovi úkol"
    static var description = IntentDescription("Pošle agentovi nový úkol. Mac ho převezme do deseti vteřin.")
    static var openAppWhenRun = false

    // Oba nepovinné schválně: zkratka pro Siri nesmí mít povinný parametr, jinak
    // ji nejde spustit z dlaždice. Co chybí, na to se zeptá až perform().
    @Parameter(title: "Agent") var agent: AgentEntity?
    @Parameter(title: "Úkol") var task: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Zadat \(\.$agent) úkol \(\.$task)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let known = (try? await AgentQuery().suggestedEntities()) ?? []
        guard !known.isEmpty else { return .result(dialog: "Mac mi neposlal žádné agenty.") }
        let who: AgentEntity
        if let agent {
            who = agent
        } else if known.count == 1 {
            who = known[0]
        } else {
            who = try await $agent.requestDisambiguation(among: known, dialog: "Komu to mám poslat?")
        }
        var text = (task ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            text = try await $task.requestValue("Co má \(who.name) udělat?").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !text.isEmpty else { return .result(dialog: "Nic v tom úkolu nebylo, tak jsem nic neposlal.") }
        try await Relay.send(["kind": "task", "agentId": who.id, "text": text])
        return .result(dialog: IntentDialog(stringLiteral: "Hotovo, \(who.name) se do toho pustí."))
    }
}

/// Věty, kterými to jde spustit. Jméno appky v nich musí být, proto „v aplikaci Wisp“:
/// `\(.applicationName)` doplní první pád, a tahle vazba ho unese i česky.
struct WispShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AgentsStatusIntent(),
            phrases: [
                "Co dělají agenti v aplikaci \(.applicationName)",
                "Jak to vypadá v aplikaci \(.applicationName)",
                "What are my agents doing in \(.applicationName)",
            ],
            shortTitle: "Co dělají agenti",
            systemImageName: "person.2.wave.2"
        )
        AppShortcut(
            intent: SendTaskIntent(),
            phrases: [
                "Zadat úkol v aplikaci \(.applicationName)",
                "Send a task in \(.applicationName)",
            ],
            shortTitle: "Zadat úkol",
            systemImageName: "paperplane"
        )
    }
}
