import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            OverviewView().tabItem { Label("Přehled", systemImage: "gauge.with.dots.needle.33percent") }
            AgentsView().tabItem { Label("Agenti", systemImage: "bubble.left.and.bubble.right") }
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
                        if let live = s.live, !live.isEmpty {
                            section("Právě pracuje") {
                                ForEach(live, id: \.name) { l in
                                    card {
                                        Text(l.name).font(.subheadline.weight(.semibold))
                                        ForEach(Array(l.lines.suffix(3).enumerated()), id: \.offset) { _, line in
                                            Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                    }
                                }
                            }
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

    private var header: some View {
        HStack(spacing: 12) {
            let s = store.state
            Mascot(color: s.map { stateColor($0.waiting.contains { $0.state == "bad" } ? "bad" : $0.waiting.isEmpty ? "ok" : "you") } ?? Palette.accent,
                   size: 46, sleepy: store.macAsleep)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline).font(.headline)
                Text(subline).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private var headline: String {
        guard let s = store.state else { return "Načítám…" }
        if s.counts.attention > 0 { return s.counts.attention == 1 ? "1 věc na tebe čeká" : "\(s.counts.attention) věci na tebe čekají" }
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
    let item: PhoneState.Item
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(stateColor(item.state)).frame(width: 9, height: 9).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(item.name).font(.subheadline.weight(.semibold))
                    Spacer()
                    if let chip = item.chip { Text(chip).font(.caption2).foregroundStyle(.secondary) }
                }
                Text(item.doing).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 4)
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
                        Mascot(color: a.engine == "ChatGPT" ? Palette.gpt : Palette.claude, size: 34, sleepy: a.status == "paused")
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
