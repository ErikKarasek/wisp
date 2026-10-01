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

struct WidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        Group {
            if let s = entry.state {
                switch family {
                case .accessoryCircular: circular(s)
                case .accessoryRectangular: rectangular(s)
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
        .containerBackground(for: .widget) { Color(white: 0.06) }
    }

    private func rings(_ s: PhoneState, size: CGFloat) -> some View {
        HStack(spacing: 6) {
            LimitRing(label: "Claude", color: Palette.claude, inner: s.limits.claude?.session, outer: s.limits.claude?.week, size: size)
            LimitRing(label: "GPT", color: Palette.gpt, inner: s.limits.gpt.first?.percent, size: size)
            LimitRing(label: "Gemini", color: Palette.gemini, inner: s.gemini5h, outer: s.geminiWeek, size: size)
        }
    }

    private func status(_ s: PhoneState) -> (String, Color) {
        if s.waiting.contains(where: { $0.state == "bad" }) { return ("\(s.waiting.count) selhalo nebo čeká", Palette.bad) }
        if !s.waiting.isEmpty { return (s.waiting.count == 1 ? "1 čeká na tebe" : "\(s.waiting.count) čekají na tebe", Palette.amber) }
        if s.counts.run > 0 { return ("\(s.counts.run) pracuje", Palette.accent) }
        return ("V pořádku", Color(red: 0.31, green: 0.75, blue: 0.49))
    }

    private func small(_ s: PhoneState) -> some View {
        let (text, color) = status(s)
        return VStack(alignment: .leading, spacing: 8) {
            rings(s, size: 36)
            HStack(spacing: 6) {
                MascotView(character: s.bot ?? .white, expression: .forState(s.worst), animated: false).frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(text).font(.caption2.weight(.semibold)).foregroundStyle(color).lineLimit(1)
                    if let p = entry.pushed { Text(agoText(p)).font(.system(size: 9)).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private func medium(_ s: PhoneState) -> some View {
        let (text, color) = status(s)
        return HStack(alignment: .top, spacing: 14) {
            rings(s, size: 40)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Circle().fill(color).frame(width: 7, height: 7)
                    Text(text).font(.caption.weight(.semibold)).lineLimit(1)
                }
                ForEach(s.waiting.prefix(3)) { i in
                    Text("• \(i.name)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                if let perms = s.perms, !perms.isEmpty {
                    Text("Claude chce povolit (\(perms.count))").font(.caption2.weight(.semibold)).foregroundStyle(Palette.amber)
                }
                Spacer(minLength: 0)
                if let p = entry.pushed { Text("Mac \(agoText(p))").font(.system(size: 9)).foregroundStyle(.secondary) }
            }
        }
    }

    private func circular(_ s: PhoneState) -> some View {
        Gauge(value: Double(s.limits.claude?.session ?? 0), in: 0...100) { Text("C") } currentValueLabel: {
            Text("\(s.limits.claude?.session ?? 0)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
    }

    private func rectangular(_ s: PhoneState) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(status(s).0).font(.headline).lineLimit(1)
            Text("Claude \(s.limits.claude?.session ?? 0) % · GPT \(s.limits.gpt.first?.percent ?? 0) % · Gem \(s.gemini5h ?? 0) %")
                .font(.caption2).lineLimit(1)
        }
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

// MARK: - The bot: big, glowing by state, with what it does (like the Grok Bot widget)

struct BotWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DispecinkBot", provider: Provider()) { entry in
            BotWidgetView(entry: entry)
        }
        .configurationDisplayName("Bot")
        .description("Tvůj bot z notche: co zrovna dělá, jestli je hotovo, nebo na tebe něco čeká.")
        .supportedFamilies([.systemSmall])
    }
}

struct BotWidgetView: View {
    let entry: Entry
    var body: some View {
        let a = entry.state?.activityState
        let mode = entry.mode
        VStack(spacing: 4) {
            Text(a.map { $0.mode == "working" ? $0.title : "Dispečink" } ?? "Dispečink")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.4)).lineLimit(1)
            BotBadge(character: entry.state?.bot ?? .white, mode: mode, size: 74)
            Group {
                switch mode {
                case "working": StepTicker(steps: Array((a?.steps ?? []).suffix(2)), fallback: a?.title ?? "", big: 10)
                case "done": Label("Hotovo", systemImage: "checkmark.square.fill").font(.system(size: 11, weight: .medium))
                case "error": Text("Něco selhalo").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.bad)
                case "ask": Text(a?.waiting ?? 0 > 1 ? "\(a?.waiting ?? 0) čekají na tebe" : "Čeká na tebe").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.amber)
                default: Text(entry.pushed.map { "Mac \(agoText($0))" } ?? "").font(.system(size: 10)).foregroundStyle(.white.opacity(0.35))
                }
            }
            .frame(height: 26)
        }
        .containerBackground(for: .widget) {
            ZStack {
                Color(white: 0.05)
                LinearGradient(colors: [.clear, modeColor(mode).opacity(mode == "idle" ? 0 : 0.45)], startPoint: .center, endPoint: .bottom)
            }
        }
    }
}

// MARK: - The crew: the agents as coloured pills, or their faces

struct CrewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DispecinkCrew", provider: Provider()) { entry in
            CrewWidgetView(entry: entry)
        }
        .configurationDisplayName("Agenti")
        .description("Tvoji agenti a co dělají, v jejich barvách.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct CrewWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry
    var body: some View {
        let crew = entry.state?.crew ?? []
        let a = entry.state?.activityState
        Group {
            if family == .systemMedium {
                HStack(spacing: 12) {
                    BotBadge(character: entry.state?.bot ?? .white, mode: entry.mode, size: 70)
                        .frame(width: 84, height: 84)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                    CrewGrid(crew: crew, size: 12)
                }
            } else {
                VStack(spacing: 6) {
                    ForEach(crew.prefix(4), id: \.name) { CrewPill(chip: $0, size: 11) }
                }
            }
        }
        .containerBackground(for: .widget) { Color(white: 0.05) }
    }
}

struct DispecinkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Dispecink", provider: Provider()) { WidgetView(entry: $0) }
            .configurationDisplayName("Limity")
            .description("Limity Claude, ChatGPT a Gemini a co na tebe čeká.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}
