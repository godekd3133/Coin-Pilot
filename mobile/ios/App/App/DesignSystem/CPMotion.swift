import SwiftUI
#if os(iOS)
import UIKit
#endif

// Motion primitives. The app does not animate content: numbers, rows, cards,
// text and buttons change in place. These types keep their names so call sites
// stay stable, but every effect is instant. Press feedback is a plain opacity
// dip (no scale, no spring). Haptics fire only on order/confirm actions.

/// Press feedback: a plain opacity dip while pressed.
struct CoinPilotPressEffect: ViewModifier {
    let isPressed: Bool
    var dimmedOpacity: Double = 0.7
    var haptic: CPHaptics.Weight? = nil

    func body(content: Content) -> some View {
        content.opacity(isPressed ? dimmedOpacity : 1)
    }
}

/// Drop-in replacement for `PlainButtonStyle` with the opacity press state.
struct CoinPilotPressableButtonStyle: ButtonStyle {
    var haptic: CPHaptics.Weight? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(CoinPilotPressEffect(isPressed: configuration.isPressed, dimmedOpacity: 0.6))
    }
}

/// Small text-style action (no fill, no capsule).
struct CoinPilotCompactButtonStyle: ButtonStyle {
    let tint: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundColor(tint)
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.5 : 1) : 0.4)
    }
}

/// Secondary action: outlined rectangle, accent text.
struct CoinPilotSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 46)
            .foregroundColor(isEnabled ? CPColor.blue : CPColor.secondaryInk)
            .background(configuration.isPressed ? CPColor.surface2 : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: CPRadius.sm, style: .continuous)
                    .stroke(CPColor.line, lineWidth: 1)
            )
            .contentShape(Rectangle())
    }
}

/// The single primary action of a screen: solid fill, small radius.
struct CoinPilotPrimaryButtonStyle: ButtonStyle {
    var tint: Color = CPColor.blueFill
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundColor(isEnabled ? .white : CPColor.secondaryInk)
            .background(isEnabled ? tint : CPColor.surface2)
            .clipShape(RoundedRectangle(cornerRadius: CPRadius.sm, style: .continuous))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// Won amount, shown as-is (no count-up).
struct CoinPilotCountingWon: View {
    let value: Double?
    let unavailable: String
    var signed = false

    var body: some View {
        Text(signed
             ? CoinPilotFormatting.signedWon(value, unavailable: unavailable)
             : CoinPilotFormatting.won(value, unavailable: unavailable))
    }
}

/// Static loading placeholder (no shimmer).
struct CoinPilotSkeleton: View {
    var width: CGFloat? = nil
    var height: CGFloat = 16

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(CPColor.surface2)
            .frame(width: width, height: height)
            .accessibilityLabel("불러오는 중")
    }
}

/// Former entrance animation; content now appears immediately.
struct CoinPilotAppearRise: ViewModifier {
    var distance: CGFloat = 0
    func body(content: Content) -> some View { content }
}

/// Former text reveal; text now appears immediately.
struct CoinPilotTextReveal: ViewModifier {
    var delay: Double = 0
    func body(content: Content) -> some View { content }
}

extension View {
    /// Numbers change in place.
    func cpNumericTransition(_ value: Double?) -> some View { self }
    func cpNumericTransition(text: String) -> some View { self }
    func cpTextReveal(delay: Double = 0) -> some View { self }
}

/// Former tab entrance; tab content appears immediately.
struct CoinPilotTabEntrance: ViewModifier {
    let isActive: Bool
    func body(content: Content) -> some View { content }
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
