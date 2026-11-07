import SwiftUI

struct CoinPilotResearchDeskView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var requestedPaperAction: Bool?

    private var readinessStatusText: String {
        switch store.strategyReadiness["status"] as? String {
        case "READY": return "검증 자료 준비됨"
        case "NOT_REQUIRED": return "성과 검증은 선택 사항"
        case "BLOCKED": return "자료 확인 필요"
        default: return "상태 확인 필요"
        }
    }

    private var paperIsActive: Bool {
        (store.paperValidationState["active"] as? Bool) ??
        ((store.paperValidationState["status"] as? [String: Any])?["active"] as? Bool) ?? false
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            SectionHeading(title: "전략 준비 상태")
                            Spacer()
                            Button(store.refreshingFeatureGroups.contains("research") ? "확인 중" : "다시 확인") {
                                Task { await store.loadResearchDesk() }
                            }
                                .font(.caption.weight(.semibold))
                                .disabled(!store.canOperate || store.refreshingFeatureGroups.contains("research"))
                        }
                        CoinPilotFeatureFreshnessLine(
                            lastSuccessfulAt: store.featureLastSuccessfulAt["research"],
                            error: store.featureMessages["research"]
                        )
                        if store.strategyReadiness.isEmpty {
                            EmptyMessage(text: store.featureMessages["strategy-readiness"] ?? "서버의 검증 자료를 불러오지 않았습니다.")
                        } else {
                            let gate = store.strategyReadiness["liveGate"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "준비 상태", value: readinessStatusText)
                            AnalyticsMetric(title: "자료 확인", value: store.strategyReadiness["status"] as? String == "NOT_REQUIRED" ? "시작 필수 조건 아님" : store.strategyReadiness["currentEvidence"] as? Bool == true ? "확인 완료" : "확인 필요")
                            if store.activeWorkspace == .live {
                                AnalyticsMetric(title: "실거래 진입", value: store.strategyReadiness["status"] as? String == "NOT_REQUIRED" ? "계좌와 주문 상태 확인 후 시작" : gate["passed"] as? Bool == true ? "서버 조건 통과" : "잠금")
                                Text("실제 주문은 서버의 계좌 동기화와 안전 조건을 별도로 통과해야 합니다.")
                                    .font(.caption).foregroundColor(CPColor.secondaryInk)
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "모의투자 점검 세션")
                        AnalyticsMetric(title: "상태", value: paperIsActive ? "실행 중" : (store.paperValidationState["available"] as? Bool == true ? "중지" : "사용할 수 없음"))
                        AnalyticsMetric(title: "연속성", value: store.paperValidationState["continuityEligible"] as? Bool == true ? "자료 연속" : "검증 필요")
                        if let reason = store.paperValidationState["reason"] as? String {
                            Text(reason).font(.caption).foregroundColor(CPColor.secondaryInk)
                        }
                        if let message = store.featureMessages["paper-validation"] {
                            InlineNotice(text: message, color: CPColor.amber)
                        }
                        if store.activeWorkspace == .paper && store.canOperate {
                            Button(paperIsActive ? "모의 점검 중지" : "모의 점검 시작") { requestedPaperAction = !paperIsActive }
                                .buttonStyle(CoinPilotSecondaryButtonStyle())
                        } else {
                            Text("모의 점검 세션은 모의투자 서버에서만 제어할 수 있습니다.")
                                .font(.caption).foregroundColor(CPColor.secondaryInk)
                        }
                    }
                }
                NativeDisclosureCard(title: "전략 검증") {
                    VStack(alignment: .leading, spacing: 10) {
                        if store.scalpingValidation.isEmpty {
                            EmptyMessage(text: store.featureMessages["validation"] ?? "검증 보고서가 없습니다.")
                        } else {
                            AnalyticsMetric(title: "보고서", value: store.scalpingValidation["available"] as? Bool == true ? "사용 가능" : "자료 없음")
                            AnalyticsMetric(title: "최근 검증 상태", value: store.scalpingValidation["promoted"] as? Bool == true ? "서버에서 별도 승인됨" : "승인 상태 아님")
                            AnalyticsMetric(title: "보고서 생성", value: store.scalpingValidation["generatedAt"] as? String ?? "시각 미제공")
                            if let results = store.scalpingValidation["results"] as? [[String: Any]] {
                                ForEach(Array(results.prefix(8).enumerated()), id: \.offset) { item in
                                    let result = item.element
                                    AnalyticsMetric(
                                        title: result["coin"] as? String ?? result["market"] as? String ?? "종목",
                                        value: result["status"] as? String ?? result["decision"] as? String ?? "결과 확인 필요"
                                    )
                                }
                            }
                        }
                        Text("과거 검증은 실제 체결이나 수익을 보장하지 않습니다.")
                            .font(.caption).foregroundColor(CPColor.secondaryInk)
                    }
                }
                NativeDisclosureCard(title: "전략 연구 자료") {
                    VStack(alignment: .leading, spacing: 10) {
                        if store.strategyResearch.isEmpty {
                            EmptyMessage(text: store.featureMessages["strategy-research"] ?? "전략 연구 자료를 불러오지 않았습니다.")
                        } else {
                            let freshness = store.strategyResearch["reportFreshness"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "자료 상태", value: store.strategyResearch["available"] as? Bool == true ? "자료 있음" : "자료 없음")
                            AnalyticsMetric(title: "생성 시각", value: store.strategyResearch["generatedAt"] as? String ?? "시각 미제공")
                            AnalyticsMetric(title: "자료 최신성", value: freshness["fresh"] as? Bool == true ? "최신" : "확인 필요")
                            AnalyticsMetric(title: "적용 승인", value: store.strategyResearch["promoted"] as? Bool == true ? "서버 승인" : "승인 자료 없음")
                            if let results = store.strategyResearch["results"] as? [[String: Any]] {
                                ForEach(Array(results.prefix(8).enumerated()), id: \.offset) { item in
                                    let value = item.element
                                    AnalyticsMetric(
                                        title: value["coin"] as? String ?? value["market"] as? String ?? "연구 후보",
                                        value: value["status"] as? String ?? value["reason"] as? String ?? "자료 확인 필요"
                                    )
                                }
                            }
                        }
                        Text("연구 후보와 과거 결과는 진단 자료입니다. 서버 주문 조건을 대신 승인하지 않습니다.")
                            .font(.caption).foregroundColor(CPColor.secondaryInk)
                    }
                }
                NativeDisclosureCard(title: "모멘텀 후보 점검") {
                    VStack(alignment: .leading, spacing: 10) {
                        if store.momentumShadow.isEmpty {
                            EmptyMessage(text: store.featureMessages["momentum-shadow"] ?? "후보 점검 자료가 없습니다.")
                        } else {
                            AnalyticsMetric(title: "자료 상태", value: store.momentumShadow["available"] as? Bool == true ? "조회 가능" : "자료 없음")
                            AnalyticsMetric(title: "실거래 승인", value: store.momentumShadow["promoted"] as? Bool == true ? "서버 승인" : "승인하지 않음")
                            let readiness = store.momentumShadow["candidateReadiness"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "후보 판정", value: readiness["status"] as? String ?? readiness["state"] as? String ?? "확인 필요")
                            if let variants = store.momentumShadow["candidateReadinessVariants"] as? [[String: Any]] {
                                ForEach(Array(variants.prefix(8).enumerated()), id: \.offset) { item in
                                    let value = item.element
                                    let result = value["readiness"] as? [String: Any] ?? [:]
                                    AnalyticsMetric(
                                        title: value["label"] as? String ?? "후보",
                                        value: result["status"] as? String ?? result["decision"] as? String ?? "참고 자료"
                                    )
                                }
                            }
                        }
                    }
                }
                NativeDisclosureCard(title: "실거래 실행 기록") {
                    VStack(alignment: .leading, spacing: 10) {
                        if store.liveExecutionEvidence.isEmpty {
                            EmptyMessage(text: store.featureMessages["live-execution-evidence"] ?? "서버 실행 기록을 불러오지 않았습니다.")
                        } else {
                            AnalyticsMetric(title: "기록 상태", value: store.liveExecutionEvidence["available"] as? Bool == true ? "조회 가능" : "조회 자료 없음")
                            AnalyticsMetric(title: "저장 오류", value: store.liveExecutionEvidence["writeError"] as? String ?? "없음")
                            AnalyticsMetric(title: "자료 오류", value: store.liveExecutionEvidence["dataError"] as? String ?? "없음")
                            Text("이 기록은 실거래 체결이 관찰됐다는 사실을 확인하는 용도입니다. 모의 검증과는 별도 자료입니다.")
                                .font(.caption).foregroundColor(CPColor.secondaryInk)
                        }
                    }
                }

            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("연구 데스크")
        .cpInlineTitle()
        .confirmationDialog(
            requestedPaperAction == true ? "모의투자 점검 시작" : "모의투자 점검 중지",
            isPresented: Binding(get: { requestedPaperAction != nil }, set: { if !$0 { requestedPaperAction = nil } }),
            titleVisibility: .visible
        ) {
            if let shouldStart = requestedPaperAction {
                if shouldStart {
                    Button("기록 유지하고 시작") {
                        requestedPaperAction = nil
                        Task { _ = await store.startPaperValidation(reset: false) }
                    }
                    Button("기록 지우고 새로 시작", role: .destructive) {
                        requestedPaperAction = nil
                        Task { _ = await store.startPaperValidation(reset: true) }
                    }
                } else {
                    Button("점검 중지", role: .destructive) {
                        requestedPaperAction = nil
                        Task { _ = await store.stopPaperValidation() }
                    }
                }
            }
            Button("취소", role: .cancel) { requestedPaperAction = nil }
        } message: {
            Text(requestedPaperAction == true
                 ? "모의투자 점검 기록은 전략 검토 자료입니다. 실거래 체결이나 수익을 증명하지 않습니다."
                 : "현재 모의 점검 세션을 중지합니다.")
        }
        .refreshFeatureWhenVisible(enabled: store.canOperate) { await store.loadResearchDeskIfStale() }
    }
}
