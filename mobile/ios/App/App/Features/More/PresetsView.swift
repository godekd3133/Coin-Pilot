import SwiftUI

func coinPilotPresetName(_ preset: [String: Any]) -> String {
    let names = ["aggressive": "높은 투자 비중", "conservative": "낮은 투자 비중",
                 "shortterm": "짧은 지표", "scalping": "스캘핑 설정",
                 "longterm": "긴 지표", "balanced": "기본 지표"]
    return (preset["id"] as? String).flatMap { names[$0] } ?? preset["name"] as? String ?? "전략 프리셋"
}

struct CoinPilotPresetView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var requestedPreset: [String: Any]?
    @State private var appliedPresetID: String?
    @State private var applyingPresetID: String?
    @State private var applicationRequestID: UUID?
    @State private var applicationMessage: String?
    @State private var applicationFailed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let reason = store.tuningBlockReason { InlineNotice(text: reason, color: CPColor.amber) }
                Text("지표와 주문 비중을 함께 바꾸는 설정입니다. 투자 기간이나 손익을 보장하지 않습니다.")
                    .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                CoinPilotFeatureFreshnessLine(
                    lastSuccessfulAt: store.featureLastSuccessfulAt["optimization"],
                    error: store.featureMessages["optimization"]
                )
                if let applicationMessage {
                    InlineNotice(text: applicationMessage, color: applicationFailed ? CPColor.amber : CPColor.green)
                }
                if applyingPresetID == nil, let message = store.tuningMessage, message != applicationMessage {
                    InlineNotice(text: message, color: CPColor.amber)
                }
                if store.investmentPresets.isEmpty {
                    NativeCard {
                        EmptyMessage(text: store.featureMessages["investment-presets"] ?? "서버 프리셋을 불러오는 중입니다.")
                    }
                }
                ForEach(Array(store.investmentPresets.enumerated()), id: \.offset) { item in
                    let preset = item.element
                    CoinPilotPresetCard(
                        preset: preset,
                        store: store,
                        isApplied: appliedPresetID != nil && appliedPresetID == (preset["id"] as? String),
                        isApplying: applyingPresetID != nil && applyingPresetID == (preset["id"] as? String),
                        isApplicationPending: applyingPresetID != nil
                    ) {
                        requestedPreset = preset
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("전략 프리셋")
        .cpInlineTitle()
        .confirmationDialog(
            requestedPreset.map(coinPilotPresetName) ?? "프리셋 적용",
            isPresented: Binding(get: { requestedPreset != nil }, set: { if !$0 { requestedPreset = nil } }),
            titleVisibility: .visible
        ) {
            if let preset = requestedPreset, let id = preset["id"] as? String {
                Button("\(store.activeWorkspace.title) 전략 설정 바꾸기", role: .destructive) {
                    let requestID = UUID()
                    let workspace = store.activeWorkspace
                    let serverAddress = store.serverAddress
                    let name = coinPilotPresetName(preset)
                    resetApplicationFeedback()
                    applicationRequestID = requestID
                    applyingPresetID = id
                    Task {
                        let succeeded = await store.applyInvestmentPreset(id: id)
                        guard applicationRequestID == requestID,
                              store.activeWorkspace == workspace,
                              store.serverAddress == serverAddress else { return }
                        applicationRequestID = nil
                        applyingPresetID = nil
                        applicationFailed = !succeeded
                        if succeeded {
                            appliedPresetID = id
                            applicationMessage = "\(name) 설정을 \(workspace.title) 서버에 적용했습니다.\n\(serverAddress)"
                        } else {
                            applicationMessage = store.featureMessages["preset"] ?? store.tuningMessage
                                ?? "설정 적용 실패. 다시 시도."
                        }
                    }
                }
            }
            Button("취소", role: .cancel) { requestedPreset = nil }
        } message: {
            Text("\(store.activeWorkspace.title) 서버(\(store.serverAddress))의 전략 설정을 이 프리셋으로 바꿉니다. 현재 보유 자산이나 주문 기록은 변경하지 않습니다.")
        }
        .cpOnChange(of: store.activeWorkspace) { _ in resetApplicationFeedback() }
        .cpOnChange(of: store.serverAddress) { _ in resetApplicationFeedback() }
        .refreshFeatureWhenVisible(enabled: store.canOperate) { _ = await store.loadOptimizationIfStale() }
    }

    private func resetApplicationFeedback() {
        requestedPreset = nil
        appliedPresetID = nil
        applyingPresetID = nil
        applicationRequestID = nil
        applicationMessage = nil
        applicationFailed = false
    }
}

struct CoinPilotPresetCard: View {
    let preset: [String: Any]
    @ObservedObject var store: CoinPilotStore
    let isApplied: Bool
    let isApplying: Bool
    let isApplicationPending: Bool
    let onApply: () -> Void

    private var name: String { coinPilotPresetName(preset) }
    private var description: String {
        if ["longterm", "shortterm"].contains(preset["id"] as? String ?? "") {
            return "지표 계산에 사용하는 기간을 바꿉니다. 최대 보유 시간은 별도 설정을 따릅니다."
        }
        return preset["description"] as? String ?? "설정 설명이 없습니다."
    }
    private var riskLevel: Int? { preset["riskLevel"] as? Int }

    private var investmentRatioText: String? {
        guard let config = preset["config"] as? [String: Any],
              let value = (config["investmentRatio"] as? NSNumber)?.doubleValue,
              value.isFinite else { return nil }
        return "1회 투자 비율 \(CoinPilotFormatting.percent(value * 100, signed: false))"
    }

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name).font(.headline.weight(.semibold))
                    Spacer()

                }
                DisclosureGroup("설정값과 설명") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(description).font(.caption).foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        if let config = preset["config"] as? [String: Any] {
                            ForEach([("stopLossPercent", "손절 기준"), ("takeProfitPercent", "익절 기준"), ("rsiPeriod", "RSI 기간")], id: \.0) { field in
                                if let value = (config[field.0] as? NSNumber)?.doubleValue, value.isFinite {
                                    AnalyticsMetric(title: field.1, value: field.0 == "rsiPeriod" ? String(format: "%.0f", value) : CoinPilotFormatting.percent(value, signed: false))
                                }
                            }
                        }
                    }.padding(.top, 8)
                }
                .font(.caption)
                .frame(minHeight: 44)
                if let investmentRatioText {
                    Text(investmentRatioText)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                }
                if isApplied {
                    Text("적용 완료")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CPColor.green)
                }
                Button(action: onApply) {
                    HStack(spacing: 8) {
                        if isApplying { ProgressView().controlSize(.small) }
                        Text(isApplying ? "적용 중…" : isApplied ? "다시 적용" : "이 설정 적용")
                    }
                }
                .buttonStyle(CoinPilotSecondaryButtonStyle())
                .disabled(!store.canOperate || store.tuningBlockReason != nil || store.isRunningFeatureAction || isApplicationPending)
            }
        }
    }
}
