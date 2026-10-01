import SwiftUI
import WidgetKit

struct Entry: TimelineEntry {
    let date: Date
    let state: PhoneState?
    let pushed: Date?
    /// The news is too old to say someone works right now.
    var old: Bool { pushed.map { date.timeIntervalSince($0) > 5 * 60 } ?? true }
    /// The bot's mode, settled to idle once the news is old.
    var mode: String { old ? "idle" : (state?.activityState.mode ?? "idle") }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, state: nil, pushed: nil) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let entry = await load()
            // A second entry a few minutes on, where "working" settles to idle if no refresh came.
            let later = Entry(date: .now.addingTimeInterval(6 * 60), state: entry.state, pushed: entry.pushed)
            // iOS decides how often widgets refresh; asking for 15 minutes is the usual budget.
            completion(Timeline(entries: [entry, later], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }

    private func load() async -> Entry {
        if let (s, at) = try? await Relay.state() { return Entry(date: .now, state: s, pushed: at) }
        return Entry(date: .now, state: nil, pushed: nil)
    }
}

// MARK: - Shared pieces

/// The dark card, lit from below in the mode's colour, like the notch.
struct WidgetGlow: View {
    var mode: String
    var body: some View {
        ZStack {
            Color(white: 0.045)
            RadialGradient(colors: [modeColor(mode).opacity(mode == "idle" ? 0.10 : 0.42), .clear],
                           center: .init(x: 0.25, y: 0.35), startRadius: 0, endRadius: 190)
            LinearGradient(colors: [.white.opacity(0.05), .clear], startPoint: .top, endPoint: .center)
        }
    }
}

/// When the Mac last reported, and a button to look again right now.
struct WidgetFooter: View {
    let entry: Entry
    var body: some View {
        HStack(spacing: 6) {
            Text(entry.pushed.map { "Mac \(agoText($0))" } ?? "Bez spojení")
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.38)).lineLimit(1)
            Spacer(minLength: 0)
            Button(intent: RefreshIntent()) {
                Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white.opacity(0.7)).frame(width: 22, height: 22)
                    .background(.white.opacity(0.1), in: Circle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// A limit as a slim bar with its name and number.
struct LimitBar: View {
    let name: String
    let color: Color
    let percent: Int?
    var week: Int? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(name).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                Spacer(minLength: 2)
                Text(percent.map { "\($0) %" } ?? "–").font(.system(size: 11, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle((percent ?? 0) >= 85 ? Palette.bad : .white)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.1))
                    if let week { Capsule().fill(color.opacity(0.35)).frame(width: g.size.width * min(1, Double(week) / 100)) }
                    Capsule().fill(LinearGradient(colors: [color.opacity(0.75), (percent ?? 0) >= 85 ? Palette.bad : color], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(4, g.size.width * min(1, Double(percent ?? 0) / 100)))
                }
            }
            .frame(height: 5)
        }
    }
}

extension Entry {
    var look: MascotCharacter { (old ? nil : state?.focusLook) ?? state?.bot ?? .white }
    var headline: String {
        guard let s = state else { return "Bez spojení" }
        if old { return s.waiting.isEmpty ? "Všechno v pořádku" : "\(s.waiting.count) čeká na tebe" }
        return s.activityState.title
    }
}

private func limitBars(_ s: PhoneState) -> some View {
    VStack(spacing: 7) {
        LimitBar(name: s.limits.claude?.week.map { "Claude · týden \($0) %" } ?? "Claude", color: Palette.claude, percent: s.limits.claude?.session, week: s.limits.claude?.week)
        LimitBar(name: "ChatGPT", color: Palette.gpt, percent: s.limits.gpt.first?.percent)
        LimitBar(name: s.geminiWeek.map { "Gemini · týden \($0) %" } ?? "Gemini", color: Palette.gemini, percent: s.gemini5h, week: s.geminiWeek)
    }
}

// MARK: - The bot: big and glowing, what it does, and on the large one everything

struct BotWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DispecinkBot", provider: Provider()) { BotWidgetView(entry: $0) }
            .configurationDisplayName("Bot")
            .description("Tvůj bot z notche: kdo pracuje a co dělá. Velký widget ukáže všechno najednou.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct BotWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        let mode = entry.mode
        Group {
            switch family {
            case .systemLarge: large
            case .systemMedium: medium
            default: small
            }
        }
        .widgetURL(URL(string: "dispecink://overview"))
        .containerBackground(for: .widget) { WidgetGlow(mode: mode) }
    }

    private var steps: [String] { entry.old ? [] : (entry.state?.activityState.steps ?? []) }

    private var small: some View {
        VStack(spacing: 6) {
            BotBadge(character: entry.look, mode: entry.mode, size: 70)
                .frame(maxWidth: .infinity)
                .padding(.top, 2)
            Text(entry.headline).font(.system(size: 12, weight: .semibold)).multilineTextAlignment(.center).lineLimit(2)
                .minimumScaleFactor(0.85)
            if let last = steps.last {
                Text(last).font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
            } else {
                WidgetFooter(entry: entry)
            }
        }
    }

    private var medium: some View {
        HStack(spacing: 14) {
            BotBadge(character: entry.look, mode: entry.mode, size: 88)
                .frame(width: 96)
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.headline).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                if !steps.isEmpty { StepTicker(steps: Array(steps.suffix(2)), big: 11) }
                if let s = entry.state {
                    HStack(spacing: 10) {
                        LimitRing(label: "Claude", color: Palette.claude, inner: s.limits.claude?.session, outer: s.limits.claude?.week, size: 30).labelsHidden()
                        LimitRing(label: "GPT", color: Palette.gpt, inner: s.limits.gpt.first?.percent, size: 30).labelsHidden()
                        LimitRing(label: "Gemini", color: Palette.gemini, inner: s.gemini5h, outer: s.geminiWeek, size: 30).labelsHidden()
                    }
                }
                Spacer(minLength: 0)
                WidgetFooter(entry: entry)
            }
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                BotBadge(character: entry.look, mode: entry.mode, size: 76).frame(width: 84)
                VStack(alignment: .leading, spacing: 5) {
                    Text(entry.headline).font(.system(size: 16, weight: .semibold)).lineLimit(2)
                    if !steps.isEmpty { StepTicker(steps: Array(steps.suffix(2)), big: 11) }
                    else if let d = entry.state?.activityState.detail, !d.isEmpty, !entry.old {
                        Text(d).font(.system(size: 11)).foregroundStyle(modeColor(entry.mode)).lineLimit(2)
                    }
                }
            }
            if let s = entry.state {
                limitBars(s)
                    .padding(10)
                    .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
                if !s.crew.isEmpty {
                    CrewGrid(crew: s.crew, size: 11, detailed: true)
                }
                HStack(spacing: 8) {
                    chip("\(s.waiting.count)", "čeká", s.waiting.isEmpty ? .white.opacity(0.5) : Palette.amber, url: "dispecink://overview")
                    chip("\(s.counts.run)", "pracuje", Palette.accent, url: "dispecink://agents")
                    chip("\(s.prs?.count ?? 0)", "ke kontrole", (s.prs?.isEmpty ?? true) ? .white.opacity(0.5) : .green, url: "dispecink://reviews")
                }
            }
            Spacer(minLength: 0)
            WidgetFooter(entry: entry)
        }
    }

    private func chip(_ n: String, _ label: String, _ color: Color, url: String) -> some View {
        Link(destination: URL(string: url)!) {
            VStack(spacing: 0) {
                Text(n).font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(color)
                Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(.white.opacity(0.5))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 6)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - The agents: faces, what they do, and a button to wake each

struct CrewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DispecinkCrew", provider: Provider()) { CrewWidgetView(entry: $0) }
            .configurationDisplayName("Agenti")
            .description("Kdo pracuje nebo naposledy něco dělal. Tlačítkem agenta rovnou probudíš.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct CrewWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        let s = entry.state
        Group {
            if let s {
                switch family {
                case .systemSmall: small(s)
                case .systemLarge: list(s, count: 6)
                default: grid(s)
                }
            } else {
                Text("Bez spojení").font(.caption).foregroundStyle(.secondary)
            }
        }
        .widgetURL(URL(string: "dispecink://agents"))
        .containerBackground(for: .widget) { WidgetGlow(mode: entry.mode == "working" ? "working" : "idle") }
    }

    /// The Paperclip agents: busy ones first, then by when they last did something, paused ones last.
    private func people(_ s: PhoneState) -> [(chip: CrewChip, agentId: String?)] {
        let recent = (s.history ?? []).map(\.id)
        func rank(_ a: PhoneState.Agent) -> Int {
            let st = a.state(in: s)
            if ["run", "you", "bad", "new"].contains(st) { return 0 }
            if a.status == "paused" { return 10_000 }
            return 1 + (recent.firstIndex(of: "agent:\(a.id)") ?? 5_000)
        }
        return s.agents.sorted { rank($0) < rank($1) }.map { a in
            let status = s.items.first { $0.id == "agent:\(a.id)" }.map(s.crewStatus) ?? (a.status == "paused" ? "Pozastavený" : "Spí")
            return (CrewChip(name: a.name, status: status, state: a.state(in: s), character: a.character ?? MascotCharacter()), a.id)
        }
    }

    private func small(_ s: PhoneState) -> some View {
        let faces = Array(people(s).prefix(4))
        return VStack(spacing: 8) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(faces, id: \.chip.name) { p in
                    VStack(spacing: 2) {
                        MascotView(character: p.chip.character, expression: .forState(p.chip.state), animated: false)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(stateColor(p.chip.state).opacity(["run", "you", "bad"].contains(p.chip.state) ? 0.28 : 0)).blur(radius: 8))
                        Text(p.chip.name).font(.system(size: 9, weight: .semibold)).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func card(_ p: (chip: CrewChip, agentId: String?), big: Bool) -> some View {
        let c = hexColor(p.chip.character.color)
        return HStack(spacing: 8) {
            MascotView(character: p.chip.character, expression: .forState(p.chip.state), animated: false)
                .frame(width: big ? 34 : 30, height: big ? 34 : 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(p.chip.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(p.chip.status).font(.system(size: 10)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
            }
            Spacer(minLength: 0)
            if let id = p.agentId, p.chip.state != "run" {
                Button(intent: WakeAgentIntent(agentId: id)) {
                    Image(systemName: "bolt.fill").font(.system(size: 10, weight: .bold)).foregroundStyle(c)
                        .frame(width: 24, height: 24).background(c.opacity(0.16), in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(c.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(c.opacity(0.22), lineWidth: 1))
    }

    private func grid(_ s: PhoneState) -> some View {
        let ps = Array(people(s).prefix(4))
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(ps, id: \.chip.name) { card($0, big: false) }
        }
    }

    private func list(_ s: PhoneState, count: Int) -> some View {
        // The large one: every agent, busy and recent ones on top.
        let ps = people(s)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Agenti").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
            ForEach(ps.prefix(count), id: \.chip.name) { card($0, big: true) }
            Spacer(minLength: 0)
            WidgetFooter(entry: entry)
        }
    }
}

// MARK: - Limits: bars on the home screen, gauges on the lock screen

struct DispecinkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Dispecink", provider: Provider()) { WidgetView(entry: $0) }
            .configurationDisplayName("Limity")
            .description("Limity Claude, ChatGPT a Gemini a co na tebe čeká. I na zamčenou obrazovku.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct WidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        Group {
            if let s = entry.state {
                switch family {
                case .accessoryCircular: circular(s)
                case .accessoryRectangular: rectangular(s)
                case .accessoryInline: Text("Claude \(s.limits.claude?.session ?? 0) % · GPT \(s.limits.gpt.first?.percent ?? 0) %")
                case .systemMedium: medium(s)
                default: small(s)
                }
            } else {
                VStack(spacing: 6) {
                    MascotView(character: .white, expression: .sleepy, animated: false).frame(width: 40, height: 40)
                    Text("Bez spojení").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .widgetURL(URL(string: "dispecink://overview"))
        .containerBackground(for: .widget) { WidgetGlow(mode: "idle") }
    }

    private func small(_ s: PhoneState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            limitBars(s)
            Spacer(minLength: 0)
            WidgetFooter(entry: entry)
        }
    }

    private func medium(_ s: PhoneState) -> some View {
        HStack(spacing: 14) {
            HStack(spacing: 10) {
                ring("Claude", Palette.claude, s.limits.claude?.session, s.limits.claude?.week)
                ring("ChatGPT", Palette.gpt, s.limits.gpt.first?.percent, nil)
                ring("Gemini", Palette.gemini, s.gemini5h, s.geminiWeek)
            }
            VStack(alignment: .leading, spacing: 5) {
                if s.waiting.isEmpty && (s.perms ?? []).isEmpty {
                    Label("Nic nečeká", systemImage: "checkmark.circle.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(.green)
                } else {
                    if let p = s.perms, !p.isEmpty {
                        Text("Claude chce povolit (\(p.count))").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.amber).lineLimit(1)
                    }
                    ForEach(s.waiting.prefix(3)) { i in
                        Text(i.name).font(.system(size: 11, weight: .medium)).foregroundStyle(stateColor(i.state)).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                WidgetFooter(entry: entry)
            }
        }
    }

    private func ring(_ name: String, _ color: Color, _ inner: Int?, _ outer: Int?) -> some View {
        LimitRing(label: name, color: color, inner: inner, outer: outer, size: 46)
    }

    private func circular(_ s: PhoneState) -> some View {
        Gauge(value: Double(s.limits.claude?.session ?? 0), in: 0...100) {
            Image(systemName: "sparkle")
        } currentValueLabel: {
            Text("\(s.limits.claude?.session ?? 0)")
        }
        .gaugeStyle(.accessoryCircular)
        .widgetAccentable()
    }

    private func rectangular(_ s: PhoneState) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(entry.headline).font(.system(size: 13, weight: .semibold)).lineLimit(1).widgetAccentable()
            HStack(spacing: 6) {
                mini("C", s.limits.claude?.session)
                mini("G", s.limits.gpt.first?.percent)
                mini("Ge", s.gemini5h)
            }
        }
    }

    private func mini(_ name: String, _ pct: Int?) -> some View {
        Gauge(value: Double(pct ?? 0), in: 0...100) { Text(name) }
            .gaugeStyle(.accessoryLinearCapacity)
            .overlay(alignment: .leading) { Text(name).font(.system(size: 8, weight: .bold)).offset(y: -9) }
    }
}

@main
struct DispecinkWidgets: WidgetBundle {
    var body: some Widget {
        BotWidget()
        CrewWidget()
        DispecinkWidget()
        DispecinkLiveActivity()
    }
}
