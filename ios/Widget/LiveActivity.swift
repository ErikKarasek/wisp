import ActivityKit
import SwiftUI
import WidgetKit

/// What the island draws: the state, or its settled form once it went stale.
struct Shown { let state: DispecinkActivity.ContentState }

struct DispecinkLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DispecinkActivity.self) { raw in
            let ctx = Shown(state: raw.isStale ? raw.state.settled : raw.state)
            // Lock screen and banner, like the Grok Bot card.
            HStack(spacing: 14) {
                BotBadge(character: ctx.state.bot ?? .white, mode: ctx.state.mode, size: 62)
                ActivityBody(s: ctx.state)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .background(ActivityGlow(mode: ctx.state.mode))
            .activityBackgroundTint(Color(white: 0.07))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { raw in
            let ctx = Shown(state: raw.isStale ? raw.state.settled : raw.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    BotBadge(character: ctx.state.bot ?? .white, mode: ctx.state.mode, size: 50).padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 4) {
                        LimitRing(label: "C", color: Palette.claude, inner: ctx.state.claude, outer: ctx.state.claudeWeek, size: 26)
                        LimitRing(label: "G", color: Palette.gpt, inner: ctx.state.gpt, size: 26)
                        LimitRing(label: "Ge", color: Palette.gemini, inner: ctx.state.gemini, size: 26)
                    }
                    .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityBody(s: ctx.state, big: 13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 4)
                }
            } compactLeading: {
                BotBadge(character: ctx.state.bot ?? .white, mode: ctx.state.mode, size: 22)
            } compactTrailing: {
                if ctx.state.perms + ctx.state.waiting > 0 {
                    Text("\(ctx.state.perms + ctx.state.waiting)").font(.caption.weight(.bold)).foregroundStyle(.black)
                        .frame(minWidth: 18, minHeight: 18).background(Palette.amber, in: Capsule())
                } else {
                    CrewFaces(crew: ctx.state.crew, size: 22)
                }
            } minimal: {
                BotBadge(character: ctx.state.bot ?? .white, mode: ctx.state.mode, size: 20)
            }
            .keylineTint(modeColor(ctx.state.mode))
        }
    }
}
