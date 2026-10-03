import SwiftUI

// Characters from the phone, like the Mac's studio (src/studio.ts): put a saved one on, or change
// how it looks. It goes to the Mac as a "look" command (setLook in src/main.ts); editing a saved
// character changes it on everyone who wears it, as on the Mac.

/// Who gets the character: an item ("agent:…", "job:…"), the notch bot ("bot") or Claude Code ("claude").
struct LookTarget: Identifiable {
    let id: String
    let title: String
    let current: MascotCharacter
}

private let SHAPES: [(String, String)] = [
    ("round", "Kulička"), ("capsule", "Kapsle"), ("lemon", "Citron"), ("cube", "Kostka"),
    ("cloud", "Mráček"), ("ghost", "Duch"), ("dome", "Kopeček"), ("onigiri", "Onigiri"),
    ("blob", "Želé"), ("cat", "Kočka"), ("bear", "Méďa"), ("bunny", "Zajíc"),
    ("sun", "Sluníčko"), ("flower", "Kytička"), ("planet", "Planetka"), ("star", "Hvězdička"),
    ("octopus", "Chobotnička"), ("sprout", "Klíček"), ("crown", "Princátko"), ("flame", "Plamínek"),
]
private let BODY_COLORS = [
    "#6d7fe0", "#8b9cff", "#4fb3d9", "#5fcfa8", "#7fc97a", "#e8d25a", "#f2a65a", "#f08a7e",
    "#e0605a", "#d980c9", "#b4a1f0", "#8e5bb5", "#c9a27e", "#dfe3ec", "#8a909b", "#3a3f4b", "#d97757",
]
private let EYE_COLORS = ["#111216", "#2b2140", "#3a1f14", "#f4f5f8"]

extension PhoneState {
    /// The saved character `target` wears, if any.
    func wornId(_ target: String) -> String? {
        switch target {
        case "bot": return looks?.bot
        case "claude": return looks?.claude
        default: return looks?.items?[target]
        }
    }
}

/// Everyone whose character can be changed: the bot, Claude Code, then the items.
struct LooksView: View {
    @EnvironmentObject var store: Store
    @State private var open: LookTarget?

    var body: some View {
        NavigationStack {
            List {
                if let s = store.state {
                    Section("V notchi") {
                        row(LookTarget(id: "bot", title: "Bot", current: s.bot ?? .white))
                        row(LookTarget(id: "claude", title: "Claude Code", current: s.claude ?? .claude))
                    }
                    Section("Agenti a úlohy") {
                        ForEach(s.items) { i in row(LookTarget(id: i.id, title: i.name, current: i.character ?? MascotCharacter())) }
                    }
                }
            }
            .navigationTitle("Postavičky")
            .sheet(item: $open) { LookEditor(target: $0).environmentObject(store).presentationDetents([.large]) }
        }
    }

    private func row(_ t: LookTarget) -> some View {
        Button { open = t } label: {
            HStack(spacing: 12) {
                MascotView(character: t.current, expression: .happy, animated: false).frame(width: 34, height: 34)
                Text(t.title).foregroundStyle(.white)
                Spacer()
                if let id = store.state?.wornId(t.id), let name = store.state?.gallery?.first(where: { $0.id == id })?.name {
                    Text(name).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct LookEditor: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let target: LookTarget

    /// The saved character being worn or edited; nil for a new one (or the automatic face).
    @State private var charId: String?
    @State private var draft = MascotCharacter()
    @State private var name = ""
    /// Whether the look was changed here, rather than only a saved one picked.
    @State private var edited = false
    @State private var automatic = false
    @State private var ready = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    MascotView(character: draft, expression: .happy, seed: 5)
                        .frame(width: 120, height: 120)
                        .frame(maxWidth: .infinity)
                        .opacity(automatic ? 0.4 : 1)

                    if let gallery = store.state?.gallery, !gallery.isEmpty {
                        label("Z galerie")
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                if !["bot", "claude"].contains(target.id) {
                                    tile("Automatická", look: target.current, on: automatic) { automatic = true; charId = nil; edited = false }
                                }
                                ForEach(gallery) { g in
                                    tile(g.name, look: g.character, on: !automatic && charId == g.id) {
                                        automatic = false; charId = g.id; draft = g.character; name = g.name; edited = false
                                    }
                                }
                            }
                        }
                    }

                    label("Tvar")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                        ForEach(SHAPES, id: \.0) { shape, title in
                            Button { change { $0.shape = shape } } label: {
                                VStack(spacing: 4) {
                                    MascotView(character: { var c = draft; c.shape = shape; return c }(), expression: .happy, animated: false).frame(width: 36, height: 36)
                                    Text(title).font(.caption2)
                                }
                                .frame(maxWidth: .infinity).padding(.vertical, 6)
                                .background(draft.shape == shape ? Palette.accent.opacity(0.3) : Palette.card, in: RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    label("Barva")
                    swatches(BODY_COLORS, selected: draft.color) { c in change { $0.color = c } }
                    label("Oči")
                    swatches(EYE_COLORS, selected: draft.eyeColor) { c in change { $0.eyeColor = c } }

                    slider("Postava", "vyšší", "širší", value: Binding(get: { draft.aspect }, set: { v in change { $0.aspect = v } }), 0.75...1.35)
                    slider("Náklon", "doleva", "doprava", value: Binding(get: { draft.lean }, set: { v in change { $0.lean = v.rounded() } }), -12...12)
                    slider("Velikost očí", "malé", "velké", value: Binding(get: { draft.eyeSize }, set: { v in change { $0.eyeSize = v } }), 0.6...1.6)
                    slider("Rozestup očí", "u sebe", "od sebe", value: Binding(get: { draft.eyeSpread }, set: { v in change { $0.eyeSpread = v } }), 0.6...1.5)

                    label("Jméno")
                    TextField("Postavička", text: $name).textFieldStyle(.roundedBorder)
                    if charId != nil && edited {
                        Text("Změní se u všech, kdo tuhle postavičku nosí. Pro jen jednoho dej Uložit jako novou.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(20)
            }
            .background(Color.black)
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Zrušit") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Uložit") { send(asNew: false) }.disabled(store.sending) }
                if charId != nil && edited {
                    ToolbarItem(placement: .bottomBar) { Button("Uložit jako novou") { send(asNew: true) }.disabled(store.sending) }
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard !ready else { return }
        ready = true
        draft = target.current
        if let id = store.state?.wornId(target.id), let g = store.state?.gallery?.first(where: { $0.id == id }) {
            charId = id; draft = g.character; name = g.name
        } else if !["bot", "claude"].contains(target.id) {
            automatic = true
        }
    }

    private func change(_ f: (inout MascotCharacter) -> Void) {
        f(&draft)
        edited = true
        automatic = false
    }

    private func send(asNew: Bool) {
        var cmd = ["kind": "look", "target": target.id]
        if !automatic {
            if let id = charId, !asNew { cmd["charId"] = id }
            if edited || charId == nil || asNew {
                cmd["character"] = (try? JSONEncoder().encode(draft)).flatMap { String(data: $0, encoding: .utf8) }
                cmd["name"] = name.trimmingCharacters(in: .whitespaces).isEmpty ? target.title : name
            }
        }
        Task {
            if await store.send(cmd) {
                Haptic.tap()
                dismiss()
            }
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
    }

    private func tile(_ title: String, look: MascotCharacter, on: Bool, _ pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            VStack(spacing: 4) {
                MascotView(character: look, expression: .happy, animated: false).frame(width: 44, height: 44)
                Text(title).font(.caption2).lineLimit(1)
            }
            .frame(width: 76).padding(.vertical, 6)
            .background(on ? Palette.accent.opacity(0.3) : Palette.card, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    private func swatches(_ colors: [String], selected: String, _ pick: @escaping (String) -> Void) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 34), spacing: 8)], spacing: 8) {
            ForEach(colors, id: \.self) { c in
                Button { pick(c) } label: {
                    Circle().fill(hexColor(c)).frame(width: 30, height: 30)
                        .overlay(Circle().stroke(.white, lineWidth: selected.lowercased() == c ? 2.5 : 0).padding(-3))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func slider(_ title: String, _ low: String, _ high: String, value: Binding<Double>, _ range: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            label(title)
            Slider(value: value, in: range)
            HStack { Text(low); Spacer(); Text(high) }.font(.caption2).foregroundStyle(.secondary)
        }
    }
}
