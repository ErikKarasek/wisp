import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            OverviewView().tabItem { Label("Přehled", systemImage: "gauge.with.dots.needle.33percent") }
            AgentsView().tabItem { Label("Agenti", systemImage: "bubble.left.and.bubble.right") }
            AskView().tabItem { Label("Zeptat se", systemImage: "sparkles") }
        }
        .tint(Palette.accent)
    }
}

// MARK: - Overview

struct OverviewView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if let s = store.state {
                        limits(s)
                        if let perms = s.perms, !perms.isEmpty {
                            section("Claude chce povolit") { ForEach(perms) { PermCard(perm: $0) } }
                        }
                        section(s.waiting.isEmpty ? "Nic na tebe nečeká" : "Čeká na tebe") {
                            ForEach(s.waiting) { ItemRow(item: $0) }
                        }
                        section("Ostatní") {
                            ForEach(s.items.filter { !["you", "bad", "new"].contains($0.state) }) { ItemRow(item: $0) }
                        }
                    } else if let e = store.error {
                        Text(e).foregroundStyle(.secondary)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(16)
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Dispečink")
        }
    }

    /// The hero card, like the notch: the live bot, its steps or the crew.
    private var header: some View {
        let a = store.state?.activityState
        let mode = store.macAsleep ? "idle" : (a?.mode ?? "idle")
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                BotBadge(character: store.state?.bot ?? .white, mode: mode, size: 70, animated: true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(headline).font(.headline)
                    if let a, a.mode == "working" { StepTicker(steps: a.steps, fallback: a.title, big: 14) }
                    else if let a, a.mode == "error" || a.mode == "ask" { Text(a.detail).font(.caption).foregroundStyle(modeColor(a.mode)).lineLimit(2) }
                    Text(subline).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if let crew = store.state?.crew, !crew.isEmpty { CrewGrid(crew: crew, size: 12) }
        }
        .padding(14)
        .background(ActivityGlow(mode: mode).clipShape(RoundedRectangle(cornerRadius: 20)))
    }

    private var headline: String {
        guard let s = store.state else { return "Načítám…" }
        if s.counts.attention > 0 { return s.counts.attention == 1 ? "1 věc na tebe čeká" : "\(s.counts.attention) věci na tebe čekají" }
        if let p = s.perms?.first { return "\(p.project) · Claude chce povolit" }
        if let l = s.live?.first { return "\(l.name) pracuje" }
        if s.counts.run > 0 { return "\(s.counts.run) pracuje" }
        return "Všechno v pořádku"
    }

    private var subline: String {
        guard let at = store.pushed else { return "" }
        let focus = store.state?.focus == true ? " · soustředění" : ""
        return store.macAsleep ? "Mac spí, poslední stav \(agoText(at))\(focus)" : "Mac hlásil \(agoText(at))\(focus)"
    }

    private func limits(_ s: PhoneState) -> some View {
        HStack {
            LimitRing(label: "Claude", color: Palette.claude, inner: s.limits.claude?.session, outer: s.limits.claude?.week)
            Spacer()
            LimitRing(label: "ChatGPT", color: Palette.gpt, inner: s.limits.gpt.first?.percent)
            Spacer()
            LimitRing(label: "Gemini", color: Palette.gemini, inner: s.gemini5h, outer: s.geminiWeek)
        }
        .padding(16)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    }
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
    var body: some View {
        NavigationStack {
            List(store.state?.agents ?? []) { a in
                NavigationLink(value: a) {
                    HStack(spacing: 12) {
                        MascotView(character: a.character ?? MascotCharacter(), expression: .forState(store.state.map { a.state(in: $0) } ?? "ok"), seed: Double(a.name.count))
                            .frame(width: 44, height: 44)
                        VStack(alignment: .leading) {
                            Text(a.name).font(.headline)
                            Text("\(a.engine)\(a.status == "paused" ? " · pozastavený" : "")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationDestination(for: PhoneState.Agent.self) { AgentView(agentId: $0.id) }
            .refreshable { await store.refresh() }
            .navigationTitle("Agenti")
        }
    }
}

struct AgentView: View {
    @EnvironmentObject var store: Store
    let agentId: String
    @State private var draft = ""
    @State private var sent = false

    var agent: PhoneState.Agent? { store.state?.agents.first { $0.id == agentId } }

    var body: some View {
        List {
            Section("Nový úkol") {
                TextField("Co má \(agent?.name ?? "agent") udělat?", text: $draft, axis: .vertical).lineLimit(2...6)
                Button(sent ? "Zadáno, agent se probudí" : "Zadat") {
                    Task {
                        if await store.send(["kind": "task", "agentId": agentId, "text": draft]) {
                            draft = ""; sent = true
                        }
                    }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.sending)
            }
            Section("Konverzace") {
                ForEach(agent?.issues ?? []) { i in
                    NavigationLink(value: i) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(i.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                            Text("\(i.identifier) · \(statusText(i.status))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationDestination(for: PhoneState.Issue.self) { ThreadView(agentId: agentId, issueId: $0.id) }
        .refreshable { await store.refresh() }
        .navigationTitle(agent?.name ?? "Agent")
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
