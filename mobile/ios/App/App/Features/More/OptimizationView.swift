import SwiftUI

struct CoinPilotOptimizationView: View {
    @ObservedObject var store: CoinPilotStore

    private let intervals: [(String, Int)] = [
        ("1시간", 3_600_000), ("2시간", 7_200_000), ("3시간", 10_800_000),
        ("6시간", 21_600_000), ("12시간", 43_200_000), ("24시간", 86_400_000)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let reason = store.optimizationBlockReason { InlineNotice(text: reason, color: CPColor.amber) }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "자동 후보 비교")
                            Spacer()
                            Button(store.refreshingFeatureGroups.contains("optimization") ? "불러오는 중" : "새로고침") {
                                Task { _ = await store.loadOptimization() }
                            }
                                .font(.caption.weight(.semibold))
                                .disabled(!store.canOperate || store.refreshingFeatureGroups.contains("optimization"))
                        }
                        CoinPilotFeatureFreshnessLine(
                            lastSuccessfulAt: store.featureLastSuccessfulAt["optimization"],
                            error: store.featureMessages["optimization"]
                        )
                        if store.optimizationSettings["isRunning"] as? Bool == true {
                            Text("후보 비교 중").font(.subheadline).foregroundColor(CPColor.blue)
                        } else if let outcome = store.optimizationSettings["lastOutcome"] as? [String: Any],
                                  let status = outcome["status"] as? String {
                            switch status {
                            case "COMPLETED": Text("후보 비교 완료").foregroundColor(CPColor.green)
                            case "INSUFFICIENT_DATA":
                                Text("비교할 가격 기록이 부족합니다 (\(outcome["candleCount"] as? Int ?? 0)/\(outcome["minimumCandleCount"] as? Int ?? 250)).")
                                    .foregroundColor(CPColor.secondaryInk)
                            case "FAILED", "INTERRUPTED": Text(outcome["message"] as? String ?? "후보 비교를 완료하지 못했습니다.").foregroundColor(CPColor.amber)
                            default: EmptyView()
                            }
                        }
                        Toggle("정한 간격으로 후보 비교", isOn: Binding(
                            get: { store.optimizationSettings["enabled"] as? Bool ?? false },
                            set: { value in Task { _ = await store.setOptimizationEnabled(value) } }
                        ))
                        .tint(CPColor.blue)
                        .disabled(store.optimizationBlockReason != nil)
                        Text("비교 결과는 자동 적용 안 됨. 검증 후 직접 적용.")
                            .font(.caption).foregroundColor(CPColor.secondaryInk)
                        Picker("비교 간격", selection: Binding(
                            get: { store.optimizationSettings["interval"] as? Int ?? 21_600_000 },
                            set: { value in Task { _ = await store.setOptimizationInterval(value) } }
                        )) {
                            ForEach(Array(intervals.enumerated()), id: \.offset) { item in
                                Text(item.element.0).tag(item.element.1)
                            }
                        }
                        .pickerStyle(MenuPickerStyle())
                        .disabled(store.optimizationBlockReason != nil)
                        if let nextRun = store.optimizationSettings["nextRun"] as? String {
                            AnalyticsMetric(title: "다음 비교", value: CoinPilotFormatting.dateTime(nextRun))
                        }
                        Button(store.isRunningFeatureAction ? "처리 중" : "지금 후보 비교") {
                            Task { _ = await store.runOptimizationNow() }
                        }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                        .disabled(!store.canOperate || store.isRunningFeatureAction || store.optimizationBlockReason != nil)
                        if let message = store.featureMessages["optimization"] {
                            InlineNotice(text: message, color: CPColor.amber)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "최근 후보 비교")
                        if store.optimizationHistory.isEmpty {
                            EmptyMessage(text: "저장된 비교 기록이 없습니다.")
                        }
                        ForEach(Array(store.optimizationHistory.prefix(12).enumerated()), id: \.offset) { item in
                            let value = item.element
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(value["type"] as? String ?? value["strategy"] as? String ?? "설정 비교")
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(String(describing: value["fitness"] ?? value["score"] ?? "—"))
                                        .font(.caption.monospacedDigit()).foregroundColor(CPColor.secondaryInk)
                                }
                                Text(value["description"] as? String ?? value["message"] as? String ?? "비교 기록")
                                    .font(.caption).foregroundColor(CPColor.secondaryInk).lineLimit(3)
                                Text(CoinPilotFormatting.dateTime(value["timestamp"] as? String ?? value["date"] as? String, unavailable: "시각 미제공"))
                                    .font(.caption2).foregroundColor(CPColor.secondaryInk)
                            }
                            .padding(.vertical, 7)
                            Divider().overlay(CPColor.line)
                        }
                    }
                }
                NativeDisclosureCard(title: "과거 데이터 비교") {
                    VStack(alignment: .leading, spacing: 10) {
                        let rows = store.backtestResults["results"] as? [[String: Any]] ?? store.backtestResults["entries"] as? [[String: Any]] ?? []
                        if rows.isEmpty {
                            EmptyMessage(text: store.backtestResults["message"] as? String ?? "과거 데이터 비교 결과가 없습니다.")
                        }
                        ForEach(Array(rows.prefix(10).enumerated()), id: \.offset) { item in
                            let value = item.element
                            AnalyticsMetric(
                                title: value["coin"] as? String ?? value["strategy"] as? String ?? "후보",
                                value: value["totalReturnPercent"].map { "\($0) %" } ?? value["returnPercent"].map { "\($0) %" } ?? "결과 미제공"
                            )
                        }
                        Text("과거 비교만으로 후보가 실제 주문에 적용되지는 않습니다.")
                            .font(.caption).foregroundColor(CPColor.secondaryInk)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("설정 후보 비교")
        .cpInlineTitle()
        .refreshFeatureWhenVisible(enabled: store.canOperate) { _ = await store.loadOptimizationIfStale() }
    }
}
