import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        TabView {
            OverviewView().tabItem { Label("Přehled", systemImage: "gauge.with.dots.needle.33percent") }
                .badge((store.state?.waiting.count ?? 0) + (store.state?.perms?.count ?? 0))
            AgentsView().tabItem { Label("Agenti", systemImage: "person.2.wave.2") }
            TasksView().tabItem { Label("Úkoly", systemImage: "checklist") }
                .badge(store.state?.tasks.filter { $0.issue.status == "blocked" }.count ?? 0)
            ReviewsView().tabItem { Label("Kontrola", systemImage: "arrow.triangle.pull") }
                .badge(store.state?.prs?.count ?? 0)
            AskView().tabItem { Label("Zeptat se", systemImage: "sparkles") }
        }
        .tint(Palette.accent)
    }
}

// MARK: - Overview

/// What the overview filters by, like the Mac's sidebar.
enum Filter: String, CaseIterable, Identifiable {
    case all = "Vše", run = "Pracuje", attention = "Čeká", sleep = "Spí", off = "Vypnuto"
    var id: String { rawValue }
    func matches(_ s: String) -> Bool {
        switch self {
        case .all: return true
        case .run: return s == "run"
        case .attention: return ["you", "new", "bad"].contains(s)
        case .sleep: return ["sleep", "ok", "done"].contains(s)
        case .off: return s == "off"
        }
    }
}

struct OverviewView: View {
    @EnvironmentObject var store: Store
    @State private var filter: Filter = .all

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HeroCard()
                    if let s = store.state {
                        if let perms = s.perms, !perms.isEmpty {
                            section("Claude chce povolit") { ForEach(perms) { PermCard(perm: $0) } }
                        }
                        LimitsCard(s: s)
                        if !s.waiting.isEmpty {
                            section("Čeká na tebe") { panel { ForEach(s.waiting) { ItemRow(item: $0) } } }
                        }
                        filters(s)
                        ForEach(groups(s), id: \.0) { name, items in
                            section("\(name) · \(items.count)") { panel { ForEach(items) { ItemRow(item: $0) } } }
                        }
                        if let h = s.history, !h.isEmpty {
                            section("Naposledy") {
                                panel {
                                    ForEach(h.prefix(6), id: \.key) { HistoryRow(e: $0) }
                                    NavigationLink { HistoryView() } label: {
                                        Text("Celá historie").font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .padding(.top, 4)
                                }
                            }
                        }
                    } else if let e = store.error {
                        Text(e).foregroundStyle(.secondary)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(16)
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: filter)
            }
            .background(Color.black)
            .refreshable { await store.refresh() }
            .navigationTitle("Dispečink")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { HelpButton() } }
        }
    }

    private func filters(_ s: PhoneState) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Filter.allCases) { f in
                    let n = s.items.filter { f.matches($0.state) }.count
                    Button {
                        Haptic.tap()
                        filter = f
                    } label: {
                        HStack(spacing: 5) {
                            Text(f.rawValue)
                            Text("\(n)").foregroundStyle(filter == f ? .black.opacity(0.6) : .secondary)
                        }
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(filter == f ? Color.white : Palette.card, in: Capsule())
                        .foregroundStyle(filter == f ? .black : .white)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// The items by where they run, in the Mac's order; waiting ones are above already.
    private func groups(_ s: PhoneState) -> [(String, [PhoneState.Item])] {
        let shown = s.items.filter { filter.matches($0.state) && (filter == .attention || !["you", "new", "bad"].contains($0.state)) }
        var order: [String] = (s.groups ?? []).map(\.id)
        for i in shown where !order.contains(i.group ?? "") { order.append(i.group ?? "") }
        return order.compactMap { id in
            let items = shown.filter { ($0.group ?? "") == id }
            return items.isEmpty ? nil : (s.groupName(id.isEmpty ? nil : id), items)
        }
    }
}

/// The three subscriptions' limits, with when they reset.
struct LimitsCard: View {
    let s: PhoneState
    var body: some View {
        HStack(alignment: .top) {
            ring("Claude", Palette.claude, s.limits.claude?.session, s.limits.claude?.week, s.limits.claude?.resets.flatMap(claudeReset))
            Spacer()
            ring("ChatGPT", Palette.gpt, s.limits.gpt.first?.percent, nil, s.limits.gpt.first.map { resetIn($0.resetsAtMs) })
            Spacer()
            ring("Gemini", Palette.gemini, s.gemini5h, s.geminiWeek, s.limits.gemini.first { $0.group == "Gemini" && $0.windowSecs == 18000 }.map { resetIn($0.resetsAtMs) })
        }
        .padding(16)
        .background(Color(white: 0.06), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(.white.opacity(0.07), lineWidth: 1))
    }

    private func ring(_ name: String, _ c: Color, _ inner: Int?, _ outer: Int?, _ reset: String?) -> some View {
        VStack(spacing: 4) {
            LimitRing(label: name, color: c, inner: inner, outer: outer, size: 58)
            Text(reset ?? " ").font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
        }
        .frame(maxWidth: 100)
    }

    /// Claude says when it resets in English ("Oct 1 at 5pm (Europe/Prague)"): just the time, in Czech.
    private func claudeReset(_ text: String) -> String? {
        guard let m = text.range(of: #"(\d{1,2})(?::(\d{2}))?\s*(am|pm)"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        let part = text[m].lowercased()
        let digits = part.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        guard var h = digits.first else { return nil }
        if part.hasSuffix("pm") && h < 12 { h += 12 }
        if part.hasSuffix("am") && h == 12 { h = 0 }
        return "obnoví v \(h):\(String(format: "%02d", digits.count > 1 ? digits[1] : 0))"
    }

    private func resetIn(_ ms: Double) -> String {
        let s = ms / 1000 - Date().timeIntervalSince1970
        if s <= 0 { return "obnoveno" }
        if s < 3600 { return "obnoví za \(Int(s / 60)) min" }
        if s < 86400 { return "obnoví za \(Int(s / 3600)) h" }
        return "obnoví za \(Int(s / 86400)) d"
    }
}

struct HistoryRow: View {
    let e: PhoneState.Event
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(stateColor(e.state)).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text(e.name).font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(agoText(Date(timeIntervalSince1970: e.at / 1000))).font(.caption2).foregroundStyle(.tertiary)
                }
                Text(e.text.isEmpty ? stateText(e.state) : e.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        List(store.state?.history ?? [], id: \.key) { HistoryRow(e: $0) }
            .navigationTitle("Historie")
            .refreshable { await store.refresh() }
    }
}

func stateText(_ s: String) -> String {
    ["run": "Pracuje", "you": "Čeká na tebe", "new": "Něco našel", "bad": "Selhal", "done": "Hotovo", "ok": "V pořádku", "sleep": "Spí", "off": "Vypnuto"][s] ?? s
}

/// A dark card for a list, like the notch's.
func panel<C: View>(@ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 10) { content() }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(white: 0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(.white.opacity(0.07), lineWidth: 1))
}

struct ItemRow: View {
    @EnvironmentObject var store: Store
    let item: PhoneState.Item
    @State private var sheet = false
    var body: some View {
        Button { sheet = true } label: { row }
            .buttonStyle(.plain)
            .sheet(isPresented: $sheet) { ItemSheet(item: item).environmentObject(store).presentationDetents([.medium]) }
    }
    private var row: some View {
        HStack(alignment: .center, spacing: 10) {
            MascotView(character: item.character ?? MascotCharacter(), expression: .forState(item.state), seed: Double(item.name.count))
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(item.name).font(.subheadline.weight(.semibold))
                    Spacer()
                    if let chip = item.chip { Text(chip).font(.caption2).foregroundStyle(.secondary) }
                }
                Text(item.doing).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// An item's details and what the phone can do with it.
struct ItemSheet: View {
    @EnvironmentObject var store: Store
    let item: PhoneState.Item
    @State private var done: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                MascotView(character: item.character ?? MascotCharacter(), expression: .forState(item.state), seed: 7).frame(width: 72, height: 72)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.name).font(.title3.weight(.semibold))
                    Text(item.chip ?? "").font(.subheadline).foregroundStyle(stateColor(item.state))
                    if let e = item.engine { Text(e).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Text(item.doing).font(.callout)
            if !item.when.isEmpty { Text(item.when).font(.caption).foregroundStyle(.secondary) }
            if let label = item.job {
                HStack {
                    act("Spustit teď", ["kind": "job", "label": label, "action": "run"])
                    if item.state == "off" { act("Zapnout", ["kind": "job", "label": label, "action": "resume"]) }
                    else { act("Pozastavit", ["kind": "job", "label": label, "action": "pause"]) }
                }
            } else if item.id.hasPrefix("agent:") {
                let id = String(item.id.dropFirst(6))
                HStack {
                    act("Probudit", ["kind": "agent", "agentId": id, "action": "agentInvoke"])
                    if item.state == "off" { act("Obnovit", ["kind": "agent", "agentId": id, "action": "agentResume"]) }
                    else { act("Pozastavit", ["kind": "agent", "agentId": id, "action": "agentPause"]) }
                }
            }
            if let done { Text(done).font(.caption).foregroundStyle(.secondary) }
            Spacer()
        }
        .padding(20)
    }

    private func act(_ title: String, _ cmd: [String: String]) -> some View {
        Button(title) {
            Task { if await store.send(cmd) { done = "Odesláno, Mac to udělá do 10 s." } }
        }
        .buttonStyle(.borderedProminent).tint(Palette.accent)
    }
}

struct PermCard: View {
    @EnvironmentObject var store: Store
    let perm: PhoneState.Perm
    @State private var answered: String?

    var body: some View {
        card {
            Text("\(perm.project) · \(perm.tool)").font(.caption.weight(.semibold)).foregroundStyle(Palette.amber)
            Text(perm.detail).font(.caption.monospaced()).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            if let answered {
                Text(answered).font(.caption).foregroundStyle(.secondary)
            } else {
                HStack {
                    button("Zamítnout", "deny", .red)
                    button("Terminál", "terminal", .gray)
                    button("Vždy", "always", Palette.accent)
                    button("Povolit", "allow", .green)
                }
            }
        }
    }

    private func button(_ title: String, _ answer: String, _ color: Color) -> some View {
        Button(title) {
            Task {
                if await store.send(["kind": "perm", "permId": perm.id, "answer": answer]) {
                    answered = "Odesláno: \(title.lowercased()). Mac to převezme do 10 s."
                }
            }
        }
        .buttonStyle(.bordered).tint(color).font(.caption.weight(.semibold))
    }
}

// MARK: - Agents and chat

struct AgentsView: View {
    @EnvironmentObject var store: Store
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: cols, spacing: 12) {
                    ForEach(store.state?.agents ?? []) { a in
                        NavigationLink(value: a) { AgentCard(agent: a) }.buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
            .background(Color.black)
            .navigationDestination(for: PhoneState.Agent.self) { AgentView(agentId: $0.id) }
            .refreshable { await store.refresh() }
            .navigationTitle("Agenti")
        }
    }
}

struct AgentCard: View {
    @EnvironmentObject var store: Store
    let agent: PhoneState.Agent
    var body: some View {
        let state = store.state.map { agent.state(in: $0) } ?? "ok"
        let c = hexColor(agent.character?.color ?? "#8b9cff")
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                MascotView(character: agent.character ?? MascotCharacter(), expression: .forState(state), seed: Double(agent.name.count))
                    .frame(width: 58, height: 58)
                Spacer()
                Text(stateText(state)).font(.caption2.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3)
                    .background(stateColor(state).opacity(0.18), in: Capsule()).foregroundStyle(stateColor(state))
            }
            Text(agent.name).font(.headline)
            Text(agent.engine + (agent.status == "paused" ? " · pozastavený" : "")).font(.caption).foregroundStyle(.secondary)
            Text(agent.issues.first?.title ?? "Zatím žádný úkol").font(.caption2).foregroundStyle(.tertiary).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(minHeight: 190, alignment: .top)
        .background(
            ZStack {
                Color(white: 0.06)
                RadialGradient(colors: [c.opacity(state == "run" ? 0.35 : 0.14), .clear], center: .topLeading, startRadius: 0, endRadius: 160)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(c.opacity(0.22), lineWidth: 1))
    }
}

struct AgentView: View {
    @EnvironmentObject var store: Store
    let agentId: String
    @State private var draft = ""
    @State private var sent: String?

    var agent: PhoneState.Agent? { store.state?.agents.first { $0.id == agentId } }

    var body: some View {
        let state = agent.flatMap { a in store.state.map { a.state(in: $0) } } ?? "ok"
        let live = store.state?.live?.first { $0.id == "agent:\(agentId)" }
        List {
            Section {
                HStack(spacing: 16) {
                    MascotView(character: agent?.character ?? MascotCharacter(), expression: .forState(state), seed: 3)
                        .frame(width: 84, height: 84)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(stateText(state)).font(.subheadline.weight(.semibold)).foregroundStyle(stateColor(state))
                        Text(agent?.engine ?? "").font(.caption).foregroundStyle(.secondary)
                        if let live { LiveTicker(steps: live.lines, size: 13) }
                    }
                }
                .padding(.vertical, 6)
                HStack {
                    action("Probudit", "bolt.fill", ["kind": "agent", "agentId": agentId, "action": "agentInvoke"])
                    if agent?.status == "paused" { action("Obnovit", "play.fill", ["kind": "agent", "agentId": agentId, "action": "agentResume"]) }
                    else { action("Pozastavit", "pause.fill", ["kind": "agent", "agentId": agentId, "action": "agentPause"]) }
                }
                if let sent { Text(sent).font(.caption).foregroundStyle(.secondary) }
            }
            Section("Nový úkol") {
                TextField("Co má \(agent?.name ?? "agent") udělat?", text: $draft, axis: .vertical).lineLimit(2...6)
                Button("Zadat") {
                    Task {
                        if await store.send(["kind": "task", "agentId": agentId, "text": draft]) {
                            draft = ""; sent = "Zadáno, agent se do 10 s probudí."; Haptic.success()
                        }
                    }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.sending)
            }
            Section("Konverzace") {
                if (agent?.issues ?? []).isEmpty { Text("Zatím nic.").foregroundStyle(.secondary) }
                ForEach(agent?.issues ?? []) { i in
                    NavigationLink(value: i) { TaskRow(issue: i, agent: nil) }
                }
            }
        }
        .navigationDestination(for: PhoneState.Issue.self) { ThreadView(agentId: agentId, issueId: $0.id) }
        .refreshable { await store.refresh() }
        .navigationTitle(agent?.name ?? "Agent")
    }

    private func action(_ title: String, _ icon: String, _ cmd: [String: String]) -> some View {
        Button {
            Task { if await store.send(cmd) { sent = "Odesláno, Mac to udělá do 10 s."; Haptic.success() } }
        } label: { Label(title, systemImage: icon).frame(maxWidth: .infinity) }
        .buttonStyle(.bordered).tint(Palette.accent)
    }
}

// MARK: - Tasks: every conversation with every agent

struct TaskRow: View {
    let issue: PhoneState.Issue
    let agent: PhoneState.Agent?
    var body: some View {
        HStack(spacing: 10) {
            if let agent {
                MascotView(character: agent.character ?? MascotCharacter(), expression: .forState(issue.status == "blocked" ? "you" : issue.status == "in_progress" ? "run" : "ok"), animated: false)
                    .frame(width: 34, height: 34)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(issue.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text([issue.identifier, agent?.name, statusText(issue.status)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(issue.status == "blocked" ? Palette.amber : .secondary)
            }
        }
    }
}

struct TasksView: View {
    @EnvironmentObject var store: Store
    enum Kind: String, CaseIterable, Identifiable {
        case you = "Na tebe", work = "Běží", review = "Kontrola", done = "Hotové"
        var id: String { rawValue }
        var statuses: [String] {
            switch self {
            case .you: return ["blocked"]
            case .work: return ["todo", "in_progress", "backlog"]
            case .review: return ["in_review"]
            case .done: return ["done", "cancelled"]
            }
        }
    }
    @State private var kind: Kind = .you
    @State private var newTask = false

    var body: some View {
        NavigationStack {
            let all = store.state?.tasks ?? []
            List {
                let shown = all.filter { kind.statuses.contains($0.issue.status) }
                if shown.isEmpty {
                    Text(kind == .you ? "Nic na tebe nečeká." : "Nic tu není.").foregroundStyle(.secondary)
                }
                ForEach(shown, id: \.issue.id) { t in
                    NavigationLink { ThreadView(agentId: t.agent.id, issueId: t.issue.id) } label: { TaskRow(issue: t.issue, agent: t.agent) }
                }
            }
            .animation(.default, value: kind)
            .safeAreaInset(edge: .top) {
                Picker("", selection: $kind) {
                    ForEach(Kind.allCases) { k in Text("\(k.rawValue) \(all.filter { k.statuses.contains($0.issue.status) }.count)").tag(k) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.bottom, 6)
            }
            .onAppear {
                // Open where there is something, the most urgent first.
                if !all.contains(where: { kind.statuses.contains($0.issue.status) }),
                   let k = Kind.allCases.first(where: { k in all.contains { k.statuses.contains($0.issue.status) } }) { kind = k }
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Úkoly")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { newTask = true } label: { Image(systemName: "plus.circle.fill") }
                }
            }
            .sheet(isPresented: $newTask) { NewTaskSheet().environmentObject(store).presentationDetents([.medium, .large]) }
        }
    }
}

struct NewTaskSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var agentId = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("Agent", selection: $agentId) {
                    ForEach((store.state?.agents ?? []).filter { $0.status != "paused" }) { a in Text(a.name).tag(a.id) }
                }
                Section("Co má udělat") {
                    TextField("První věta je název úkolu", text: $text, axis: .vertical).lineLimit(4...10)
                }
            }
            .navigationTitle("Nový úkol")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Zrušit") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zadat") {
                        Task {
                            if await store.send(["kind": "task", "agentId": agentId, "text": text]) { Haptic.success(); dismiss() }
                        }
                    }
                    .disabled(agentId.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.sending)
                }
            }
            .onAppear { if agentId.isEmpty { agentId = store.state?.agents.first { $0.status != "paused" }?.id ?? "" } }
        }
    }
}

// MARK: - Pull requests waiting for Erik

struct ReviewsView: View {
    @EnvironmentObject var store: Store
    @State private var open: PhoneState.PR?

    var body: some View {
        NavigationStack {
            List {
                let prs = store.state?.prs ?? []
                if prs.isEmpty { Text("Nic ke kontrole.").foregroundStyle(.secondary) }
                ForEach(prs) { pr in
                    Button { open = pr } label: { PRRow(pr: pr) }.buttonStyle(.plain)
                }
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Ke kontrole")
            .sheet(item: $open) { PRSheet(pr: $0).environmentObject(store).presentationDetents([.medium, .large]) }
        }
    }
}

func ciBadge(_ ci: String) -> (String, Color) {
    switch ci {
    case "ok": return ("zelená", .green)
    case "bad": return ("červená", Palette.bad)
    case "run": return ("CI běží", Palette.accent)
    default: return ("bez kontrol", .gray)
    }
}

struct PRRow: View {
    let pr: PhoneState.PR
    var body: some View {
        let ci = ciBadge(pr.ci)
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("\(pr.repoName) #\(pr.number)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(ci.0).font(.caption2.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 2)
                    .background(ci.1.opacity(0.18), in: Capsule()).foregroundStyle(ci.1)
            }
            Text(pr.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            HStack(spacing: 10) {
                Text("+\(pr.additions)").foregroundStyle(.green)
                Text("−\(pr.deletions)").foregroundStyle(Palette.bad)
                Text("\(pr.files) souborů").foregroundStyle(.secondary)
                if pr.draft { Text("koncept").foregroundStyle(.secondary) }
                if pr.conflict { Text("konflikt").foregroundStyle(Palette.amber) }
            }
            .font(.caption.monospacedDigit())
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

struct PRSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let pr: PhoneState.PR
    @State private var confirm: String?
    @State private var done: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    PRRow(pr: pr)
                    Text("od \(pr.author)").font(.caption).foregroundStyle(.secondary)
                    if !pr.body.isEmpty {
                        Text(LocalizedStringKey(pr.body)).font(.callout).padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
                    }
                    if let done {
                        Label(done, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.subheadline)
                    } else {
                        Button { confirm = "merge" } label: { Label("Mergnout do main", systemImage: "arrow.triangle.merge").frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).tint(.green).disabled(pr.draft || pr.conflict || store.sending)
                        Button { confirm = "close" } label: { Text("Zavřít bez mergnutí").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered).tint(Palette.bad).disabled(store.sending)
                    }
                    if let url = URL(string: pr.url) {
                        Link(destination: url) { Label("Otevřít na GitHubu", systemImage: "safari").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                    }
                }
                .padding(18)
            }
            .navigationTitle("PR #\(pr.number)")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(confirm == "merge" ? (pr.ci == "ok" ? "Mergnout do main?" : "CI není zelená. Mergnout i tak?") : "Zavřít bez mergnutí?",
                                isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
                Button(confirm == "merge" ? "Mergnout" : "Zavřít", role: confirm == "close" ? .destructive : nil) {
                    let action = confirm ?? ""
                    Task {
                        if await store.send(["kind": "pr", "repo": pr.repo, "number": String(pr.number), "action": action]) {
                            done = action == "merge" ? "Posláno, Mac to do 10 s mergne." : "Posláno, Mac ho do 10 s zavře."
                            Haptic.success()
                        }
                    }
                }
            }
        }
    }
}

struct ThreadView: View {
    @EnvironmentObject var store: Store
    let agentId: String
    let issueId: String
    @State private var draft = ""
    @State private var pending: [String] = []

    var issue: PhoneState.Issue? { store.state?.agents.first { $0.id == agentId }?.issues.first { $0.id == issueId } }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(Array((issue?.messages ?? []).enumerated()), id: \.offset) { n, m in
                            Bubble(text: m.body, mine: m.who == "me", system: m.who == "sys").id(n)
                        }
                        ForEach(pending, id: \.self) { Bubble(text: $0, mine: true, system: false).opacity(0.6) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(12)
                }
                .onAppear { proxy.scrollTo("end") }
                .onChange(of: issue?.messages.count) { _, _ in pending = []; proxy.scrollTo("end") }
            }
            HStack(alignment: .bottom) {
                TextField("Napiš…", text: $draft, axis: .vertical).lineLimit(1...5)
                    .padding(10).background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                Button {
                    let text = draft
                    Task {
                        if await store.send(["kind": "comment", "issueId": issueId, "text": text]) {
                            pending.append(text); draft = ""
                        }
                    }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.sending)
            }
            .padding(10)
        }
        .navigationTitle(issue?.identifier ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }
}

struct Bubble: View {
    let text: String
    let mine: Bool
    let system: Bool
    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            Text(LocalizedStringKey(text))
                .font(system ? .caption : .callout)
                .foregroundStyle(system ? .secondary : .primary)
                .padding(10)
                .background(system ? Color.clear : (mine ? Palette.accent.opacity(0.28) : Palette.card), in: RoundedRectangle(cornerRadius: 14))
            if !mine { Spacer(minLength: 40) }
        }
    }
}

func statusText(_ s: String) -> String {
    ["todo": "čeká na agenta", "in_progress": "pracuje na tom", "in_review": "ke kontrole", "blocked": "čeká na tebe", "done": "hotovo", "cancelled": "zrušené", "backlog": "zásobník"][s] ?? s
}

// MARK: - helpers

func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        content()
    }
}

func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 6) { content() }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
}


// MARK: - Quick question (Gemini on the Mac, from Google AI Pro)

struct AskView: View {
    @EnvironmentObject var store: Store
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if (store.state?.answers ?? []).isEmpty {
                            Text("Zeptej se na cokoli. Otázku převezme Mac a odpoví Gemini z tvého AI Pro.")
                                .font(.callout).foregroundStyle(.secondary).padding(.top, 8)
                        }
                        ForEach(store.state?.answers ?? []) { a in
                            Bubble(text: a.question, mine: true, system: false)
                            if let answer = a.answer { Bubble(text: answer, mine: false, system: false) }
                            else { HStack { ProgressView(); Text("Gemini přemýšlí…").font(.caption).foregroundStyle(.secondary) } }
                        }
                    }
                    .padding(14)
                }
                HStack(alignment: .bottom) {
                    TextField("Na co se chceš zeptat?", text: $draft, axis: .vertical).lineLimit(1...5)
                        .padding(10).background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                    Button {
                        let q = draft
                        Task {
                            if await store.send(["kind": "ask", "askId": UUID().uuidString, "question": q]) {
                                draft = ""
                                // The answer takes a few seconds on the Mac; look a few times.
                                for delay in [12, 10, 10, 15] {
                                    try? await Task.sleep(for: .seconds(delay))
                                    await store.refresh()
                                }
                            }
                        }
                    } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.sending)
                }
                .padding(10)
            }
            .navigationTitle("Zeptat se")
            .refreshable { await store.refresh() }
        }
    }
}


// MARK: - How to use it

struct HelpButton: View {
    @State private var open = false
    var body: some View {
        Button { open = true } label: { Image(systemName: "questionmark.circle") }
            .sheet(isPresented: $open) { HelpSheet().presentationDetents([.large]) }
    }
}

struct HelpSheet: View {
    private let rows: [(String, String)] = [
        ("Přehled", "Bot nahoře ukazuje, co se děje. Klepnutím na úlohu nebo agenta ho spustíš, pozastavíš nebo probudíš."),
        ("Agenti", "Vyber agenta, zadej mu nový úkol, nebo odpověz v konverzaci. Agent se hned probudí."),
        ("Zeptat se", "Otázka pro Gemini z tvého AI Pro; odpoví přes Mac."),
        ("Povolování", "Když Claude Code na Macu chce něco spustit, objeví se tu i na zamčené obrazovce Povolit / Vždy / Zamítnout."),
        ("Dynamic Island a widgety", "Ostrov ukazuje bota a co dělá. Widgety Bot, Agenti a Limity přidáš podržením plochy → +. Obnovují se, když appku otevřeš, jinak zhruba po 15–30 minutách."),
        ("Telegram", "Botovi Dispečinku napiš „Watcher: …“ a agent dostane úkol. Odpovědí na zprávu agenta mu odpovíš. /stav, /agenti, /limity, /pomoc."),
        ("Job-mail bot", "Pošli odkaz na nabídku a založí kartu. /board, /prehled."),
    ]
    var body: some View {
        NavigationStack {
            List(rows, id: \.0) { r in
                VStack(alignment: .leading, spacing: 4) {
                    Text(r.0).font(.headline)
                    Text(r.1).font(.callout).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            .navigationTitle("Jak to ovládat")
        }
    }
}
