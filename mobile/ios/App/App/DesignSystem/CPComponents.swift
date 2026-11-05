import SwiftUI

// Shared building blocks. Names and roles match the web `ui/components.js`
// (Card, HeroValue, Stat/StatGrid, ListRow, Segmented, Badge, EngineStatus,
// Sheet, Skeleton, EmptyState, Notice). Screens compose these instead of
// hand-styling surfaces so a token change restyles the whole app.

// MARK: - Card

/// Rounded white card with an optional title and trailing accessory.
struct CPCard<Content: View, Trailing: View>: View {
    let title: String?
    let trailing: Trailing
    let content: Content

    init(_ title: String? = nil,
         @ViewBuilder trailing: () -> Trailing,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: CPSpace.sm) {
                if title != nil || Trailing.self != EmptyView.self {
                    HStack(alignment: .firstTextBaseline, spacing: CPSpace.xs) {
                        if let title { SectionHeading(title: title) }
                        Spacer(minLength: CPSpace.xs)
                        trailing
                    }
                }
                content
            }
        }
    }
}

extension CPCard where Trailing == EmptyView {
    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title, trailing: { EmptyView() }, content: content)
    }
}

/// Base surface. Cards are separated from the paper background by contrast,
/// not shadow (spec §3).
struct NativeCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    init(padding: CGFloat = CPSpace.lg, @ViewBuilder content: () -> Content) {
        self.content = content()
        self.padding = padding
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CPColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: CPRadius.card, style: .continuous))
            .modifier(CoinPilotAppearRise())
    }
}

struct NativeDisclosureCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        NativeCard {
            DisclosureGroup {
                content().padding(.top, 12)
            } label: {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                    .frame(minHeight: 44)
            }
        }
    }
}

// MARK: - Hero value

/// Large amount with a count-up and an up/down change line.
struct HeroValue: View {
    let label: String
    let value: Double?
    var unavailable = "확인 불가"
    var change: Double? = nil
    var changePercent: Double? = nil
    var changeLabel: String? = nil
    var caption: String? = nil
    var isLoading = false
    @ScaledMetric(relativeTo: .largeTitle) private var displaySize: CGFloat = 34

    var body: some View {
        VStack(alignment: .leading, spacing: CPSpace.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.secondaryInk)
                    .cpTextReveal()
                Spacer(minLength: CPSpace.xs)
                if let caption {
                    Text(caption)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(1)
                }
            }
            if isLoading {
                CoinPilotSkeleton(width: 210, height: displaySize * 0.9)
                    .padding(.vertical, 3)
            } else {
                CoinPilotCountingWon(value: value, unavailable: unavailable)
                    .font(.system(size: displaySize, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(CPColor.ink)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
            }
            if change != nil || changeLabel != nil {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let changeLabel {
                        Text(changeLabel)
                            .font(.caption.weight(.medium))
                            .foregroundColor(CPColor.secondaryInk)
                    }
                    if change != nil {
                        CoinPilotCountingWon(value: change, unavailable: "—", signed: true)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundColor(CPColor.pnl(change))
                    }
                    if let changePercent {
                        Text(CoinPilotFormatting.percent(changePercent))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .cpNumericTransition(changePercent)
                            .foregroundColor(CPColor.pnl(change ?? changePercent))
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Stats

struct CPStatItem: Identifiable {
    let label: String
    let value: String
    var tint: Color = CPColor.ink
    var id: String { label }
}

struct CPStat: View {
    let item: CPStatItem

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(item.label)
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
                .lineLimit(1)
            Text(item.value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .cpNumericTransition(text: item.value)
                .foregroundColor(item.tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(CPColor.surface2)
        .clipShape(RoundedRectangle(cornerRadius: CPRadius.sm, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct CPStatGrid: View {
    let items: [CPStatItem]
    var columns = 2

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: CPSpace.xs), count: max(1, columns)),
            alignment: .leading,
            spacing: CPSpace.xs
        ) {
            ForEach(items) { CPStat(item: $0) }
        }
    }
}

// MARK: - List row

struct CPListRow<Leading: View>: View {
    let leading: Leading
    let title: String
    var subtitle: String? = nil
    var value: String? = nil
    var detail: String? = nil
    var detailColor: Color = CPColor.secondaryInk

    init(title: String, subtitle: String? = nil, value: String? = nil,
         detail: String? = nil, detailColor: Color = CPColor.secondaryInk,
         @ViewBuilder leading: () -> Leading) {
        self.leading = leading()
        self.title = title
        self.subtitle = subtitle
        self.value = value
        self.detail = detail
        self.detailColor = detailColor
    }

    var body: some View {
        HStack(spacing: CPSpace.sm) {
            leading
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: CPSpace.xs)
            VStack(alignment: .trailing, spacing: 3) {
                if let value {
                    Text(value)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .cpNumericTransition(text: value)
                        .foregroundColor(CPColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                if let detail {
                    Text(detail)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .cpNumericTransition(text: detail)
                        .foregroundColor(detailColor)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .modifier(CoinPilotAppearRise(distance: 6))
        .accessibilityElement(children: .combine)
    }
}

extension CPListRow where Leading == CPSymbolTile {
    init(symbol: String, tint: Color = CPColor.blue, title: String, subtitle: String? = nil,
         value: String? = nil, detail: String? = nil, detailColor: Color = CPColor.secondaryInk) {
        self.init(title: title, subtitle: subtitle, value: value, detail: detail, detailColor: detailColor) {
            CPSymbolTile(symbol: symbol, tint: tint)
        }
    }
}

/// Tinted rounded icon used as a list-row avatar.
struct CPSymbolTile: View {
    let symbol: String
    var tint: Color = CPColor.blue
    var size: CGFloat = 38

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundColor(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: CPRadius.sm, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Tinted ticker avatar for symbols (coins, stocks).
struct CoinAvatar: View {
    let coin: String?
    var size: CGFloat = 36

    private static let palette: [Color] = [
        CPColor.blue,
        Color(red: 0.30, green: 0.62, blue: 0.93),
        Color(red: 0.11, green: 0.66, blue: 0.48),
        Color(red: 0.86, green: 0.55, blue: 0.20),
        Color(red: 0.56, green: 0.45, blue: 0.87),
        Color(red: 0.88, green: 0.40, blue: 0.45),
        Color(red: 0.24, green: 0.63, blue: 0.71)
    ]

    private var ticker: String { CoinPilotFormatting.ticker(coin ?? "") }

    private var tint: Color {
        var hash = 0
        for scalar in ticker.unicodeScalars { hash = (hash &* 31 &+ Int(scalar.value)) & 0x7fffffff }
        return Self.palette[hash % Self.palette.count]
    }

    var body: some View {
        Text(ticker.isEmpty ? "?" : String(ticker.prefix(1)))
            .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
            .foregroundColor(.white)
            .frame(width: size, height: size)
            .background(tint)
            .clipShape(Circle())
            .accessibilityHidden(true)
    }
}

// MARK: - Badge

enum CPTone {
    case neutral, info, positive, warning, danger

    var color: Color {
        switch self {
        case .neutral: return CPColor.secondaryInk
        case .info: return CPColor.blue
        case .positive: return CPColor.green
        case .warning: return CPColor.amber
        case .danger: return CPColor.red
        }
    }
}

struct CPBadge: View {
    let text: String
    var tone: CPTone = .neutral
    var symbol: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            }
            Text(text).lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundColor(tone.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tone.color.opacity(0.11))
        .clipShape(Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Unmistakable "실전" marker for the LIVE workspace.
struct CPLiveIndicator: View {
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Color.white).frame(width: 6, height: 6)
            Text(compact ? "실전" : "실전 · 실제 자금")
        }
        .font(.caption2.weight(.bold))
        .foregroundColor(.white)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(CPColor.redFill)
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("실전 작업공간. 실제 자금이 사용됩니다")
    }
}

/// Running/stopped/unknown state chip shared by every engine.
struct CPRunStateBadge: View {
    let isRunning: Bool?
    var pausedReason: String? = nil

    var body: some View {
        if isRunning == true, let pausedReason {
            CPBadge(text: pausedReason, tone: .warning, symbol: "pause.fill")
        } else if isRunning == true {
            CPBadge(text: "실행 중", tone: .positive, symbol: "circle.fill")
        } else if isRunning == false {
            CPBadge(text: "정지", tone: .neutral, symbol: "stop.fill")
        } else {
            CPBadge(text: "확인 중", tone: .neutral)
        }
    }
}

// MARK: - Engine status

/// Engine name + run state + last run + start/stop.
struct CPEngineStatus: View {
    let name: String
    let symbol: String
    let isRunning: Bool?
    var detail: String? = nil
    var lastRun: String? = nil
    var pausedReason: String? = nil
    var isLive = false
    var actionEnabled = true
    var onToggle: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: CPSpace.sm) {
            CPSymbolTile(symbol: symbol, tint: isRunning == true ? CPColor.green : CPColor.secondaryInk)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                        .lineLimit(1)
                    if isLive { CPLiveIndicator(compact: true) }
                }
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let lastRun {
                    Text(lastRun)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: CPSpace.xs)
            VStack(alignment: .trailing, spacing: 6) {
                CPRunStateBadge(isRunning: isRunning, pausedReason: pausedReason)
                if let onToggle, isRunning != nil {
                    Button(isRunning == true ? "정지" : "시작", action: onToggle)
                        .buttonStyle(CoinPilotCompactButtonStyle(tint: isRunning == true ? CPColor.secondaryInk : (isLive ? CPColor.red : CPColor.blue)))
                        .disabled(!actionEnabled)
                        .accessibilityLabel("\(name) \(isRunning == true ? "정지" : "시작")")
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Segmented

struct CPSegmented<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(options, id: \.0) { option in
                Text(option.1).tag(option.0)
            }
        }
        .pickerStyle(SegmentedPickerStyle())
        .labelsHidden()
        .accessibilityLabel(title)
    }
}

// MARK: - Notice

struct CPNotice: View {
    let text: String
    var tone: CPTone = .warning
    var symbol: String? = nil

    private var resolvedSymbol: String {
        if let symbol { return symbol }
        switch tone {
        case .info, .neutral: return "info.circle.fill"
        case .positive: return "checkmark.circle.fill"
        case .warning, .danger: return "exclamationmark.triangle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: resolvedSymbol)
                .foregroundColor(tone.color)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundColor(CPColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.color.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: CPRadius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Legacy notice API; renders the shared Notice banner with the given tint.
struct InlineNotice: View {
    let text: String
    let color: Color
    var symbol: String = "exclamationmark.circle.fill"

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: symbol)
                .foregroundColor(color)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundColor(CPColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: CPRadius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Empty state

struct CPEmptyState: View {
    let symbol: String
    let title: String
    var message: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: CPSpace.sm) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .semibold))
                .foregroundColor(CPColor.blue)
                .frame(width: 60, height: 60)
                .background(CPColor.blue.opacity(0.09))
                .clipShape(Circle())
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
                .foregroundColor(CPColor.ink)
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundColor(CPColor.secondaryInk)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, CPSpace.md)
        .accessibilityElement(children: .contain)
    }
}

struct EmptyMessage: View {
    let text: String
    var image: String? = nil
    var actionTitle: String? = nil
    var isActionDisabled = false
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 10) {
            if let image {
                Image(image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 92, height: 92)
                    .accessibilityHidden(true)
            }
            Text(text)
                .font(.subheadline)
                .foregroundColor(CPColor.secondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(isActionDisabled)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

// MARK: - Confirmation sheet

/// A confirmation step presented as a bottom sheet (iOS) or modal (Mac).
struct CPConfirmation: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let confirmTitle: String
    var isDestructive = false
    var isLive = false
    let action: () -> Void
}

struct CPConfirmSheet: View {
    let confirmation: CPConfirmation
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: CPSpace.md) {
            Capsule()
                .fill(CPColor.line)
                .frame(width: 38, height: 5)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
            if confirmation.isLive { CPLiveIndicator() }
            Text(confirmation.title)
                .font(CPFont.title)
                .foregroundColor(CPColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(confirmation.message)
                .font(.subheadline)
                .foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack(spacing: CPSpace.xs) {
                Button("취소") { dismiss() }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                Button(confirmation.confirmTitle) {
                    dismiss()
                    confirmation.action()
                }
                .buttonStyle(CoinPilotPrimaryButtonStyle(tint: confirmation.isDestructive ? CPColor.redFill : CPColor.blueFill))
            }
        }
        .padding(CPSpace.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CPColor.surface.ignoresSafeArea())
        .cpConfirmSheetSizing()
    }
}

extension View {
    /// Presents a `CPConfirmation` as the shared confirmation sheet.
    func cpConfirmationSheet(_ item: Binding<CPConfirmation?>) -> some View {
        sheet(item: item) { CPConfirmSheet(confirmation: $0) }
    }

    @ViewBuilder
    fileprivate func cpConfirmSheetSizing() -> some View {
        #if os(macOS)
        frame(minWidth: 420, idealWidth: 460, minHeight: 260, idealHeight: 300)
        #else
        if #available(iOS 16.0, *) {
            presentationDetents([.height(340), .medium])
        } else {
            self
        }
        #endif
    }
}

// MARK: - Text helpers

struct FieldTitle: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.body.weight(.semibold))
            .foregroundColor(CPColor.ink)
    }
}

struct SectionHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.headline.weight(.bold))
            .foregroundColor(CPColor.ink)
            .cpTextReveal()
    }
}

struct FeatureMenuRow: View {
    let title: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            CPSymbolTile(symbol: symbol, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundColor(CPColor.ink)
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundColor(CPColor.secondaryInk).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 7)
        .modifier(CoinPilotAppearRise(distance: 6))
    }
}

/// 홈 빠른 액션 아이콘 칩 — 틴트 아이콘 + 짧은 라벨.
struct HomeQuickActionContent: View {
    let title: String
    let symbol: String
    let tint: Color

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 48, height: 48)
                .background(tint.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: CPRadius.md, style: .continuous))
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundColor(CPColor.ink)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
    }
}

struct HomeQuickAction: View {
    let title: String
    let symbol: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HomeQuickActionContent(title: title, symbol: symbol, tint: tint)
        }
        .buttonStyle(CoinPilotPressableButtonStyle(haptic: .light))
        .accessibilityLabel(title)
    }
}

struct SettingsRow: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundColor(CPColor.secondaryInk)
                .frame(width: 23)
            Text(title)
                .font(.body)
                .foregroundColor(CPColor.secondaryInk)
            Spacer(minLength: 10)
            Text(value)
                .font(.body.weight(.medium))
                .foregroundColor(CPColor.ink)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }
}

struct PaperEvidenceRow: View {
    let title: String
    let value: String
    let tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
            Spacer(minLength: 6)
            Text(value)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundColor(tint)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
    }
}

struct MetadataLine: View {
    let text: String

    private var values: [String] {
        text.replacingOccurrences(of: " • ", with: " · ")
            .components(separatedBy: " · ").filter { !$0.isEmpty }
    }

    private var horizontal: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            ForEach(Array(values.enumerated()), id: \.offset) { item in
                Text(item.element).fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var vertical: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(values.enumerated()), id: \.offset) { item in
                Text(item.element).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var body: some View {
        Group {
            if #available(iOS 16.0, macOS 13.0, *) {
                ViewThatFits(in: .horizontal) { horizontal; vertical }
            } else {
                vertical
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Thin divider in the line colour.
struct CPDivider: View {
    var body: some View {
        Rectangle().fill(CPColor.line).frame(height: 1).accessibilityHidden(true)
    }
}

/// P&L colour (Korean convention): gains up/red, losses down/blue.
func profitColor(_ value: Double?) -> Color {
    CPColor.pnl(value)
}

// MARK: - Page scaffold

extension View {
    /// Standard scrolling page: gutters, paper background, readable width.
    func cpPage() -> some View {
        padding(.horizontal, CPSpace.page)
            .padding(.top, 10)
            .padding(.bottom, 34)
    }
}
