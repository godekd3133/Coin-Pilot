import SwiftUI

struct CoinPilotAIDeskView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var sessionName = "시장 신호 기록"
    @State private var providers: Set<String> = ["gpt", "claude"]
    @State private var eventTypes: Set<String> = ["BUY_SIGNAL", "SELL_SIGNAL"]
    @State private var autoConsultEventTypes: Set<String> = ["BUY_SIGNAL", "SELL_SIGNAL"]
    @State private var autoConsult = false
    @State private var cooldownMinutes = 5
    @State private var evaluationMinutes = 5
    @State private var coins = ""
    @State private var consultationProvider = "both"

    private let eventOptions: [(String, String)] = [
        ("BUY_SIGNAL", "매수 신호"), ("SELL_SIGNAL", "매도 신호"),
        ("REBOUND_CANDIDATE", "반등 후보"), ("BREAKING_NEWS", "속보"),
        ("BUNDLE_SUGGESTION", "종목 교체 제안"), ("TRADE_EXECUTED", "거래 완료")
    ]

    private var providersForSession: Set<String> {
        autoConsult ? providers.intersection(store.readyAIProviderIDs) : ["gpt", "claude"]
    }

    private var effectiveConsultationProvider: String {
        if store.canRequestAIConsultation(provider: consultationProvider) { return consultationProvider }
        if store.canRequestAIConsultation(provider: "both") { return "both" }
        return store.readyAIProviderIDs.sorted().first ?? "none"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate {
                    InlineNotice(text: "AI 서비스 상태와 신호 세션을 사용하려면 운영 토큰이 필요합니다.", color: CPColor.amber)
                }
                serviceCard
                sessionCreationCard
                sessionsCard
                signalsCard
                if !store.aiConsultations.isEmpty || (store.aiEffectiveness["actualProviderCompletions"] as? Int ?? 0) > 0 {
                    comparisonCard
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("시장 자문")
        .cpInlineTitle()
        .refreshFeatureWhenVisible(enabled: store.canOperate) { await store.loadAIDeskIfStale() }
    }

    private var comparisonCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                SectionHeading(title: "가격 비교 기록")
                let effectiveness = store.aiEffectiveness
                if effectiveness.isEmpty {
                    EmptyMessage(text: "AI 의견 뒤의 가격 비교 자료가 없습니다.")
                } else {
                    AnalyticsMetric(title: "의견 완료", value: "\(effectiveness["actualProviderCompletions"] as? Int ?? 0)회")
                    AnalyticsMetric(title: "가격 확인", value: "\(effectiveness["evaluatedConsultations"] as? Int ?? 0)건")
                    AnalyticsMetric(title: "충분한 비교 자료", value: effectiveness["sufficientEvidence"] as? Bool == true ? "예" : "아직 부족")
                    let coverage = number(effectiveness["evaluationCoverageRate"])
                    AnalyticsMetric(title: "가격 확인 비율", value: coverage.map { CoinPilotFormatting.percent($0 * 100) } ?? "미제공")
                    Text("가격 방향 비교는 실제 매매 수익률이 아니며, 실제 체결이나 수익을 증명하지 않습니다.")
                        .font(.caption).foregroundColor(CPColor.secondaryInk)
                }
            }
        }
    }

    private var serviceCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SectionHeading(title: "서비스 상태")
                    Spacer()
                    Button(store.refreshingFeatureGroups.contains("ai") ? "불러오는 중" : "새로고침") {
                        Task { await store.loadAIDesk() }
                    }
                        .font(.caption.weight(.semibold))
                        .disabled(!store.canOperate || store.refreshingFeatureGroups.contains("ai"))
                }
                CoinPilotFeatureFreshnessLine(
                    lastSuccessfulAt: store.featureLastSuccessfulAt["ai"],
                    error: store.featureMessages["ai"]
                )
                providerStatus
                Text("AI 의견은 참고용. 자동 주문에 쓰지 않음.")
                    .font(.caption).foregroundColor(CPColor.secondaryInk)
            }
        }
    }

    private var sessionCreationCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "관심 신호 만들기")
                TextField("세션 이름", text: $sessionName).textFieldStyle(.roundedBorder)
                if autoConsult {
                    Text("의견을 받을 서비스")
                        .font(.caption.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
                    Toggle("OpenAI", isOn: providerBinding("gpt"))
                        .font(.subheadline).tint(CPColor.blue)
                        .disabled(!store.readyAIProviderIDs.contains("gpt"))
                    Toggle("Claude", isOn: providerBinding("claude"))
                        .font(.subheadline).tint(CPColor.blue)
                        .disabled(!store.readyAIProviderIDs.contains("claude"))
                }
                TextField("종목 코드 (비우면 전체)", text: $coins)
                    .cpAutocapitalizeCharacters()
                    .cpNoAutocorrection()
                    .textFieldStyle(.roundedBorder)
                ForEach(Array(eventOptions.enumerated()), id: \.offset) { item in
                    let value = item.element.0
                    let label = item.element.1
                    Toggle(label, isOn: Binding(
                        get: { eventTypes.contains(value) },
                        set: { enabled in
                            if enabled { eventTypes.insert(value) } else { eventTypes.remove(value) }
                        }
                    ))
                    .font(.subheadline)
                    .tint(CPColor.blue)
                }
                Toggle("새 신호에 의견 자동 요청", isOn: $autoConsult)
                    .font(.subheadline)
                    .tint(CPColor.blue)
                    .disabled(store.readyAIProviderIDs.isEmpty && !autoConsult)
                    .cpOnChange(of: autoConsult) { enabled in
                        if enabled {
                            providers = providers.intersection(store.readyAIProviderIDs)
                            if providers.isEmpty { providers = store.readyAIProviderIDs }
                        }
                    }
                if autoConsult {
                    Text("AI 의견을 자동 요청할 신호")
                        .font(.caption.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
                    ForEach(Array(eventOptions.enumerated()), id: \.offset) { item in
                        let value = item.element.0
                        let label = item.element.1
                        Toggle(label, isOn: Binding(
                            get: { autoConsultEventTypes.contains(value) },
                            set: { enabled in
                                if enabled { autoConsultEventTypes.insert(value) } else { autoConsultEventTypes.remove(value) }
                            }
                        ))
                        .font(.caption)
                        .tint(CPColor.blue)
                        .disabled(!eventTypes.contains(value))
                    }
                }
                if autoConsult {
                    Picker("같은 신호 다시 요청 간격", selection: $cooldownMinutes) {
                        Text("5분").tag(5)
                        Text("15분").tag(15)
                        Text("1시간").tag(60)
                        Text("6시간").tag(360)
                        Text("24시간").tag(1440)
                    }
                    .pickerStyle(MenuPickerStyle())
                    Picker("의견 뒤 가격 확인", selection: $evaluationMinutes) {
                        Text("1분").tag(1)
                        Text("5분").tag(5)
                        Text("15분").tag(15)
                        Text("1시간").tag(60)
                        Text("4시간").tag(240)
                        Text("24시간").tag(1440)
                    }
                    .pickerStyle(MenuPickerStyle())
                }
                Button(store.isRunningFeatureAction ? "저장 중" : "신호 기록 시작") {
                    Task {
                        _ = await store.createAISession(
                            name: sessionName,
                            providers: Array(providersForSession),
                            eventTypes: Array(eventTypes),
                            autoConsultEventTypes: autoConsult ? Array(autoConsultEventTypes.intersection(eventTypes)) : [],
                            autoConsult: autoConsult,
                            coins: coins,
                            cooldownSeconds: cooldownMinutes * 60,
                            evaluationMinutes: evaluationMinutes
                        )
                    }
                }
                .buttonStyle(CoinPilotSecondaryButtonStyle())
                .disabled(!store.canOperate || store.isRunningFeatureAction || eventTypes.isEmpty || providersForSession.isEmpty)
            }
        }
    }

    private var sessionsCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "세션 관리")
                if store.aiSessions.isEmpty {
                    EmptyMessage(text: "만든 신호 세션이 없습니다.")
                }
                ForEach(store.aiSessions) { session in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(session.name).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(sessionStatus(session.status)).font(.caption.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
                        }
                        MetadataLine(text: "\(session.autoConsult ? session.providers.map(providerLabel).joined(separator: " + ") : "신호 기록") · \(session.eventTypes.map(eventLabel).joined(separator: " · "))")
                            .font(.caption).foregroundColor(CPColor.secondaryInk)
                        MetadataLine(text: "\(session.coins.isEmpty ? "전체 종목" : session.coins.map(CoinPilotFormatting.ticker).joined(separator: ", ")) · 신호 \(session.eventCount ?? 0)건")
                            .font(.caption2).foregroundColor(CPColor.secondaryInk)
                        if session.autoConsult {
                            MetadataLine(text: "의견 \(session.consultationCount ?? 0)회 · \(session.evaluationMinutes ?? 5)분 뒤 가격 확인")
                                .font(.caption2).foregroundColor(CPColor.secondaryInk)
                        }
                        HStack {
                            if session.status == "RUNNING" {
                                sessionButton("일시 정지", id: session.id, action: "pause")
                            } else if session.status == "PAUSED" {
                                sessionButton("다시 시작", id: session.id, action: "resume")
                            }
                            if session.status != "STOPPED" {
                                sessionButton("종료", id: session.id, action: "stop")
                            }
                        }
                    }
                    .padding(.vertical, 8)
                    Divider().overlay(CPColor.line)
                }
            }
        }
    }

    private var signalsCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "최근 신호와 자문")
                Picker("의견을 받을 서비스", selection: Binding(
                    get: { effectiveConsultationProvider },
                    set: { consultationProvider = $0 }
                )) {
                    if store.readyAIProviderIDs.isEmpty { Text("서비스 미연결").tag("none") }
                    if store.canRequestAIConsultation(provider: "both") { Text("OpenAI + Claude").tag("both") }
                    if store.readyAIProviderIDs.contains("gpt") { Text("OpenAI").tag("gpt") }
                    if store.readyAIProviderIDs.contains("claude") { Text("Claude").tag("claude") }
                }
                .pickerStyle(SegmentedPickerStyle())
                .disabled(store.readyAIProviderIDs.isEmpty)
                if store.aiEvents.isEmpty {
                    EmptyMessage(text: "최근 도착한 신호가 없습니다.")
                }
                ForEach(store.aiEvents.prefix(20)) { event in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(event.coin.map(CoinPilotFormatting.ticker) ?? eventTypeLabel(event.type))
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(CoinPilotFormatting.dateTime(event.timestamp, unavailable: "시각 미제공"))
                                .font(.caption2).foregroundColor(CPColor.secondaryInk)
                        }
                        HStack(spacing: 8) {
                            Text(event.action.map(actionLabel) ?? eventTypeLabel(event.type))
                            if let price = event.price { Text(CoinPilotFormatting.price(price)) }
                            if let strength = event.signalStrength { Text(strength) }
                        }
                        .font(.caption.weight(.medium)).foregroundColor(CPColor.secondaryInk)
                        Text(event.title).font(.caption).foregroundColor(CPColor.ink).lineLimit(3)
                        if let detail = event.detail { Text(detail).font(.caption2).foregroundColor(CPColor.secondaryInk).lineLimit(3) }
                        Button("이 신호에 의견 요청") { Task { _ = await store.requestAIConsultation(eventId: event.id, provider: effectiveConsultationProvider) } }
                            .font(.caption.weight(.semibold))
                            .disabled(!store.canRequestAIConsultation(provider: effectiveConsultationProvider) || store.isRunningFeatureAction)
                    }
                    .padding(.vertical, 7)
                    Divider().overlay(CPColor.line)
                }
                if let message = store.aiConsultationMessage {
                    InlineNotice(text: message, color: CPColor.blue)
                }
                ForEach(Array(store.aiConsultations.prefix(5).enumerated()), id: \.offset) { item in
                    let value = item.element
                    VStack(alignment: .leading, spacing: 5) {
                        let event = value["event"] as? [String: Any] ?? [:]
                        MetadataLine(text: "\(CoinPilotFormatting.ticker(event["coin"] as? String)) · \(value["status"] as? String ?? "의견")")
                            .font(.caption.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
                        if let results = value["results"] as? [[String: Any]], !results.isEmpty {
                            ForEach(Array(results.enumerated()), id: \.offset) { resultRow in
                                let result = resultRow.element
                                let advice = result["advice"] as? [String: Any] ?? [:]
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(providerLabel(result["provider"] as? String ?? ""))
                                        Spacer()
                                        Text(actionLabel(advice["action"] as? String ?? "확인"))
                                            .fontWeight(.semibold)
                                    }
                                    .font(.caption2).foregroundColor(CPColor.blue)
                                    Text(advice["rationale"] as? String ?? result["error"] as? String ?? "의견 내용을 제공하지 않았습니다.")
                                        .font(.caption).foregroundColor(CPColor.ink).lineLimit(5)
                                    if let risks = advice["risks"] as? [String], !risks.isEmpty {
                                        MetadataLine(text: "확인할 위험: " + risks.joined(separator: " · "))
                                            .font(.caption2).foregroundColor(CPColor.amber).lineLimit(3)
                                    }
                                    if let invalidation = advice["invalidation"] as? String {
                                        Text("다시 확인할 조건: \(invalidation)")
                                            .font(.caption2).foregroundColor(CPColor.secondaryInk).lineLimit(2)
                                    }
                                }
                            }
                        } else {
                            Text(value["error"] as? String ?? "아직 받은 서비스 의견이 없습니다.")
                                .font(.caption).foregroundColor(CPColor.ink).lineLimit(4)
                        }
                        consultationEvaluation(value["evaluation"] as? [String: Any] ?? [:])
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var providerStatus: some View {
        if let providers = store.aiProviderStatus["providers"] as? [[String: Any]], !providers.isEmpty {
            ForEach(Array(providers.enumerated()), id: \.offset) { item in
                let provider = item.element
                let id = (provider["id"] as? String ?? provider["provider"] as? String ?? "").lowercased()
                let ready = store.readyAIProviderIDs.contains(id)
                let status = store.featureMessages["ai-providers"] != nil ? "UNCONFIRMED"
                    : store.aiProviderStatus["enabled"] as? Bool != true ? "DISABLED"
                    : provider["status"] as? String
                HStack {
                    Text(provider["label"] as? String ?? provider["name"] as? String ?? provider["provider"] as? String ?? provider["id"] as? String ?? "AI 서비스")
                    Spacer()
                    Text(providerState(status, ready: ready))
                        .font(.caption.weight(.semibold))
                        .foregroundColor(ready ? CPColor.green : CPColor.amber)
                }
                .font(.subheadline)
            }
        } else {
            Text("서비스 제공 상태를 확인할 수 없습니다.").font(.subheadline).foregroundColor(CPColor.secondaryInk)
        }
    }

    private func sessionButton(_ title: String, id: String, action: String) -> some View {
        Button(title) { Task { _ = await store.updateAISession(id: id, action: action) } }
            .buttonStyle(CoinPilotCompactButtonStyle(tint: CPColor.blue))
            .disabled(!store.canOperate || store.isRunningFeatureAction)
    }

    private func sessionStatus(_ value: String) -> String {
        switch value {
        case "RUNNING": return "실행 중"
        case "PAUSED": return "일시 정지"
        case "STOPPED": return "종료"
        default: return "상태 확인 필요"
        }
    }

    private func eventLabel(_ value: String) -> String {
        eventOptions.first(where: { $0.0 == value })?.1 ?? value
    }

    private func eventTypeLabel(_ value: String) -> String { eventLabel(value) }

    private func providerBinding(_ provider: String) -> Binding<Bool> {
        Binding(
            get: { providers.contains(provider) && store.readyAIProviderIDs.contains(provider) },
            set: { enabled in
                if enabled { providers.insert(provider) } else { providers.remove(provider) }
            }
        )
    }

    private func providerLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "gpt", "openai", "chatgpt", "codex": return "OpenAI"
        case "claude", "anthropic": return "Claude"
        default: return value.isEmpty ? "AI 의견" : value
        }
    }

    private func providerState(_ status: String?, ready: Bool) -> String {
        if ready { return "사용 가능" }
        switch status {
        case "UNCONFIRMED": return "확인 불가"
        case "NOT_AUTHENTICATED": return "계정 로그인 필요"
        case "NOT_INSTALLED": return "연결 프로그램 없음"
        case "DISABLED": return "현재 사용 안 함"
        default: return "연결 확인 필요"
        }
    }

    private func actionLabel(_ value: String) -> String {
        switch value.uppercased() {
        case "BUY": return "매수 의견"
        case "SELL": return "매도 의견"
        case "WAIT", "HOLD": return "관망 의견"
        default: return value
        }
    }

    @ViewBuilder
    private func consultationEvaluation(_ evaluation: [String: Any]) -> some View {
        if !evaluation.isEmpty {
            let status = evaluation["status"] as? String ?? ""
            if status == "COMPLETED" {
                let minutes = evaluation["horizonMinutes"] as? Int ?? 5
                let change = (evaluation["priceChangePercent"] as? NSNumber)?.doubleValue
                MetadataLine(text: "\(minutes)분 뒤 가격 변화 · \(CoinPilotFormatting.percent(change))")
                    .font(.caption2.weight(.semibold)).foregroundColor(CPColor.secondaryInk)
            } else if status == "PENDING" {
                Text("가격 확인 시점 대기 중").font(.caption2).foregroundColor(CPColor.amber)
            } else if status == "NOT_EVALUABLE" {
                Text(evaluation["reason"] as? String ?? "기준 가격을 비교할 수 없습니다.")
                    .font(.caption2).foregroundColor(CPColor.secondaryInk)
            }
        }
    }

    private func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}
