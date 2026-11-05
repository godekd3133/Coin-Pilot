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
                    .font(.system(size: displaySize, weight: .bold))
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
        HStack(alignment: .firstTextBaseline, spacing: CPSpace.sm) {
            Text(item.label)
                .font(.subheadline)
                .foregroundColor(CPColor.secondaryInk)
                .lineLimit(1)
            Spacer(minLength: CPSpace.xs)
            Text(item.value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundColor(item.tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}

/// Label/value rows separated by dividers (no tiles inside the card).
/// `columns` is kept for source compatibility and ignored.
struct CPStatGrid: View {
    let items: [CPStatItem]
    var columns = 2

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { CPDivider() }
                CPStat(item: item)
            }
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
                        .foregroundColor(CPColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                if let detail {
                    Text(detail)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundColor(detailColor)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
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

/// Former tinted icon avatar. Rows no longer carry a decorative icon, so this
/// renders nothing (an EmptyView takes no space or spacing in a stack).
struct CPSymbolTile: View {
    let symbol: String
    var tint: Color = CPColor.blue
    var size: CGFloat = 38

    var body: some View { EmptyView() }
}

/// Ticker monogram: one neutral style for every symbol (no per-ticker hues).
struct CoinAvatar: View {
    let coin: String?
    var size: CGFloat = 36

    private var ticker: String { CoinPilotFormatting.ticker(coin ?? "") }

    var body: some View {
        Text(ticker.isEmpty ? "?" : String(ticker.prefix(1)))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundColor(CPColor.secondaryInk)
            .frame(width: size, height: size)
            .background(CPColor.surface2)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
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

    /// Plain status text in the tone colour (no capsule, no icon).
    var body: some View {
        Text(text)
            .lineLimit(1)
            .font(.caption.weight(.semibold))
            .foregroundColor(tone.color)
    }
}

/// Unmistakable "실전" marker for the LIVE workspace.
struct CPLiveIndicator: View {
    var compact = false

    var body: some View {
        Text(compact ? "실전" : "실전 · 실제 자금")
            .font(.caption2.weight(.bold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(CPColor.redFill)
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
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
            CPBadge(text: pausedReason, tone: .warning)
        } else if isRunning == true {
            CPBadge(text: "실행 중", tone: .positive)
        } else if isRunning == false {
            CPBadge(text: "정지", tone: .neutral)
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
        CPNoticeBody(text: text, color: tone.color)
    }
}

/// Notice layout: a coloured left rule and plain text (no tinted panel, no icon).
struct CPNoticeBody: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundColor(CPColor.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 2)
            .padding(.leading, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(color).frame(width: 3).accessibilityHidden(true), alignment: .leading)
    }
}

/// Legacy notice API; renders the shared Notice banner with the given tint.
struct InlineNotice: View {
    let text: String
    let color: Color
    var symbol: String = "exclamationmark.circle.fill"

    var body: some View {
        CPNoticeBody(text: text, color: color)
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
        VStack(alignment: .leading, spacing: CPSpace.xs) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(CPColor.ink)
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, CPSpace.xs)
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
        // `image` is ignored: empty states are one line of text, no illustration.
        VStack(alignment: .leading, spacing: 10) {
            Text(text)
                .font(.subheadline)
                .foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(isActionDisabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
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
    }
}

struct FeatureMenuRow: View {
    let title: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
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
    }
}

/// 홈 빠른 액션 — 텍스트 버튼(아이콘 칩 없음). `symbol`/`tint`는 호환용.
struct HomeQuickActionContent: View {
    let title: String
    let symbol: String
    let tint: Color

    var body: some View {
        Text(title)
            .font(.footnote.weight(.medium))
            .foregroundColor(CPColor.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(
                RoundedRectangle(cornerRadius: CPRadius.sm, style: .continuous)
                    .stroke(CPColor.line, lineWidth: 1)
            )
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
        .buttonStyle(CoinPilotPressableButtonStyle())
        .accessibilityLabel(title)
    }
}

struct SettingsRow: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
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
