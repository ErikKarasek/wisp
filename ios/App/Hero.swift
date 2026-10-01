import SwiftUI

// The top of the overview: the phone's notch. The bot wears the look of whoever
// it shows (the agent at work, Claude asking, the one that failed), its steps
// slide up as they come in, it has moods, and it does a roll when work is done.

/// Little things rising from the bot: hearts, sparkles.
struct Burst: View {
    let glyph: String
    let color: Color
    let start: Date
    var count = 5
    var size: CGFloat = 16

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSince(start)
            ZStack {
                ForEach(0..<count, id: \.self) { i in
                    let k = (t - Double(i) * 0.11) / 1.6
                    if k > 0 && k < 1 {
                        Text(glyph)
                            .font(.system(size: size))
                            .foregroundStyle(color)
                            .offset(x: CGFloat((Double(i) * 37).truncatingRemainder(dividingBy: 60) - 30), y: -CGFloat(k) * 46)
                            .rotationEffect(.degrees(k * 30 - 15))
                            .opacity(sin(k * .pi))
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// A drop of sweat sliding off the bot, over and over: Claude's limit is used up.
struct Sweat: View {
    var body: some View {
        TimelineView(.animation) { tl in
            let k = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
            Text("💧").font(.system(size: 13))
                .offset(x: 30 + k * 6, y: -22 + k * 26)
                .opacity(k < 0.75 ? sin(k / 0.75 * .pi) : 0)
        }
        .allowsHitTesting(false)
    }
}

/// What the agent does, line by line: new steps push the old ones up, the current one shimmers.
struct LiveTicker: View {
    var steps: [String]
    var size: CGFloat = 15

    /// The same step several times in a row becomes one line with a count.
    private var lines: [(id: String, text: String)] {
        var out: [(String, Int)] = []
        for l in steps where !l.isEmpty {
            if out.last?.0 == l { out[out.count - 1].1 += 1 } else { out.append((l, 1)) }
        }
        return out.suffix(3).map { (id: "\($0.0)#\($0.1)", text: $0.1 > 1 ? "\($0.0) ×\($0.1)" : $0.0) }
    }

    var body: some View {
        let lines = self.lines
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.element.id) { n, item in
                let line = item.text
                let now = n == lines.count - 1
                HStack(spacing: 6) {
                    Image(systemName: now ? "apple.terminal" : "doc.on.doc").font(.system(size: now ? size * 0.85 : size * 0.7))
                        .foregroundStyle(.white.opacity(now ? 0.9 : 0.35))
                    if now { Shimmer(text: line, size: size) }
                    else { Text(line).font(.system(size: size * 0.82)).foregroundStyle(.white.opacity(0.38)).lineLimit(1) }
                }
                .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .move(edge: .top).combined(with: .opacity)))
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: lines.map(\.id))
    }
}

/// A line whose light sweeps across it, like the notch's current step.
struct Shimmer: View {
    let text: String
    var size: CGFloat = 15

    var body: some View {
        TimelineView(.animation) { tl in
            let p = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
            Text(text)
                .font(.system(size: size, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .foregroundStyle(LinearGradient(
                    stops: [.init(color: .white.opacity(0.55), location: 0), .init(color: .white, location: 0.5), .init(color: .white.opacity(0.55), location: 1)],
                    startPoint: UnitPoint(x: 1.6 - p * 3.2, y: 0.5), endPoint: UnitPoint(x: 2.6 - p * 3.2, y: 0.5)))
        }
    }
}

struct HeroCard: View {
    @EnvironmentObject var store: Store
    @State private var rollAt: Date?
    @State private var burst: (String, Color, Date)?
    @State private var reaction: (MascotExpression, Date)?
    @State private var pokes: [Date] = []
    @State private var spin = 0.0
    @State private var hop = false

    private var s: PhoneState? { store.state }
    private var mode: String { store.macAsleep ? "idle" : (s?.activityState.mode ?? "idle") }

    var body: some View {
        let a = s?.activityState
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 16) {
                bot
                VStack(alignment: .leading, spacing: 6) {
                    Text(who.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(.secondary).lineLimit(1)
                    if let a, a.mode == "working", !a.steps.isEmpty {
                        LiveTicker(steps: a.steps)
                    } else {
                        Text(a?.title ?? "Načítám…").font(.title3.weight(.semibold)).lineLimit(2)
                            .contentTransition(.opacity)
                        if let d = a?.detail, !d.isEmpty {
                            Text(d).font(.caption).foregroundStyle(modeColor(mode)).lineLimit(3)
                        }
                    }
                    Text(subline).font(.caption2).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(.easeOut(duration: 0.3), value: a?.title)
            }
            if let crew = s?.crew, !crew.isEmpty {
                CrewGrid(crew: crew, size: 12, detailed: true)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
        .padding(16)
        .background(
            ZStack {
                Color(white: 0.06)
                RadialGradient(colors: [modeColor(mode).opacity(mode == "idle" ? 0.08 : 0.32), .clear], center: .topLeading, startRadius: 0, endRadius: 260)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(.white.opacity(mode == "error" ? 0.0 : 0.07), lineWidth: 1))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Palette.bad.opacity(mode == "error" ? 0.45 : 0), lineWidth: 1))
        .animation(.spring(response: 0.5, dampingFraction: 0.8), value: s?.crew.map(\.name) ?? [])
        .onChange(of: mode) { old, new in
            // Work just finished: a roll over the top and sparkles.
            if new == "done" || (old == "working" && new == "idle") { celebrate() }
        }
    }

    private var bot: some View {
        ZStack(alignment: .topLeading) {
            Circle().fill(modeColor(mode).opacity(mode == "idle" ? 0.12 : 0.45)).blur(radius: 26).frame(width: 90, height: 90).offset(x: 6, y: 6)
            MascotView(character: look, expression: expression, seed: 5, rollAt: rollAt)
                .frame(width: 100, height: 100)
                .rotationEffect(.degrees(spin))
                .scaleEffect(x: hop ? 1.08 : 1, y: hop ? 0.9 : 1, anchor: .bottom)
                .id(look)
                .transition(.scale(scale: 0.8).combined(with: .opacity))
            if s?.spent == true && mode != "error" { Sweat() }
            if let b = burst, Date().timeIntervalSince(b.2) < 2.4 {
                Burst(glyph: b.0, color: b.1, start: b.2).offset(x: 50, y: 30)
            }
            BadgeDot(mode: mode).offset(x: 2, y: 4)
        }
        .frame(width: 100, height: 100)
        .animation(.spring(response: 0.45, dampingFraction: 0.75), value: look)
        .contentShape(Rectangle())
        .onTapGesture { poke() }
        .onLongPressGesture(minimumDuration: 0.7) { love() }
    }

    private var look: MascotCharacter { (store.macAsleep ? nil : s?.focusLook) ?? s?.bot ?? .white }

    private var expression: MascotExpression {
        if let r = reaction, Date().timeIntervalSince(r.1) < 1.6 { return r.0 }
        if store.macAsleep { return .sleepy }
        switch mode {
        case "working": return .thriving
        case "error": return .angry
        case "ask": return .curious
        case "done": return .happy
        default: return s?.spent == true ? .tired : .happy
        }
    }

    private var who: String {
        guard let s else { return "Wisp" }
        if let p = s.perms?.first { return "\(p.project) · Claude" }
        if let l = s.live?.first { return "\(l.name) pracuje" }
        return "Wisp"
    }

    private var subline: String {
        guard let at = store.pushed else { return "" }
        let focus = s?.focus == true ? " · soustředění" : ""
        return store.macAsleep ? "Mac spí, poslední stav \(agoText(at))\(focus)" : "Mac hlásil \(agoText(at))\(focus)"
    }

    private func react(_ e: MascotExpression, for seconds: Double = 1.6) {
        let at = Date().addingTimeInterval(seconds - 1.6)
        reaction = (e, at)
        // Back to the mood once it's over (the face only changes when the view redraws).
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.05) { if reaction?.1 == at { reaction = nil } }
    }

    private func celebrate() {
        rollAt = Date()
        burst = ("✦", Color(red: 1, green: 0.84, blue: 0.42), Date())
        react(.happy)
        Haptic.success()
    }

    /// A poke: a hop. Five quick ones and it spins, dizzy and cross.
    private func poke() {
        let now = Date()
        pokes = pokes.filter { now.timeIntervalSince($0) < 2.5 } + [now]
        Haptic.tap()
        if pokes.count >= 5 {
            pokes = []
            react(.angry)
            withAnimation(.easeInOut(duration: 0.9)) { spin += 720 }
            Haptic.warning()
        } else {
            react(pokes.count >= 3 ? .happy : .surprised)
            withAnimation(.spring(response: 0.18, dampingFraction: 0.4)) { hop = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) { hop = false } }
        }
    }

    /// A long press: it falls for you.
    private func love() {
        react(.love, for: 2.6)
        burst = ("♥", Color(red: 1, green: 0.36, blue: 0.56), Date())
        Haptic.success()
    }
}

/// The small badge on the bot: three dots while working, a coloured dot otherwise.
struct BadgeDot: View {
    var mode: String
    var body: some View {
        switch mode {
        case "working":
            Capsule().fill(Color(red: 0.2, green: 0.55, blue: 1.0)).frame(width: 30, height: 18)
                .overlay(TimelineView(.animation) { tl in
                    HStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { i in
                            let t = tl.date.timeIntervalSinceReferenceDate * 2.5 - Double(i) * 0.5
                            Circle().fill(.white).frame(width: 4.5).opacity(0.35 + 0.65 * (0.5 + 0.5 * sin(t)))
                        }
                    }
                })
                .overlay(Capsule().stroke(.black, lineWidth: 2))
        case "error", "done", "ask":
            Circle().fill(mode == "error" ? Palette.bad : mode == "done" ? .green : Palette.amber).frame(width: 14, height: 14)
                .overlay(Circle().stroke(.black, lineWidth: 2))
        default: EmptyView()
        }
    }
}

enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}
