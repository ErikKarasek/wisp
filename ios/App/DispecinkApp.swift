import SwiftUI

@main
struct DispecinkApp: App {
    @StateObject private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task { await store.refresh() }
                .onChange(of: phase) { _, p in if p == .active { Task { await store.refresh() } } }
        }
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var state: PhoneState?
    @Published var pushed: Date?
    @Published var error: String?
    @Published var sending = false
    private var timer: Timer?

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func refresh() async {
        do {
            let (s, at) = try await Relay.state()
            state = s
            pushed = at
            error = nil
        } catch {
            self.error = "Nepodařilo se načíst stav (\(error.localizedDescription))."
        }
    }

    /// Send a command, then look again once the Mac had time to pick it up (it polls every 10 s).
    func send(_ cmd: [String: String]) async -> Bool {
        sending = true
        defer { sending = false }
        do {
            try await Relay.send(cmd)
            Task {
                try? await Task.sleep(for: .seconds(14))
                await refresh()
            }
            return true
        } catch {
            self.error = "Neodesláno: \(error.localizedDescription)"
            return false
        }
    }

    var macAsleep: Bool { pushed.map { Date().timeIntervalSince($0) > 300 } ?? false }
}
