import SwiftUI

// The Wisp mascot, ported one-to-one from src/mascot/mascot.ts so the
// phone draws exactly the characters the Mac does: a flat body in one of five
// shapes and two capsule eyes laid on an imagined sphere. 100×100 viewBox.

struct MascotCharacter: Codable, Hashable {
    var shape: String = "round"
    var color: String = "#6d7fe0"
    var eyeColor: String = "#111216"
    var aspect: Double = 1
    var lean: Double = 0
    var eyeSize: Double = 1
    var eyeSpread: Double = 1

    init() {}
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        shape = (try? c.decode(String.self, forKey: .shape)) ?? "round"
        color = (try? c.decode(String.self, forKey: .color)) ?? "#6d7fe0"
        eyeColor = (try? c.decode(String.self, forKey: .eyeColor)) ?? "#111216"
        aspect = (try? c.decode(Double.self, forKey: .aspect)) ?? 1
        lean = (try? c.decode(Double.self, forKey: .lean)) ?? 0
        eyeSize = (try? c.decode(Double.self, forKey: .eyeSize)) ?? 1
        eyeSpread = (try? c.decode(Double.self, forKey: .eyeSpread)) ?? 1
    }
    static let white = { var c = MascotCharacter(); c.color = "#f4f5f8"; return c }()
    /// Claude Code in a terminal: Claude's clay orange.
    static let claude = { var c = MascotCharacter(); c.color = "#d97757"; c.eyeColor = "#2a1610"; return c }()
}

struct EyeSpec { var x = 0.0, y = 0.0, length = 1.0, width = 1.0, angle = 0.0 }

struct MascotExpression {
    var left = EyeSpec(), right = EyeSpec()
    var lookX = 0.0, lookY = 0.0, tilt = 0.0, bounce = 0.0, wander = 1.0
    var tint = "", tintAmount = 0.0, zzz = 0.0, blinks = true

    static func both(_ e: EyeSpec, _ f: (inout MascotExpression) -> Void) -> MascotExpression {
        var x = MascotExpression(); x.left = e; x.right = e; f(&x); return x
    }

    static let neutral = MascotExpression()
    static let happy = both(EyeSpec(y: -0.02, length: 0.62, width: 1.05, angle: -14)) { $0.lookY = -0.35; $0.tilt = -4; $0.wander = 0.6 }
    static let thriving = both(EyeSpec(length: 0.15, width: 1.35)) { $0.lookY = -0.4; $0.bounce = 5; $0.wander = 0.4 }
    static let sad = both(EyeSpec(length: 0.85, angle: -26)) { $0.lookY = 0.65; $0.lookX = -0.2; $0.tilt = 5; $0.wander = 0.2 }
    static let sleepy = both(EyeSpec(y: 0.05, length: 0.9, width: 0.6, angle: 90)) { $0.lookY = 0.35; $0.wander = 0; $0.zzz = 1; $0.blinks = false }
    static let surprised = both(EyeSpec(length: 0.2, width: 1.5)) { $0.lookY = -0.15; $0.wander = 0.15 }
    static let angry = both(EyeSpec(length: 0.95, width: 1.1, angle: 30)) { $0.lookY = 0.1; $0.wander = 0.25; $0.tint = "#c0453e"; $0.tintAmount = 1 }
    static let curious: MascotExpression = {
        var x = MascotExpression(); x.left = EyeSpec(length: 0.7, width: 0.85); x.right = EyeSpec(length: 1.25, width: 1.2)
        x.lookX = 0.55; x.lookY = -0.2; x.tilt = 7; x.wander = 0.2; return x
    }()
    static let proud: MascotExpression = {
        var x = MascotExpression(); x.left = EyeSpec(length: 1.05, angle: -34); x.right = EyeSpec(length: 0.95, angle: -12)
        x.lookX = -0.45; x.lookY = 0.35; x.tilt = -5; x.wander = 0.2; return x
    }()

    static let wink: MascotExpression = {
        var x = MascotExpression(); x.left = EyeSpec(y: 0.03, length: 0.9, width: 0.6, angle: 80); x.right = EyeSpec(y: -0.02, length: 0.62, width: 1.05, angle: -14)
        x.lookX = 0.25; x.lookY = -0.25; x.tilt = 9; x.wander = 0; x.blinks = false; return x
    }()
    static let love = both(EyeSpec(y: -0.03, length: 0.5, width: 1.15, angle: -18)) { $0.lookY = -0.5; $0.tilt = -6; $0.bounce = 2; $0.wander = 0; $0.tint = "#ff7aa8"; $0.tintAmount = 0.35 }
    static let tired = both(EyeSpec(y: 0.06, length: 0.45, width: 1, angle: -8)) { $0.lookY = 0.4; $0.tilt = 4; $0.wander = 0.15 }

    /// The Mac's STATES table: which face each state wears.
    static func forState(_ s: String) -> MascotExpression {
        switch s {
        case "run": return thriving
        case "done": return proud
        case "sleep": return sleepy
        case "you": return curious
        case "new": return surprised
        case "bad": return angry
        case "off": return sad
        default: return happy
        }
    }
}

struct MascotPose { var lookX = 0.0, lookY = 0.0, blink = 0.0, squash = 0.0, lift = 0.0, time = 0.0, spin = 0.0 }

private func hash01(_ n: Double) -> Double { let x = sin(n * 127.1 + 311.7) * 43758.5453; return x - floor(x) }

func mascotPose(_ ex: MascotExpression, _ t: Double, seed: Double = 0) -> MascotPose {
    let sleeping = ex.zzz > 0.5
    let breath = sin((t / (sleeping ? 4.2 : 3.4)) * .pi * 2)
    var blink = 0.0
    if ex.blinks {
        let slotLen = 3.6, slot = floor(t / slotLen)
        let at = slot * slotLen + hash01(slot + seed * 91) * (slotLen - 0.5)
        let d = t - at
        if d >= 0 && d < 0.18 { blink = sin(d / 0.18 * .pi) }
        let d2 = d - 0.28
        if hash01(slot * 7 + seed) > 0.8 && d2 >= 0 && d2 < 0.18 { blink = sin(d2 / 0.18 * .pi) }
    }
    let w = ex.wander
    func drift(_ f: Double, _ p: Double) -> Double { let v = sin(t * f + p); return (v < 0 ? -1 : 1) * pow(abs(v), 0.6) }
    var lift = 0.0, land = 0.0
    if ex.bounce > 0 {
        let phase = (t * 1.6).truncatingRemainder(dividingBy: 1)
        lift = ex.bounce * sin(phase * .pi)
        land = phase > 0.9 || phase < 0.06 ? 0.06 : 0
    }
    return MascotPose(lookX: w * (0.38 * drift(0.41, seed) + 0.14 * sin(t * 1.13 + seed * 2)),
                      lookY: w * 0.22 * drift(0.29, seed * 3 + 1),
                      blink: blink, squash: breath * (sleeping ? 0.025 : 0.014) + land, lift: lift, time: t)
}

// MARK: - colours

private func rgb(_ hex: String) -> (Double, Double, Double) {
    var h = hex.replacingOccurrences(of: "#", with: "")
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    let n = UInt32(h.prefix(6), radix: 16) ?? 0
    return (Double((n >> 16) & 255), Double((n >> 8) & 255), Double(n & 255))
}
private func mixHex(_ a: String, _ b: String, _ t: Double) -> (Double, Double, Double) {
    let pa = rgb(a), pb = rgb(b), k = min(1, max(0, t))
    return (pa.0 + (pb.0 - pa.0) * k, pa.1 + (pb.1 - pa.1) * k, pa.2 + (pb.2 - pa.2) * k)
}
private func color(_ c: (Double, Double, Double), _ alpha: Double = 1) -> Color {
    Color(.sRGB, red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, opacity: alpha)
}
private func hexString(_ c: (Double, Double, Double)) -> String {
    String(format: "#%02x%02x%02x", Int(c.0.rounded()), Int(c.1.rounded()), Int(c.2.rounded()))
}
private func luminance(_ hex: String) -> Double {
    let c = rgb(hex)
    func ch(_ v: Double) -> Double { let x = v / 255; return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c.0) + 0.7152 * ch(c.1) + 0.0722 * ch(c.2)
}

// MARK: - geometry, drawn straight into a Canvas

private func widthAt(_ shape: String, _ v: Double) -> Double { shape == "lemon" ? 0.8 + 0.2 * v : 1 }

func drawMascot(_ ctx: inout GraphicsContext, size: CGSize, character ch: MascotCharacter, expression ex: MascotExpression, pose: MascotPose) {
    let scale = min(size.width, size.height) / 100
    let ox = (size.width - 100 * scale) / 2, oy = (size.height - 100 * scale) / 2
    func P(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: ox + x * scale, y: oy + y * scale) }

    // Animals leave headroom for their ears.
    let groundY = 92.0, baseR = 38.0 * (ch.shape == "bunny" ? 0.74 : ch.shape == "cat" || ch.shape == "bear" ? 0.84 : 1), cloud = ch.shape == "cloud"
    let rx = baseR * sqrt(ch.aspect) * (1 + pose.squash * 0.5) * (cloud ? 0.92 : 1)
    let ry = (baseR / sqrt(ch.aspect)) * (1 - pose.squash) * (cloud ? 0.72 : 1)
    let cx = 50.0, cy = groundY - ry - pose.lift - (cloud ? 8 : 0)

    let tinted = !ex.tint.isEmpty && ex.tintAmount > 0
    let body = tinted ? mixHex(ch.color, ex.tint, ex.tintAmount) : rgb(ch.color)
    let baseEye = ch.eyeColor == "#111216" && luminance(ch.color) < 0.12 ? "#f2f2f5" : ch.eyeColor
    let eye = tinted ? mixHex(baseEye, hexString(mixHex(ex.tint, "#000000", 0.6)), ex.tintAmount) : rgb(baseEye)

    // Lean about the feet, like the SVG's rotate(tilt pivot).
    let pivot = P(cx, groundY)
    var g = ctx
    g.translateBy(x: pivot.x, y: pivot.y)
    g.rotate(by: .degrees(ch.lean + ex.tilt))
    g.translateBy(x: -pivot.x, y: -pivot.y)

    // The body as one or more shapes of its colour (puffs, ears), ported from mascot.ts bodyPrimitives.
    func ellipse(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> Path {
        let c = P(x, y)
        return Path(ellipseIn: CGRect(x: c.x - w * scale, y: c.y - h * scale, width: w * 2 * scale, height: h * 2 * scale))
    }
    func polar(_ x0: Double, _ y0: Double, _ ax: Double, _ ay: Double, clampBottom: Double = .infinity, _ r: (Double) -> Double) -> Path {
        var path = Path()
        for i in 0..<72 {
            let a = Double(i) / 72 * .pi * 2, k = r(a)
            let p = P(x0 + ax * k * cos(a), min(y0 + ay * k * sin(a), clampBottom))
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }
    func superellipse(_ n: Double) -> Path {
        var path = Path()
        for i in 0..<64 {
            let a = Double(i) / 64 * .pi * 2
            let c = cos(a), s = sin(a)
            let ex2 = (c < 0 ? -1 : 1) * pow(abs(c), 2 / n), ey = (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
            let p = P(cx + rx * ex2 * widthAt(ch.shape, ey), cy + ry * ey)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }
    var parts: [Path] = []
    switch ch.shape {
    case "cloud":
        for (x, y, r) in [(0.0, 0.18, 0.78), (-0.52, 0.28, 0.5), (0.52, 0.28, 0.5), (-0.3, -0.3, 0.52), (0.28, -0.36, 0.56), (0, 0.5, 0.5)] {
            parts.append(ellipse(cx + x * rx, cy + y * ry, r * rx, r * ry))
        }
    case "ghost":
        var path = Path()
        let top = cy - ry * 0.05
        for i in 0...32 {
            let a = Double.pi + Double(i) / 32 * .pi
            let p = P(cx + rx * cos(a), top + ry * 0.95 * sin(a))
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        let hem = cy + ry * 0.82
        path.addLine(to: P(cx + rx, hem))
        for k in 0..<3 {
            for j in 1...8 {
                let t = Double(j) / 8
                path.addLine(to: P(cx + rx - 2 * rx * (Double(k) + t) / 3, hem + sin(t * .pi) * ry * 0.2))
            }
        }
        path.closeSubpath()
        parts.append(path)
    case "dome":
        parts.append(polar(cx, cy - ry * 0.08, rx, ry * 1.06, clampBottom: cy + ry * 0.86) { a in
            1 / pow(pow(abs(cos(a)), 2.6) + pow(abs(sin(a)), 2.6), 1 / 2.6)
        })
    case "blob":
        parts.append(polar(cx, cy, rx, ry) { a in 1 + 0.07 * sin(3 * a + 0.6) + 0.045 * cos(5 * a) })
    case "onigiri":
        let v = [(cx, cy - ry * 1.05), (cx + rx * 1.08, cy + ry * 0.92), (cx - rx * 1.08, cy + ry * 0.92)]
        func lerp(_ a: (Double, Double), _ b: (Double, Double), _ t: Double) -> (Double, Double) { (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t) }
        var path = Path()
        for i in 0..<3 {
            let prev = v[(i + 2) % 3], cur = v[i], next = v[(i + 1) % 3]
            let a = lerp(cur, prev, 0.3), b = lerp(cur, next, 0.3)
            if i == 0 { path.move(to: P(a.0, a.1)) } else { path.addLine(to: P(a.0, a.1)) }
            path.addQuadCurve(to: P(b.0, b.1), control: P(cur.0, cur.1))
        }
        path.closeSubpath()
        parts.append(path)
    case "cat":
        for side in [-1.0, 1.0] {
            var ear = Path()
            ear.move(to: P(cx + side * rx * 0.86, cy - ry * 0.32))
            ear.addLine(to: P(cx + side * rx * 0.7, cy - ry * 1.28))
            ear.addQuadCurve(to: P(cx + side * rx * 0.52, cy - ry * 1.26), control: P(cx + side * rx * 0.62, cy - ry * 1.36))
            ear.addLine(to: P(cx + side * rx * 0.1, cy - ry * 0.8))
            ear.closeSubpath()
            parts.append(ear)
        }
        parts.append(superellipse(2))
    case "bear":
        for side in [-1.0, 1.0] { parts.append(ellipse(cx + side * rx * 0.66, cy - ry * 0.78, rx * 0.3, ry * 0.3)) }
        parts.append(superellipse(2))
    case "bunny":
        for side in [-1.0, 1.0] { parts.append(ellipse(cx + side * rx * 0.34, cy - ry * 1.12, rx * 0.17, ry * 0.52)) }
        parts.append(superellipse(2))
    default:
        parts.append(superellipse(ch.shape == "cube" ? 5 : ch.shape == "capsule" ? 3 : 2))
    }
    var bodyPath = Path()
    for part in parts {
        g.fill(part, with: .color(color(body)))
        bodyPath.addPath(part)
    }

    // Gloss, like a lit ball (the Grok Bot look): a highlight top-left, a soft shade at the bottom.
    var lit = g
    lit.clip(to: bodyPath)
    let r = max(rx, ry) * 1.55 * scale
    lit.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(
        Gradient(stops: [
            .init(color: .white.opacity(0.62), location: 0),
            .init(color: .white.opacity(0.1), location: 0.38),
            .init(color: .white.opacity(0), location: 0.7),
            .init(color: .black.opacity(0.3), location: 1),
        ]),
        center: P(cx - rx * 0.38, cy - ry * 0.5), startRadius: 0, endRadius: r))

    // The head's rotation, and the eyes projected from the sphere.
    let yaw = min(1, max(-1, ex.lookX + pose.lookX)) * 0.62
    let pitch = min(1, max(-1, ex.lookY + pose.lookY)) * 0.42 - pose.spin
    let cosY = cos(yaw), sinY = sin(yaw), cosP = cos(pitch), sinP = sin(pitch)
    func project(_ az: Double, _ el: Double) -> (x: Double, y: Double, z: Double) {
        var x = cos(el) * sin(az), y = sin(el), z = cos(el) * cos(az)
        (x, z) = (x * cosY + z * sinY, -x * sinY + z * cosY)
        (y, z) = (y * cosP + z * sinP, -y * sinP + z * cosP)
        let v = min(1, max(-1, y))
        return (cx + x * rx * 0.94 * widthAt(ch.shape, v), cy + y * ry * 0.94, z)
    }
    let spread = 0.25 * ch.eyeSpread, halfLen = 0.13 * ch.eyeSize, thickness = 9.2 * ch.eyeSize
    for side in [-1.0, 1.0] {
        let spec = side < 0 ? ex.left : ex.right
        let az = side * spread + side * spec.x, el = -0.06 + spec.y
        let a = spec.angle * .pi / 180, h = halfLen * spec.length
        let dAz = side * sin(a) * h, dEl = cos(a) * h
        let top = project(az + dAz, el - dEl), bottom = project(az - dAz, el + dEl), mid = project(az, el)
        if mid.z < 0.15 { continue }
        var width = thickness * spec.width * (0.45 + 0.55 * mid.z)
        var x1 = top.x, y1 = top.y, x2 = bottom.x, y2 = bottom.y
        if pose.blink > 0 {
            let b = pose.blink
            y1 = mid.y + (y1 - mid.y) * (1 - b); y2 = mid.y + (y2 - mid.y) * (1 - b)
            let sx = b * min(width * 0.3, 3), leftFirst = x1 <= x2
            x1 += leftFirst ? -sx : sx; x2 += leftFirst ? sx : -sx
            width *= 1 - b * 0.45
        }
        var line = Path(); line.move(to: P(x1, y1)); line.addLine(to: P(x2, y2))
        g.stroke(line, with: .color(color(eye)), style: StrokeStyle(lineWidth: width * scale, lineCap: .round, lineJoin: .round))
    }

    // Rising Zs while asleep.
    if ex.zzz > 0.01 {
        for i in 0..<3 {
            let p = (pose.time * 0.32 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
            let s = 3.5 + p * 4, zx = cx + rx * 0.72 + p * 12, zy = cy - ry * 0.75 - p * 20
            var z = Path()
            z.move(to: P(zx - s / 2, zy - s / 2)); z.addLine(to: P(zx + s / 2, zy - s / 2))
            z.addLine(to: P(zx - s / 2, zy + s / 2)); z.addLine(to: P(zx + s / 2, zy + s / 2))
            g.stroke(z, with: .color(color(eye, sin(p * .pi) * 0.67 * min(1, ex.zzz))), style: StrokeStyle(lineWidth: (1.2 + s * 0.14) * scale, lineCap: .round, lineJoin: .round))
        }
    }
}

/// The mascot as a view: alive (blinking, breathing, bouncing) in the app, still in widgets.
struct MascotView: View {
    var character: MascotCharacter = MascotCharacter()
    var expression: MascotExpression = .happy
    var animated = true
    var seed: Double = 0
    /// When a roll over the top started: the eyes go up and over and come back from below.
    var rollAt: Date? = nil

    var body: some View {
        if animated {
            TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
                canvas(time: tl.date.timeIntervalSinceReferenceDate)
            }
        } else {
            canvas(time: nil)
        }
    }

    private func canvas(time: Double?) -> some View {
        Canvas { ctx, size in
            var pose = time.map { mascotPose(expression, $0, seed: seed) } ?? MascotPose()
            if let rollAt, let t = time {
                let k = (t - rollAt.timeIntervalSinceReferenceDate) / 0.95
                if k > 0 && k < 1 { pose.spin = .pi * 2 * (k < 0.5 ? 4 * k * k * k : 1 - pow(-2 * k + 2, 3) / 2) }
            }
            drawMascot(&ctx, size: size, character: character, expression: expression, pose: pose)
        }
    }
}
