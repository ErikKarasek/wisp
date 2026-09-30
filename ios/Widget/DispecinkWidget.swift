import SwiftUI
import WidgetKit

struct Entry: TimelineEntry {
    let date: Date
    let state: PhoneState?
    let pushed: Date?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, state: nil, pushed: nil) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let entry = await load()
            // iOS decides how often widgets refresh; asking for 15 minutes is the usual budget.
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
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
                    Mascot(size: 34, sleepy: true)
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
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(text).font(.caption2.weight(.semibold)).lineLimit(1)
            }
            if let p = entry.pushed { Text(agoText(p)).font(.system(size: 9)).foregroundStyle(.secondary) }
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
struct DispecinkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Dispecink", provider: Provider()) { WidgetView(entry: $0) }
            .configurationDisplayName("Dispečink")
            .description("Limity Claude, ChatGPT a Gemini a co na tebe čeká.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}
