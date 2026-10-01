import SwiftUI

enum Palette {
    static let claude = Color(red: 0.85, green: 0.47, blue: 0.34)
    static let gpt = Color(red: 0.06, green: 0.64, blue: 0.50)
    static let gemini = Color(red: 0.31, green: 0.55, blue: 0.96)
    static let accent = Color(red: 0.55, green: 0.61, blue: 1.0)
    static let amber = Color(red: 0.89, green: 0.69, blue: 0.29)
    static let bad = Color(red: 0.88, green: 0.38, blue: 0.35)
    static let card = Color.white.opacity(0.06)
}

/// A limit as a ring: an inner window (5 h) inside an outer one (the week), like the notch.
struct LimitRing: View {
    let label: String
    let color: Color
    let inner: Int?
    var outer: Int? = nil
    var size: CGFloat = 54
    var hideLabel = false
    func labelsHidden() -> LimitRing { var r = self; r.hideLabel = true; return r }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                if let outer {
                    ring(Double(outer), width: size * 0.07, inset: 0).opacity(0.7)
                }
                ring(Double(inner ?? 0), width: size * 0.1, inset: outer == nil ? 0 : size * 0.13)
                Text(inner.map { "\($0)" } ?? "–")
                    .font(.system(size: size * 0.26, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle((inner ?? 0) >= 85 ? Palette.bad : .white)
            }
            .frame(width: size, height: size)
            if !hideLabel { Text(label).font(.system(size: max(9, size * 0.19), weight: .medium)).foregroundStyle(.secondary) }
        }
    }

    private func ring(_ pct: Double, width: CGFloat, inset: CGFloat) -> some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: width)
            Circle()
                .trim(from: 0, to: min(1, pct / 100))
                .stroke(pct >= 85 ? Palette.bad : color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .padding(inset + width / 2)
    }
}

/// The Wisp bot: a soft blob with two eyes, its colour from how things are.
struct Mascot: View {
    var color: Color = Palette.accent
    var size: CGFloat = 44
    var sleepy = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.42, style: .continuous)
                .fill(color.gradient)
                .frame(width: size, height: size * 0.86)
            HStack(spacing: size * 0.2) {
                eye; eye
            }
            .offset(y: -size * 0.02)
        }
        .frame(width: size, height: size)
    }

    private var eye: some View {
        Capsule()
            .fill(Color(white: 0.07))
            .frame(width: size * 0.12, height: sleepy ? size * 0.04 : size * 0.18)
    }
}

func stateColor(_ s: String) -> Color {
    switch s {
    case "bad": return Palette.bad
    case "you", "new": return Palette.amber
    case "run": return Palette.accent
    case "off": return .gray
    default: return Color(red: 0.31, green: 0.75, blue: 0.49)
    }
}
