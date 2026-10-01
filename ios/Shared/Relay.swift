import Foundation

// What the Mac pushes (see src/relay.ts in Wisp) and the commands the phone sends back.

struct RelayEnvelope: Decodable {
    let pushedAt: Double?
    let state: PhoneState?
}

struct PhoneState: Decodable {
    let at: Double
    let focus: Bool?
    let counts: Counts
    let items: [Item]
    let live: [Live]?
    let limits: Limits
    let agents: [Agent]
    let perms: [Perm]?
    let bot: MascotCharacter?
    let answers: [Answer]?
    let groups: [Group]?
    let history: [Event]?
    let prs: [PR]?

    struct Counts: Decodable { let attention: Int; let run: Int; let sleep: Int; let ok: Int; let off: Int }
    struct Item: Decodable, Identifiable {
        let id: String; let name: String; let state: String; let chip: String?; let doing: String; let when: String
        let group: String?; let engine: String?; let character: MascotCharacter?; let job: String?
    }
    struct Answer: Decodable, Identifiable { let id: String; let question: String; let answer: String?; let at: Double }
    struct Live: Decodable { let id: String?; let name: String; let lines: [String]; let character: MascotCharacter? }
    struct Group: Decodable, Identifiable { let id: String; let name: String }
    struct Event: Decodable, Identifiable {
        let id: String; let name: String; let state: String; let at: Double; let text: String
        var key: String { "\(id)-\(at)" }
    }
    struct PR: Decodable, Identifiable {
        let repo: String; let number: Int; let title: String; let author: String; let updatedAt: String; let url: String
        let additions: Int; let deletions: Int; let files: Int; let draft: Bool; let conflict: Bool; let ci: String; let body: String
        var id: String { "\(repo)#\(number)" }
        var repoName: String { repo.split(separator: "/").last.map(String.init) ?? repo }
    }
    struct Limits: Decodable {
        let claude: Claude?
        let gpt: [Window]
        let gemini: [Gemini]
        struct Claude: Decodable { let session: Int?; let week: Int?; let resets: String? }
        struct Window: Decodable { let percent: Int; let windowSecs: Double; let resetsAtMs: Double }
        struct Gemini: Decodable { let group: String; let percent: Int; let windowSecs: Double; let resetsAtMs: Double }
    }
    struct Agent: Decodable, Identifiable, Hashable {
        let id: String; let name: String; let engine: String; let status: String; let issues: [Issue]
        let character: MascotCharacter?
        /** Whether it works on something right now, from its item on the Mac. */
        func state(in s: PhoneState) -> String { s.items.first { $0.id == "agent:\(id)" }?.state ?? (status == "paused" ? "off" : "sleep") }
        static func == (a: Agent, b: Agent) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }
    }
    struct Issue: Decodable, Identifiable, Hashable {
        let id: String; let identifier: String; let title: String; let status: String; let updatedAt: String; let messages: [Message]
        static func == (a: Issue, b: Issue) -> Bool { a.id == b.id && a.messages.count == b.messages.count }
        func hash(into h: inout Hasher) { h.combine(id) }
    }
    struct Message: Decodable, Hashable { let who: String; let body: String; let at: String }
    struct Perm: Decodable, Identifiable { let id: String; let project: String; let tool: String; let detail: String; let rule: String }
}

extension PhoneState {
    /// Gemini's 5 h and weekly windows, and AI Pro's Claude.
    var gemini5h: Int? { limits.gemini.first { $0.group == "Gemini" && $0.windowSecs == 18000 }?.percent }
    var geminiWeek: Int? { limits.gemini.first { $0.group == "Gemini" && $0.windowSecs == 604800 }?.percent }
    var waiting: [Item] { items.filter { ["you", "bad", "new"].contains($0.state) } }
    /// Who is doing or wants something right now: the only ones the crew shows.
    var busy: [Item] { items.filter { ["run", "you", "new", "bad", "done"].contains($0.state) } }
    /// Every conversation with every agent, newest first, with who it belongs to.
    var tasks: [(agent: Agent, issue: Issue)] {
        agents.flatMap { a in a.issues.map { (agent: a, issue: $0) } }.sorted { $0.issue.updatedAt > $1.issue.updatedAt }
    }
    func groupName(_ id: String?) -> String {
        guard let id else { return "Ostatní" }
        return groups?.first { $0.id == id }?.name ?? (id == "mac" ? "Tento Mac" : id == "github" ? "GitHub" : id == "cloudflare" ? "Cloudflare" : "Agenti")
    }
    /// Claude's limit used up (the session or the week).
    var spent: Bool { max(limits.claude?.session ?? 0, limits.claude?.week ?? 0) >= 95 }
    /** The worst state, as the Mac's SEVERITY orders them: the bot's mood. */
    var worst: String {
        for s in ["bad", "you", "new", "run", "done", "ok", "sleep", "off"] where items.contains(where: { $0.state == s }) { return s }
        return "ok"
    }
}

enum Relay {
    static func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: Secrets.relayURL + path)!)
        r.httpMethod = method
        r.setValue("Bearer \(Secrets.relayToken)", forHTTPHeaderField: "authorization")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 15
        if let body { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "content-type") }
        return r
    }

    static func state() async throws -> (PhoneState, Date) {
        let (data, _) = try await URLSession.shared.data(for: request("/state"))
        let env = try JSONDecoder().decode(RelayEnvelope.self, from: data)
        guard let s = env.state else { throw URLError(.zeroByteResource) }
        return (s, Date(timeIntervalSince1970: (env.pushedAt ?? s.at) / 1000))
    }

    static func send(_ cmd: [String: String]) async throws {
        let body = try JSONSerialization.data(withJSONObject: cmd)
        let (_, res) = try await URLSession.shared.data(for: request("/cmd", method: "POST", body: body))
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    }
}

/// "před 2 min", "Mac spí (3 h)".
func agoText(_ date: Date) -> String {
    let s = Int(Date().timeIntervalSince(date))
    if s < 90 { return "právě teď" }
    if s < 3600 { return "před \(s / 60) min" }
    if s < 86400 { return "před \(s / 3600) h" }
    return "před \(s / 86400) d"
}
