import SwiftUI

// The Grok-Bot look shared by the Dynamic Island, the lock-screen card, the
// widgets and the app: a big bot with a status badge and a soft glow, a
// three-line step ticker, and the crew as coloured chips.

func hexColor(_ hex: String) -> Color {
    var h = hex.replacingOccurrences(of: "#", with: "")
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    let n = UInt32(h.prefix(6), radix: 16) ?? 0x8b9cff
    return Color(.sRGB, red: Double((n >> 16) & 255) / 255, green: Double((n >> 8) & 255) / 255, blue: Double(n & 255) / 255)
}

/// The glow behind the bot: blue while working, red on failure, green when done.
func modeColor(_ mode: String) -> Color {
    switch mode {
    case "working": return Color(red: 0.36, green: 0.62, blue: 1.0)
    case "error": return Palette.bad
    case "ask": return Palette.amber
    case "done": return Color(red: 0.24, green: 0.78, blue: 0.42)
    default: return Color.white.opacity(0.35)
    }
}

/// The bot with its badge: three dots while working, a green dot when done, a red one on failure.
struct BotBadge: View {
    var character: MascotCharacter
    var mode: String
    var size: CGFloat
    var animated = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            MascotView(character: character, expression: expression, animated: animated, seed: 5)
                .frame(width: size, height: size)
                .shadow(color: modeColor(mode).opacity(mode == "idle" ? 0 : 0.7), radius: size * 0.22)
            badge.offset(x: size * 0.02, y: size * 0.04)
        }
    }

    private var expression: MascotExpression {
        switch mode {
        case "working": return .thriving
        case "error": return .angry
        case "ask": return .curious
        case "done": return .proud
        default: return .happy
        }
    }

    @ViewBuilder private var badge: some View {
        let d = max(10, size * 0.26)
        switch mode {
        case "working":
            Capsule().fill(Color(red: 0.2, green: 0.55, blue: 1.0))
                .frame(width: d * 1.3, height: d)
                .overlay(HStack(spacing: d * 0.1) { ForEach(0..<3, id: \.self) { _ in Circle().fill(.white).frame(width: d * 0.22) } })
                .overlay(Capsule().stroke(Color.black, lineWidth: d * 0.12))
        case "error", "done", "ask":
            Circle().fill(mode == "error" ? Palette.bad : mode == "done" ? Color.green : Palette.amber)
                .frame(width: d * 0.62, height: d * 0.62)
                .overlay(Circle().stroke(Color.black, lineWidth: d * 0.1))
        default: EmptyView()
        }
    }
}

/// Three lines: what came before (dim), what happens now (bright, with a terminal icon), and what's around it.
struct StepTicker: View {
    var steps: [String]
    var fallback: String = ""
    var big: CGFloat = 15

    var body: some View {
        let lines = steps.suffix(3)
        VStack(alignment: .leading, spacing: big * 0.35) {
            if lines.isEmpty {
                Text(fallback).font(.system(size: big, weight: .medium)).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { n, line in
                let now = n == lines.count - 1
                HStack(spacing: 6) {
                    Image(systemName: now ? "apple.terminal" : "doc.on.doc")
                        .font(.system(size: now ? big * 0.9 : big * 0.72))
                    Text(line).lineLimit(1)
                        .font(.system(size: now ? big : big * 0.82, weight: now ? .medium : .regular))
                }
                .foregroundStyle(.white.opacity(now ? 0.95 : 0.4))
            }
        }
    }
}

/// An agent as a pill: its small face and what it does, in its colour.
struct CrewPill: View {
    var chip: CrewChip
    var size: CGFloat = 13

    var body: some View {
        let c = hexColor(chip.character.color)
        HStack(spacing: 6) {
            MascotView(character: chip.character, expression: .forState(chip.state), animated: false)
                .frame(width: size * 1.6, height: size * 1.6)
            Text(["run", "you", "bad", "done", "new"].contains(chip.state) ? chip.status : chip.name).lineLimit(1)
                .font(.system(size: size, weight: .medium)).foregroundStyle(c)
        }
        .padding(.leading, 5).padding(.trailing, 10).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(c.opacity(0.25), lineWidth: 1))
    }
}

/// The crew in a 2×2 grid of pills.
struct CrewGrid: View {
    var crew: [CrewChip]
    var size: CGFloat = 13
    var body: some View {
        let rows = stride(from: 0, to: min(crew.count, 4), by: 2).map { Array(crew[$0..<min($0 + 2, crew.count)]) }
        VStack(spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 6) { ForEach(row, id: \.name) { CrewPill(chip: $0, size: size) } }
            }
        }
    }
}

/// Four faces in a tight 2×2, for tiny places.
struct CrewFaces: View {
    var crew: [CrewChip]
    var size: CGFloat
    var body: some View {
        let faces = Array(crew.prefix(4))
        VStack(spacing: 1) {
            HStack(spacing: 1) { ForEach(faces.prefix(2), id: \.name) { face($0) } }
            HStack(spacing: 1) { ForEach(faces.dropFirst(2), id: \.name) { face($0) } }
        }
    }
    private func face(_ c: CrewChip) -> some View {
        MascotView(character: c.character, expression: .forState(c.state), animated: false).frame(width: size / 2, height: size / 2)
    }
}

/// What the card says, by mode: the step ticker, a failure, a question, or the crew.
struct ActivityBody: View {
    var s: DispecinkActivity.ContentState
    var big: CGFloat = 15

    var body: some View {
        switch s.mode {
        case "working":
            StepTicker(steps: s.steps, fallback: s.title, big: big)
        case "error", "ask":
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.title).font(.system(size: big * 0.9, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                    Text(s.detail).font(.system(size: big * 0.78)).foregroundStyle(modeColor(s.mode)).lineLimit(2)
                }
                Spacer(minLength: 4)
                Image(systemName: s.mode == "error" ? "arrow.clockwise" : "hand.raised")
                    .font(.system(size: big)).foregroundStyle(.white.opacity(0.6))
            }
        default:
            CrewGrid(crew: s.crew, size: big * 0.8)
        }
    }
}

/// The card's background: dark, with a glow in the mode's colour.
struct ActivityGlow: View {
    var mode: String
    var body: some View {
        ZStack {
            Color(white: 0.07)
            LinearGradient(colors: [.clear, modeColor(mode).opacity(mode == "error" ? 0.45 : mode == "idle" ? 0 : 0.22)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

