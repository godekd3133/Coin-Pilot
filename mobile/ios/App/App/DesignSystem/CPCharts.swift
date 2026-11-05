import SwiftUI

struct CoinPilotHistoryChart: View {
    let points: [CoinPilotHistoryPoint]
    var reference: Double? = nil
    var period: CoinPilotHistoryPeriod = .day
    var emptyMessage: String = "이 기간에 저장된 자산 기록이 없습니다."

    @State private var inspectedIndex: Int?

    /// 평가액이 있는 포인트만 원래 인덱스와 함께 모읍니다.
    /// 빈 포인트가 끼어 있으면 선을 잇지 않고 끊어서 결측 구간이 보이게 합니다.
    private var valuedPoints: [(index: Int, point: CoinPilotHistoryPoint, value: Double)] {
        points.enumerated().compactMap { offset, point in
            guard let value = point.totalAssets, value.isFinite else { return nil }
            return (index: offset, point: point, value: value)
        }
    }

    private var segments: [[(index: Int, value: Double)]] {
        var result: [[(index: Int, value: Double)]] = []
        for item in valuedPoints {
            if result.last?.last?.index == item.index - 1 {
                result[result.count - 1].append((index: item.index, value: item.value))
            } else {
                result.append([(index: item.index, value: item.value)])
            }
        }
        return result
    }

    private var values: [Double] { valuedPoints.map(\.value) }

    var body: some View {
        Group {
            if valuedPoints.count >= 2 {
                graph
                    .frame(height: 152)
            } else if let record = valuedPoints.first {
                VStack(alignment: .leading, spacing: 6) {
                    Text("이 기간의 자산 기록 1개")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                    Text(CoinPilotFormatting.won(record.value))
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundColor(CPColor.ink)
                    Text(CoinPilotFormatting.dateTime(record.point.timestamp))
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                    Text("기록 2개부터 그래프 표시")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            } else {
                Text(emptyMessage)
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(valuedPoints.count >= 2 ? "자산 기록 그래프" : "자산 기록")
        .accessibilityValue(accessibilitySummary)
        .accessibilityHint(valuedPoints.count >= 2
            ? "길게 누른 뒤 좌우로 움직이면 각 시점의 총자산을 확인할 수 있습니다."
            : "")
    }

    private var graph: some View {
        VStack(spacing: 6) {
            GeometryReader { geometry in
                if values.count >= 2 {
                    let bounds = valueBounds(values)
                    ZStack(alignment: .topLeading) {
                        VStack(spacing: 0) {
                            ForEach(0..<3, id: \.self) { _ in
                                Divider().overlay(CPColor.line.opacity(0.7))
                                Spacer(minLength: 0)
                            }
                        }
                        .padding(.vertical, 8)
                        ForEach(Array(segments.enumerated()), id: \.offset) { segment in
                            linePath(segment: segment.element, bounds: bounds, size: geometry.size)
                                .stroke(CPColor.blue, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
                        }
                        if let reference, reference.isFinite,
                           reference > bounds.lowerBound, reference < bounds.upperBound {
                            let referenceY = yPosition(reference, bounds: bounds, height: geometry.size.height)
                            Path { path in
                                path.move(to: CGPoint(x: 0, y: referenceY))
                                path.addLine(to: CGPoint(x: geometry.size.width, y: referenceY))
                            }
                            .stroke(CPColor.secondaryInk.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            Text("기준 \(CoinPilotFormatting.compactWon(reference))")
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(CPColor.surface.opacity(0.85))
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                                .position(x: geometry.size.width - 34, y: referenceY - 9)
                        }
                        if let lastPoint = valuedPoints.last {
                            Circle()
                                .fill(CPColor.blue)
                                .frame(width: 7, height: 7)
                                .overlay(Circle().stroke(CPColor.surface, lineWidth: 2))
                                .position(
                                    x: min(max(xPosition(lastPoint.index, width: geometry.size.width), 4), geometry.size.width - 4),
                                    y: yPosition(lastPoint.value, bounds: bounds, height: geometry.size.height)
                                )
                        }
                        if let inspectedIndex,
                           let inspected = valuedPoints.first(where: { $0.index == inspectedIndex }) {
                            let inspectedX = xPosition(inspected.index, width: geometry.size.width)
                            Path { path in
                                path.move(to: CGPoint(x: inspectedX, y: 0))
                                path.addLine(to: CGPoint(x: inspectedX, y: geometry.size.height))
                            }
                            .stroke(CPColor.secondaryInk.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            Circle()
                                .fill(CPColor.blue)
                                .frame(width: 9, height: 9)
                                .overlay(Circle().stroke(CPColor.surface, lineWidth: 2))
                                .position(
                                    x: min(max(inspectedX, 5), geometry.size.width - 5),
                                    y: yPosition(inspected.value, bounds: bounds, height: geometry.size.height)
                                )
                            MetadataLine(text: "\(CoinPilotFormatting.won(inspected.value)) · \(CoinPilotFormatting.historyAxisLabel(inspected.point.timestamp, period: period))")
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundColor(CPColor.ink)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(CPColor.surface)
                                .clipShape(Capsule())
                                .overlay(Capsule().stroke(CPColor.line, lineWidth: 1))
                                .position(x: min(max(inspectedX, 76), geometry.size.width - 76), y: 11)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(CoinPilotFormatting.compactWon(values.max()))
                                .font(.caption2.monospacedDigit())
                                .foregroundColor(CPColor.secondaryInk)
                            Spacer(minLength: 0)
                            Text(CoinPilotFormatting.compactWon(values.min()))
                                .font(.caption2.monospacedDigit())
                                .foregroundColor(CPColor.secondaryInk)
                        }
                        .padding(4)
                        if inspectedIndex == nil, let lastValue = values.last {
                            Text("최근 \(CoinPilotFormatting.compactWon(lastValue))")
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundColor(CPColor.ink)
                                .frame(maxWidth: .infinity, alignment: .topTrailing)
                                .padding(4)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        LongPressGesture(minimumDuration: 0.25)
                            .sequenced(before: DragGesture(minimumDistance: 0))
                            .onChanged { value in
                                if case .second(true, let drag) = value, let location = drag?.location {
                                    inspectedIndex = nearestValuedIndex(x: location.x, width: geometry.size.width)
                                }
                            }
                            .onEnded { _ in inspectedIndex = nil }
                    )
                }
            }
            if valuedPoints.count >= 2 {
                HStack {
                    Text(CoinPilotFormatting.historyAxisLabel(valuedPoints.first?.point.timestamp, period: period))
                    Spacer()
                    Text(CoinPilotFormatting.historyAxisLabel(valuedPoints.last?.point.timestamp, period: period))
                }
                .font(.caption2)
                .foregroundColor(CPColor.secondaryInk)
            }
        }
    }

    private func nearestValuedIndex(x: CGFloat, width: CGFloat) -> Int? {
        guard width > 0, !valuedPoints.isEmpty else { return nil }
        return valuedPoints.min(by: {
            abs(xPosition($0.index, width: width) - x) < abs(xPosition($1.index, width: width) - x)
        })?.index
    }

    private var accessibilitySummary: String {
        guard let first = values.first, let last = values.last else {
            return emptyMessage
        }
        if valuedPoints.count == 1, let record = valuedPoints.first {
            return "이 기간의 자산 기록 1개. 총자산 \(CoinPilotFormatting.won(record.value)), \(CoinPilotFormatting.dateTime(record.point.timestamp))."
        }
        var summary = "첫 기록 총자산 \(CoinPilotFormatting.won(first)), 최근 기록 총자산 \(CoinPilotFormatting.won(last))"
        if let minimum = values.min(), let maximum = values.max() {
            summary += ", 최저 \(CoinPilotFormatting.won(minimum)), 최고 \(CoinPilotFormatting.won(maximum))"
        }
        if segments.count > 1 {
            summary += ", 평가액이 없는 구간 \(segments.count - 1)곳"
        }
        if points.contains(where: { $0.valuationStatus == "unknown_legacy" }) {
            summary += ". 일부 과거 기록의 평가 근거를 확인할 수 없습니다."
        }
        return summary
    }

    private func xPosition(_ index: Int, width: CGFloat) -> CGFloat {
        width * CGFloat(index) / CGFloat(max(points.count - 1, 1))
    }

    private func yPosition(_ value: Double, bounds: ClosedRange<Double>, height: CGFloat) -> CGFloat {
        let spread = max(bounds.upperBound - bounds.lowerBound, 1)
        return height - 10 - CGFloat((value - bounds.lowerBound) / spread) * max(height - 20, 1)
    }

    private func linePath(segment: [(index: Int, value: Double)], bounds: ClosedRange<Double>, size: CGSize) -> Path {
        var path = Path()
        for (position, point) in segment.enumerated() {
            let x = xPosition(point.index, width: size.width)
            let y = yPosition(point.value, bounds: bounds, height: size.height)
            if position == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }

    private func filledPath(segment: [(index: Int, value: Double)], bounds: ClosedRange<Double>, size: CGSize) -> Path {
        var path = linePath(segment: segment, bounds: bounds, size: size)
        if let last = segment.last {
            path.addLine(to: CGPoint(x: xPosition(last.index, width: size.width), y: size.height))
        }
        if let first = segment.first {
            path.addLine(to: CGPoint(x: xPosition(first.index, width: size.width), y: size.height))
        }
        path.closeSubpath()
        return path
    }

    private func valueBounds(_ values: [Double]) -> ClosedRange<Double> {
        let minimum = values.min() ?? 0
        let maximum = values.max() ?? 0
        if minimum == maximum { return (minimum - 1)...(maximum + 1) }
        let padding = (maximum - minimum) * 0.06
        return (minimum - padding)...(maximum + padding)
    }
}

struct CoinPilotAllocationSlice: Identifiable {
    let label: String
    let weight: Double
    let value: Double?
    let tint: Color

    var id: String { label }
}

struct CoinPilotAllocationBar: View {
    let slices: [CoinPilotAllocationSlice]

    /// Ink shades only; slices are told apart by their labels, not by hue.
    private static let assetTints: [Color] = [
        CPColor.ink.opacity(0.85),
        CPColor.ink.opacity(0.62),
        CPColor.ink.opacity(0.42),
        CPColor.ink.opacity(0.26)
    ]
    private static let krwTint = CPColor.line
    private static let otherTint = CPColor.ink.opacity(0.16)

    /// 원화 + 평가액이 확인된 보유 코인을 총자산 비중 순으로 정리합니다.
    /// 시세를 확인하지 못한 코인 수를 반환해 범례에서 따로 표시합니다.
    static func slices(
        krwBalance: Double?,
        positions: [CoinPilotPosition],
        totalAssets: Double?
    ) -> (slices: [CoinPilotAllocationSlice], unvaluedCount: Int) {
        guard let total = totalAssets, total.isFinite, total > 0 else { return ([], 0) }
        var slices: [CoinPilotAllocationSlice] = []
        if let krw = krwBalance, krw.isFinite, krw > 0 {
            slices.append(CoinPilotAllocationSlice(
                label: CoinPilotFormatting.quoteAssetLabel, weight: krw / total * 100, value: krw, tint: krwTint
            ))
        }
        let valued = positions
            .filter { ($0.currentValue ?? 0) > 0 }
            .sorted { ($0.currentValue ?? 0) > ($1.currentValue ?? 0) }
        let unvaluedCount = positions.count - valued.count
        let shown = Array(valued.prefix(assetTints.count))
        let rest = valued.dropFirst(assetTints.count)
        for (index, position) in shown.enumerated() {
            slices.append(CoinPilotAllocationSlice(
                label: CoinPilotFormatting.ticker(position.coin),
                weight: (position.currentValue ?? 0) / total * 100,
                value: position.currentValue,
                tint: assetTints[index]
            ))
        }
        let restValue = rest.reduce(0) { $0 + ($1.currentValue ?? 0) }
        if restValue > 0 {
            slices.append(CoinPilotAllocationSlice(
                label: "기타 \(rest.count)개", weight: restValue / total * 100, value: restValue, tint: otherTint
            ))
        }
        return (slices, unvaluedCount)
    }

    /// 서버 포트폴리오 분석 응답의 비중 필드로 자산 배분을 그립니다.
    static func slices(summary: [String: Any], holdings: [[String: Any]]) -> [CoinPilotAllocationSlice] {
        func number(_ value: Any?) -> Double? {
            guard let value, !(value is NSNull) else { return nil }
            if let number = value as? NSNumber { return number.doubleValue }
            if let string = value as? String { return Double(string) }
            return nil
        }
        var slices: [CoinPilotAllocationSlice] = []
        if let krwWeight = number(summary["krwWeight"]), krwWeight > 0 {
            slices.append(CoinPilotAllocationSlice(
                label: CoinPilotFormatting.quoteAssetLabel, weight: krwWeight, value: number(summary["krwBalance"]), tint: krwTint
            ))
        }
        let valued = holdings
            .filter { (number($0["weight"]) ?? 0) > 0 }
            .sorted { (number($0["weight"]) ?? 0) > (number($1["weight"]) ?? 0) }
        let shown = Array(valued.prefix(assetTints.count))
        let rest = valued.dropFirst(assetTints.count)
        for (index, holding) in shown.enumerated() {
            slices.append(CoinPilotAllocationSlice(
                label: CoinPilotFormatting.ticker(holding["coin"] as? String),
                weight: number(holding["weight"]) ?? 0,
                value: number(holding["currentValue"]),
                tint: assetTints[index]
            ))
        }
        let restWeight = rest.reduce(0) { $0 + (number($1["weight"]) ?? 0) }
        let restValue = rest.reduce(0) { $0 + (number($1["currentValue"]) ?? 0) }
        if restWeight > 0 {
            slices.append(CoinPilotAllocationSlice(
                label: "기타 \(rest.count)개", weight: restWeight, value: restValue > 0 ? restValue : nil, tint: otherTint
            ))
        }
        return slices
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geometry in
                let spacing: CGFloat = 2
                HStack(spacing: spacing) {
                    ForEach(slices) { slice in
                        if slice.weight > 0 {
                            Rectangle()
                                .fill(slice.tint)
                                .frame(width: max(2, geometry.size.width * CGFloat(slice.weight / 100) - spacing))
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("자산 배분")
                .accessibilityValue(slices.map { "\($0.label) \(Int($0.weight.rounded()))%" }.joined(separator: ", "))
            }
            .frame(height: 8)
            VStack(spacing: 7) {
                ForEach(slices) { slice in
                    HStack(spacing: 8) {
                        Rectangle()
                            .fill(slice.tint)
                            .frame(width: 8, height: 8)
                        Text(slice.label)
                            .font(.caption.weight(.medium))
                            .foregroundColor(CPColor.ink)
                        Spacer(minLength: 8)
                        Text(CoinPilotFormatting.percent(slice.weight, signed: false, unavailable: "비중 미제공"))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundColor(CPColor.secondaryInk)
                        Text(CoinPilotFormatting.won(slice.value, unavailable: "평가액 미제공"))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundColor(CPColor.ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
            }
        }
    }
}

extension CoinPilotAllocationBar {
    /// Cross-asset allocation (코인 · 주식 · 포트폴리오 · 현금): ink shades, no hues.
    static let categoryTints: [Color] = [
        CPColor.ink.opacity(0.85),
        CPColor.ink.opacity(0.55),
        CPColor.ink.opacity(0.3),
        CPColor.line
    ]
}

/// Minimal line for list rows and cards. Missing/flat series render a flat
/// muted line so the layout never jumps.
struct CPSparkline: View {
    let values: [Double]
    var tint: Color? = nil
    var lineWidth: CGFloat = 1.6

    private var resolvedTint: Color {
        if let tint { return tint }
        guard let first = values.first, let last = values.last else { return CPColor.secondaryInk }
        return CPColor.pnl(last - first)
    }

    var body: some View {
        GeometryReader { proxy in
            CPLinePath(values: values, size: proxy.size, closed: false)
                .stroke(resolvedTint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }
}

/// Line chart (the name is historical: there is no fill under the line).
struct CPAreaChart: View {
    let values: [Double]
    var tint: Color = CPColor.blue

    var body: some View {
        GeometryReader { proxy in
            CPLinePath(values: values, size: proxy.size, closed: false)
                .stroke(tint, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }
}

struct CPLinePath: Shape {
    let values: [Double]
    let size: CGSize
    let closed: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let finite = values.filter(\.isFinite)
        guard finite.count >= 2, let minimum = finite.min(), let maximum = finite.max() else {
            path.move(to: CGPoint(x: 0, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
        let range = maximum - minimum
        let step = rect.width / CGFloat(finite.count - 1)
        let inset: CGFloat = 2
        let height = max(1, rect.height - inset * 2)
        func point(_ index: Int, _ value: Double) -> CGPoint {
            let ratio = range > 0 ? (value - minimum) / range : 0.5
            return CGPoint(x: CGFloat(index) * step, y: inset + height * CGFloat(1 - ratio))
        }
        path.move(to: point(0, finite[0]))
        for (index, value) in finite.enumerated().dropFirst() {
            path.addLine(to: point(index, value))
        }
        if closed {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: 0, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}
