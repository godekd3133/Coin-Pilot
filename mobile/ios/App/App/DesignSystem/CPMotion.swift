import SwiftUI
#if os(iOS)
import UIKit
#endif

// Motion primitives: press feedback, button styles, count-up numbers, skeleton
// shimmer and the card entrance. Every effect degrades to a short fade (or
// nothing) when Reduce Motion is on.

/// Press feedback: a gentle shrink that springs back on release. Reduce Motion
/// keeps only the opacity dip so the press is still visible without movement.
struct CoinPilotPressEffect: ViewModifier {
    let isPressed: Bool
    var dimmedOpacity: Double = 0.86
    var haptic: CPHaptics.Weight? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed && !reduceMotion ? CPMotion.pressScale : 1)
            .opacity(isPressed ? dimmedOpacity : 1)
            .animation(CPMotion.resolved(CPMotion.press, reduceMotion: reduceMotion), value: isPressed)
            .cpOnChange(of: isPressed) { pressed in
                if pressed, let haptic { CPHaptics.impact(haptic) }
            }
    }
}

/// Drop-in replacement for `PlainButtonStyle` that adds the shared press feedback.
struct CoinPilotPressableButtonStyle: ButtonStyle {
    /// Rows inside scroll views stay silent; standalone taps (quick actions) opt in.
    var haptic: CPHaptics.Weight? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 0.9, haptic: haptic))
    }
}

struct CoinPilotCompactButtonStyle: ButtonStyle {
    let tint: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundColor(tint)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(tint.opacity(configuration.isPressed ? 0.16 : 0.09))
            .clipShape(Capsule())
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.4)
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 1, haptic: .light))
    }
}

struct CoinPilotSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(CoinPilotTextReveal())
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundColor(isEnabled ? CPColor.blue : CPColor.secondaryInk)
            .background(isEnabled
                        ? CPColor.blue.opacity(configuration.isPressed ? 0.17 : 0.10)
                        : CPColor.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 1, haptic: .light))
    }
}

struct CoinPilotPrimaryButtonStyle: ButtonStyle {
    var tint: Color = CPColor.blueFill
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(CoinPilotTextReveal())
            .font(.headline.weight(.bold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundColor(isEnabled ? .white : CPColor.secondaryInk)
            .background(isEnabled ? tint : CPColor.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: CPRadius.md, style: .continuous))
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 0.88, haptic: .medium))
    }
}

/// Toss-style number roll for won amounts. Missing values render their text
/// immediately; Reduce Motion (or the first frame) shows the final value.
struct CoinPilotCountingWon: View {
    let value: Double?
    let unavailable: String
    var signed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var displayed: Double?

    var body: some View {
        Group {
            if value != nil, let displayed {
                Text(verbatim: "")
                    .modifier(CoinPilotCountingWonText(value: displayed, signed: signed))
            } else {
                Text(formatted(value))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(formatted(value))
        .onAppear {
            // Count up from zero only the first time; returning to a tab keeps the shown value.
            if displayed == nil { roll(to: value, from: 0) } else if displayed != value { roll(to: value, from: displayed) }
        }
        .cpOnChange(of: value) { newValue in roll(to: newValue, from: displayed) }
    }

    private func formatted(_ amount: Double?) -> String {
        signed
            ? CoinPilotFormatting.signedWon(amount, unavailable: unavailable)
            : CoinPilotFormatting.won(amount, unavailable: unavailable)
    }

    private func roll(to target: Double?, from start: Double?) {
        guard let target else {
            displayed = nil
            return
        }
        guard !reduceMotion, let start, abs(target - start) >= 1 else {
            displayed = target
            return
        }
        displayed = start
        withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: CPMotion.countDuration)) {
            displayed = target
        }
    }
}

struct CoinPilotCountingWonText: ViewModifier, Animatable {
    var value: Double
    let signed: Bool

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    func body(content: Content) -> some View {
        let rounded = value.rounded()
        Text(signed ? CoinPilotFormatting.signedWon(rounded) : CoinPilotFormatting.won(rounded))
    }
}

/// Skeleton placeholder with a soft shimmer; static under Reduce Motion.
struct CoinPilotSkeleton: View {
    var width: CGFloat? = nil
    var height: CGFloat = 16
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        RoundedRectangle(cornerRadius: min(8, height / 2), style: .continuous)
            .fill(CPColor.surfaceRaised)
            .overlay(
                GeometryReader { proxy in
                    LinearGradient(
                        colors: [.clear, Color.white.opacity(0.45), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: proxy.size.width * 0.6)
                    .offset(x: phase * proxy.size.width)
                    .opacity(reduceMotion ? 0 : 1)
                }
                .clipped()
                .blendMode(.plusLighter)
            )
            .clipShape(RoundedRectangle(cornerRadius: min(8, height / 2), style: .continuous))
            .frame(width: width, height: height)
            .accessibilityLabel("불러오는 중")
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) {
                    phase = 1.4
                }
            }
    }
}

/// Cards and rows rise in with a soft ease-out the first time they appear.
/// Views that appear together in one burst (a screen opening) are staggered by
/// `CPStagger`; later appearances (scrolling) start at once so nothing lags.
struct CoinPilotAppearRise: ViewModifier {
    var distance: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible || reduceMotion ? 0 : distance)
            .onAppear {
                guard !visible else { return }
                let delay = reduceMotion ? 0 : CPStagger.nextDelay()
                withAnimation(CPMotion.resolved(.timingCurve(0.22, 1, 0.36, 1, duration: CPMotion.slow), reduceMotion: reduceMotion)?.delay(delay)) {
                    visible = true
                }
            }
    }
}

/// Hands out entrance delays for views appearing in the same burst. A burst
/// starts after a quiet gap; only its first ~0.4s is staggered and the step is
/// capped, so the longest wait stays under 0.25s.
enum CPStagger {
    static let step: Double = 0.04
    static let maxSteps = 6
    private static var burstStart: TimeInterval = 0
    private static var lastCall: TimeInterval = 0
    private static var index = 0

    static func nextDelay(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Double {
        if now - lastCall > 0.25 {
            burstStart = now
            index = 0
        }
        lastCall = now
        guard now - burstStart < 0.4 else { return 0 }
        defer { index += 1 }
        return Double(min(index, maxSteps)) * step
    }
}

/// Short text reveal for headings, labels and button captions: a fade with a
/// small upward settle. Reduce Motion keeps only the fade.
struct CoinPilotTextReveal: ViewModifier {
    var delay: Double = 0.03
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible || reduceMotion ? 0 : 4)
            .onAppear {
                guard !visible else { return }
                withAnimation(CPMotion.resolved(CPMotion.easeOut, reduceMotion: reduceMotion)?.delay(reduceMotion ? 0 : delay)) {
                    visible = true
                }
            }
    }
}

/// Digit-by-digit roll for numbers rendered as text (iOS 16+ numericText);
/// earlier systems and Reduce Motion cross-fade instead.
struct CoinPilotNumericTransition<Key: Equatable>: ViewModifier {
    let key: Key
    var numericValue: Double? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let animation = CPMotion.resolved(CPMotion.easeOut, reduceMotion: reduceMotion)
        if reduceMotion {
            content.animation(animation, value: key)
        } else if #available(iOS 17.0, macOS 14.0, *), let numericValue {
            content
                .contentTransition(.numericText(value: numericValue))
                .animation(animation, value: key)
        } else if #available(iOS 16.0, macOS 13.0, *) {
            content
                .contentTransition(.numericText())
                .animation(animation, value: key)
        } else {
            content.animation(animation, value: key)
        }
    }
}

extension View {
    /// Rolls the digits of a formatted number when `value` changes.
    func cpNumericTransition(_ value: Double?) -> some View {
        modifier(CoinPilotNumericTransition(key: value, numericValue: value))
    }

    /// Rolls the digits of preformatted text when it changes.
    func cpNumericTransition(text: String) -> some View {
        modifier(CoinPilotNumericTransition(key: text))
    }

    func cpTextReveal(delay: Double = 0.03) -> some View {
        modifier(CoinPilotTextReveal(delay: delay))
    }
}

/// Tab content settles in (fade + small rise) each time its tab is selected.
struct CoinPilotTabEntrance: ViewModifier {
    let isActive: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = true

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .cpOnChange(of: isActive) { active in
                guard active else { return }
                var reset = Transaction()
                reset.disablesAnimations = true
                withTransaction(reset) { shown = false }
                DispatchQueue.main.async {
                    withAnimation(CPMotion.resolved(CPMotion.easeOut, reduceMotion: reduceMotion)) { shown = true }
                }
            }
    }
}

/// Haptic feedback for taps and selection changes (iOS only; a no-op on macOS).
enum CPHaptics {
    enum Weight { case light, medium, rigid }

    static func impact(_ weight: Weight) {
        #if os(iOS)
        let style: UIImpactFeedbackGenerator.FeedbackStyle
        switch weight {
        case .light: style = .light
        case .medium: style = .medium
        case .rigid: style = .rigid
        }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        #endif
    }

    static func selection() {
        #if os(iOS)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }
}
