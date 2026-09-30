import ActivityKit
import BackgroundTasks
import SwiftUI
import UserNotifications

let refreshTask = "cz.erikkarasek.dispecink.refresh"

@main
struct DispecinkApp: App {
    @StateObject private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task {
                    await store.refresh()
                    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                }
                .onChange(of: phase) { _, p in
                    if p == .active { Task { await store.refresh() } }
                    if p == .background { scheduleRefresh() }
                }
        }
        // iOS wakes the app now and then (roughly every 15–30 min, its call) to update the island and notify.
        .backgroundTask(.appRefresh(refreshTask)) {
            scheduleRefresh()
            await store.refresh(background: true)
        }
    }
}

func scheduleRefresh() {
    let r = BGAppRefreshTaskRequest(identifier: refreshTask)
    r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(r)
}

@MainActor
final class Store: ObservableObject {
    @Published var state: PhoneState?
    @Published var pushed: Date?
    @Published var error: String?
    @Published var sending = false
    private var timer: Timer?
    /// What was already announced, so a notification comes once per thing.
    private var seen: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "seen") ?? [])

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func refresh(background: Bool = false) async {
        do {
            let (s, at) = try await Relay.state()
            state = s
            pushed = at
            error = nil
            await updateIsland(s)
            notify(s, background: background)
        } catch {
            self.error = "Nepodařilo se načíst stav (\(error.localizedDescription))."
        }
    }

    /// The Dynamic Island: one Live Activity, started when missing (they end after hours), then updated.
    private func updateIsland(_ s: PhoneState) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let content = ActivityContent(state: s.activityState, staleDate: Date(timeIntervalSinceNow: 40 * 60))
        let running = Activity<DispecinkActivity>.activities.filter { $0.activityState == .active }
        if let a = running.first {
            await a.update(content)
            for extra in running.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        } else {
            _ = try? Activity.request(attributes: DispecinkActivity(), content: content)
        }
    }

    /// New things waiting on Erik and Claude's permission prompts, as local notifications.
    private func notify(_ s: PhoneState, background: Bool) {
        var fresh: [(String, String, String)] = []
        for p in s.perms ?? [] where !seen.contains("perm:\(p.id)") {
            fresh.append(("perm:\(p.id)", "\(p.project) · Claude chce povolit", p.detail))
        }
        for i in s.waiting where !seen.contains("item:\(i.id):\(i.state)") {
            fresh.append(("item:\(i.id):\(i.state)", i.state == "bad" ? "\(i.name) selhal" : "\(i.name) na tebe čeká", i.doing))
        }
        guard !fresh.isEmpty else { return }
        for (key, _, _) in fresh { seen.insert(key) }
        UserDefaults.standard.set(Array(seen.suffix(300)), forKey: "seen")
        // In the app the screen shows it already; notifications are for when it's in the pocket.
        guard background || UIApplication.shared.applicationState != .active else { return }
        for (key, title, body) in fresh.prefix(3) {
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: c, trigger: nil))
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
