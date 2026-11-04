import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Color

/// Semantic colours. The light value is the explicit 8-bit RGB triple and
/// `.cpDark(...)` supplies the dark-theme value. Every token is mirrored by the
/// web `public/app/ui/tokens.css` (`--cp-*`); `test/nativeColorTokenParity.test.js`
/// parses the declarations below, so keep the one-line form.
///
/// P&L numbers always use `up`/`down` (국내 관례: 상승 빨강, 하락 파랑).
/// Status (정상·오류) uses `green`/`red`. Never mix the two meanings.
enum CPColor {
    static let paper = Color(red: 242 / 255, green: 244 / 255, blue: 246 / 255).cpDark(16, 17, 20)
    static let surface = Color(red: 255 / 255, green: 255 / 255, blue: 255 / 255).cpDark(27, 28, 33)
    static let surface2 = Color(red: 247 / 255, green: 248 / 255, blue: 250 / 255).cpDark(36, 37, 43)
    static let ink = Color(red: 25 / 255, green: 31 / 255, blue: 40 / 255).cpDark(242, 244, 246)
    static let secondaryInk = Color(red: 102 / 255, green: 112 / 255, blue: 127 / 255).cpDark(154, 161, 172)
    static let line = Color(red: 229 / 255, green: 232 / 255, blue: 235 / 255).cpDark(46, 47, 54)
    static let blue = Color(red: 27 / 255, green: 100 / 255, blue: 218 / 255).cpDark(90, 157, 255)
    static let green = Color(red: 2 / 255, green: 118 / 255, blue: 72 / 255).cpDark(52, 201, 138)
    static let red = Color(red: 165 / 255, green: 25 / 255, blue: 38 / 255).cpDark(255, 123, 123)
    static let amber = Color(red: 150 / 255, green: 89 / 255, blue: 10 / 255).cpDark(241, 181, 82)
    static let up = Color(red: 210 / 255, green: 40 / 255, blue: 60 / 255).cpDark(255, 107, 122)
    static let down = Color(red: 27 / 255, green: 100 / 255, blue: 218 / 255).cpDark(90, 157, 255)

    /// Filled controls carry white labels, so they keep a deeper fill in dark mode.
    static let blueFill = Color(red: 27 / 255, green: 100 / 255, blue: 218 / 255).cpDark(43, 111, 217)
    static let redFill = Color(red: 165 / 255, green: 25 / 255, blue: 38 / 255).cpDark(200, 52, 60)

    /// Legacy name for the inner/secondary surface.
    static var surfaceRaised: Color { surface2 }
    /// Alias matching the web token name.
    static var muted: Color { secondaryInk }

    /// P&L colour: up (red) for gains, down (blue) for losses, muted otherwise.
    static func pnl(_ value: Double?) -> Color {
        guard let value, value.isFinite else { return secondaryInk }
        if value > 0 { return up }
        if value < 0 { return down }
        return secondaryInk
    }
}

// MARK: - Spacing, radius, typography

enum CPSpace {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
    /// Horizontal page gutter used by every scrolling screen.
    static let page: CGFloat = 18
}

enum CPRadius {
    static let sm: CGFloat = 10
    static let md: CGFloat = 14
    static let lg: CGFloat = 20
    static let xl: CGFloat = 28
    static let pill: CGFloat = 999
    static let card: CGFloat = lg
}

/// Type scale from the spec (px / weight). Sizes scale with Dynamic Type via
/// `relativeTo:`; numbers should add `.monospacedDigit()`.
enum CPFont {
    static let display = Font.system(size: 34, weight: .bold, design: .rounded)
    static let title = Font.system(.title2, design: .default).weight(.bold)
    static let headline = Font.headline.weight(.semibold)
    static let body = Font.body
    static let caption = Font.footnote.weight(.medium)
    static let micro = Font.caption2.weight(.semibold)
}

// MARK: - Motion

/// Motion language shared by every screen: ease-out for entering/settling,
/// a soft spring for press feedback. Reduce Motion swaps both for a short fade.
enum CPMotion {
    static let fast: Double = 0.14
    static let base: Double = 0.26
    static let slow: Double = 0.42
    static let easeOut = Animation.timingCurve(0.22, 1, 0.36, 1, duration: base)
    static let spring = Animation.spring(response: 0.42, dampingFraction: 0.86)
    static let press = Animation.spring(response: 0.26, dampingFraction: 0.62)
    static let countDuration: Double = 0.65
    static let pressScale: CGFloat = 0.97

    static func resolved(_ animation: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? .easeOut(duration: 0.12) : animation
    }
}

// MARK: - Dynamic colour helper

extension Color {
    /// Returns a dynamic colour that keeps `self` in light mode and uses the
    /// given 8-bit sRGB value in dark mode.
    func cpDark(_ red: Double, _ green: Double, _ blue: Double) -> Color {
        let light = self
        #if os(macOS)
        let darkColor = NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
        let lightColor = NSColor(light)
        return Color(NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? darkColor : lightColor
        })
        #else
        let darkColor = UIColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
        let lightColor = UIColor(light)
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? darkColor : lightColor
        })
        #endif
    }
}
