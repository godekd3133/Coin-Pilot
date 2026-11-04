import SwiftUI

// Motion primitives: press feedback, button styles, count-up numbers, skeleton
// shimmer and the card entrance. Every effect degrades to a short fade (or
// nothing) when Reduce Motion is on.

/// Press feedback: a gentle shrink that springs back on release. Reduce Motion
/// keeps only the opacity dip so the press is still visible without movement.
struct CoinPilotPressEffect: ViewModifier {
    let isPressed: Bool
    var dimmedOpacity: Double = 0.86
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed && !reduceMotion ? CPMotion.pressScale : 1)
            .opacity(isPressed ? dimmedOpacity : 1)
            .animation(CPMotion.resolved(CPMotion.press, reduceMotion: reduceMotion), value: isPressed)
    }
}

/// Drop-in replacement for `PlainButtonStyle` that adds the shared press feedback.
struct CoinPilotPressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 0.9))
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
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 1))
    }
}

struct CoinPilotSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundColor(isEnabled ? CPColor.blue : CPColor.secondaryInk)
            .background(isEnabled
                        ? CPColor.blue.opacity(configuration.isPressed ? 0.17 : 0.10)
                        : CPColor.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 1))
    }
}

struct CoinPilotPrimaryButtonStyle: ButtonStyle {
    var tint: Color = CPColor.blueFill
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.bold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundColor(isEnabled ? .white : CPColor.secondaryInk)
            .background(isEnabled ? tint : CPColor.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: CPRadius.md, style: .continuous))
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 0.88))
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

/// Cards rise in with a soft ease-out the first time they appear.
struct CoinPilotAppearRise: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible || reduceMotion ? 0 : 10)
            .onAppear {
                guard !visible else { return }
                withAnimation(CPMotion.resolved(.timingCurve(0.22, 1, 0.36, 1, duration: CPMotion.slow), reduceMotion: reduceMotion)) {
                    visible = true
                }
            }
    }
}
