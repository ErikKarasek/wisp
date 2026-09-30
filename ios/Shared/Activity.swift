import ActivityKit
import Foundation

/// One agent in the crew row: its face, name and what it is doing, in its colour.
struct CrewChip: Codable, Hashable {
    var name: String
    var status: String
    var state: String
    var character: MascotCharacter
}

/// The Dynamic Island and the lock-screen card, like the Mac's notch.
struct DispecinkActivity: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// working, error, ask, done, idle
        var mode: String
        var title: String
        var detail: String
        /// The last steps of the agent that works, oldest first (up to 3).
        var steps: [String]
        var worst: String
        var waiting: Int
        var perms: Int
        var claude: Int?
        var claudeWeek: Int?
        var gpt: Int?
        var gemini: Int?
        var bot: MascotCharacter?
        var crew: [CrewChip]
        var updated: Date
    }
}

extension PhoneState {
    /// The four agents shown as a crew: Paperclip agents first, then the Antigravity jobs.
    var crew: [CrewChip] {
        let agentItems = items.filter { $0.id.hasPrefix("agent:") }
        let geminiJobs = items.filter { $0.engine == "Gemini" }
        return (agentItems + geminiJobs).prefix(4).map {
            CrewChip(name: $0.name, status: crewStatus($0), state: $0.state, character: $0.character ?? MascotCharacter())
        }
    }

    private func crewStatus(_ i: Item) -> String {
        switch i.state {
        case "run": return i.doing
        case "you": return "Čeká na tebe"
        case "bad": return "Selhal"
        case "done": return "Hotovo"
        case "off": return "Pozastavený"
        case "sleep": return "Spí"
        default: return i.chip ?? "V pořádku"
        }
    }

    var activityState: DispecinkActivity.ContentState {
        var mode = "idle", title = "Všechno v pořádku", detail = "", steps: [String] = []
        if let l = live?.first {
            mode = "working"; title = l.name; steps = Array(l.lines.suffix(3))
        } else if let bad = items.first(where: { $0.state == "bad" }) {
            mode = "error"; title = "\(bad.name) selhal"; detail = bad.doing
        } else if let p = perms?.first {
            mode = "ask"; title = "\(p.project) · Claude chce povolit"; detail = p.detail
        } else if let w = waiting.first {
            mode = "ask"; title = "\(w.name) na tebe čeká"; detail = w.doing
        } else if let d = items.first(where: { $0.state == "done" }) {
            mode = "done"; title = "\(d.name): hotovo"; detail = d.doing
        } else if counts.run > 0 {
            mode = "working"; title = "\(counts.run) pracuje"
        }
        return .init(mode: mode, title: title, detail: detail, steps: steps, worst: worst,
                     waiting: waiting.count, perms: perms?.count ?? 0,
                     claude: limits.claude?.session, claudeWeek: limits.claude?.week,
                     gpt: limits.gpt.first?.percent, gemini: gemini5h, bot: bot, crew: crew, updated: Date())
    }
}
