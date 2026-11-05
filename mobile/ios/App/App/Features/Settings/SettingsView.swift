import SwiftUI

struct CoinPilotSettingsView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var showingServerEditor = false
    @State private var showingTokenEditor = false
    @State private var showingLogoutConfirmation = false
    @State private var showingTuningEditor = false
    @AppStorage(CPAppearance.storageKey) private var appearance = CPAppearance.system.rawValue

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CPCard("작업공간") {
                    CoinPilotWorkspaceSelector(store: store)
                    if store.activeWorkspace == .live && !store.isBundledPreview {
                        CPLiveIndicator()
                        Text("실전 작업공간에서는 주문과 자동매매에 실제 자금이 사용됩니다.")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                    } else {
                        Text("모의 작업공간은 가상 자금만 사용. 실전 자산과 분리.")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                    }
                }
                CPCard("화면") {
                    CPSegmented(
                        title: "테마",
                        selection: $appearance,
                        options: CPAppearance.allCases.map { ($0.rawValue, $0.title) }
                    )
                    Text("손익은 국내 관례대로 상승·수익은 빨강, 하락·손실은 파랑으로 표시합니다.")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: "데이터 출처")
                        if store.isBundledPreview {
                            SettingsRow(title: "자료", value: "앱에 포함된 예시 데이터", symbol: "internaldrive")
                            Text("실제 계좌·시세·체결 정보가 아닌 화면 미리보기입니다.")
                                .font(.subheadline)
                                .foregroundColor(CPColor.secondaryInk)
                            Button("실제 서버 연결") { store.useServerMode() }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CPColor.blue)
                                .padding(.top, 2)
                        } else {
                            if store.usesManagedServerConnection {
                                SettingsRow(title: "계좌 연결", value: "\(store.activeWorkspace.title) 서버 자동 연결", symbol: "network")
                                Button("연결 다시 확인") {
                                    Task { await store.primaryConnectionAction() }
                                }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CPColor.blue)
                                .disabled(store.isWorking)
                            } else {
                                SettingsRow(
                                    title: "서버 주소",
                                    value: store.serverAddress.isEmpty ? "설정되지 않음" : store.serverAddress,
                                    symbol: "network"
                                )
                                Button("서버 주소 변경") { showingServerEditor = true }
                                    .accessibilityLabel("서버 주소 변경")
                                    .frame(minHeight: 44)
                                    .font(.body.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                                    .padding(.top, 2)
                            }
                            if store.authenticationRequired {
                                Button("서버 토큰 입력 또는 변경") { showingTokenEditor = true }
                                    .accessibilityLabel("서버 토큰 입력 또는 변경")
                                    .frame(minHeight: 44)
                                    .font(.body.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                            }
                            if store.canUseBundledPreview {
                                Button("예시 데이터로 보기") { store.useBundledPreview() }
                                    .font(.body.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                            }
                        }
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: store.isObserverAccount ? "계좌 권한" : "자동매매 상태")
                        SettingsRow(title: "거래 모드", value: modeName(store.tradingMode), symbol: "arrow.left.arrow.right")
                        SettingsRow(title: "앱 권한", value: accessScope, symbol: operatesWithCurrentAccess ? "slider.horizontal.3" : "eye")
                        if operatesWithCurrentAccess {
                            SettingsRow(title: store.isObserverAccount ? "권한 상태" : "실행 상태", value: engineState, symbol: store.isObserverAccount ? "eye" : "antenna.radiowaves.left.and.right")
                        }
                        if !engineExplanation.isEmpty {
                            Text(engineExplanation)
                                .font(.subheadline)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if !store.isBundledPreview {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack {
                                SectionHeading(title: "서버 상태")
                                Spacer()
                                Button {
                                    Task { await store.loadSystemStatus() }
                                } label: {
                                    Image(systemName: "arrow.clockwise")
                                        .font(.callout.weight(.semibold))
                                        .foregroundColor(CPColor.blue)
                                        .frame(minWidth: 44, minHeight: 44)
                                        .contentShape(Rectangle())
                                }
                                .accessibilityLabel("서버 상태 다시 확인")
                            }
                            if let error = store.featureMessages["system"] {
                                EmptyMessage(text: error)
                            } else if store.systemStatus.isEmpty {
                                Text("서버 가동 상태를 확인하는 중입니다.")
                                    .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                            } else {
                                SettingsRow(
                                    title: "거래소",
                                    value: "\(store.exchangeDisplayName) (\(store.quoteCurrency) 기준)",
                                    symbol: "building.columns"
                                )
                                SettingsRow(
                                    title: "가동 시간",
                                    value: (store.systemStatus["uptimeFormatted"] as? String) ?? "확인 불가",
                                    symbol: "timer"
                                )
                                SettingsRow(
                                    title: "감시 시장 / 열린 포지션",
                                    value: "\(systemStatusCount(store.systemStatus["targetCoinsCount"])) / \(systemStatusCount(store.systemStatus["currentPositions"]))",
                                    symbol: "binoculars"
                                )
                                SettingsRow(
                                    title: "마지막 거래",
                                    value: systemStatusTimestamp(store.systemStatus["lastTradeTime"]),
                                    symbol: "clock.arrow.2.circlepath"
                                )
                                let recentErrors = (store.systemStatus["recentErrors"] as? [[String: Any]] ?? [])
                                    .compactMap { $0["message"] as? String }
                                if store.systemStatus["recentErrors"] as? [[String: Any]] == nil {
                                    SettingsRow(title: "최근 오류", value: "확인 불가", symbol: "questionmark.circle")
                                } else if recentErrors.isEmpty {
                                    SettingsRow(title: "최근 오류", value: "없음", symbol: "checkmark.circle")
                                } else {
                                    VStack(alignment: .leading, spacing: 6) {
                                        SettingsRow(title: "최근 오류", value: "\(recentErrors.count)건", symbol: "exclamationmark.triangle")
                                        ForEach(Array(recentErrors.prefix(3).enumerated()), id: \.offset) { _, message in
                                            Text(message)
                                                .font(.caption2)
                                                .foregroundColor(CPColor.amber)
                                                .lineLimit(2)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .task { await store.loadSystemStatus() }

                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeading(title: "전략·위험 튜닝")
                            Text(store.tuningBlockReason ?? "현재 작업공간 서버의 투자 비율과 위험 보호값을 불러와 조정합니다.")
                                .font(.subheadline)
                                .foregroundColor(store.tuningBlockReason == nil ? CPColor.secondaryInk : CPColor.amber)
                                .fixedSize(horizontal: false, vertical: true)
                            Button {
                                showingTuningEditor = true
                            } label: {
                                HStack {
                                    Text("튜닝값 설정")
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CPColor.blue)
                                .frame(minHeight: 40)
                                .contentShape(Rectangle())
                            }
                            .accessibilityLabel("튜닝값 설정")
                        .frame(minHeight: 44)
                        .disabled(!store.canViewTuning)
                        }
                    }

                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: "앱 정보")
                        SettingsRow(title: "버전", value: appVersion, symbol: "iphone")
                        SettingsRow(title: "마지막 확인", value: CoinPilotFormatting.time(store.lastCheckedAt), symbol: "clock")
                    }
                }

                if store.authenticationRequired && !store.usesManagedServerConnection {
                    Button(role: .destructive) {
                        showingLogoutConfirmation = true
                    } label: {
                        Text("이 기기에서 로그아웃")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("이 기기에서 로그아웃")
                    .buttonStyle(CoinPilotPressableButtonStyle())
                    .foregroundColor(CPColor.red)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 35)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .sheet(isPresented: $showingServerEditor) {
            CoinPilotServerEditor(store: store)
        }
        .sheet(isPresented: $showingTokenEditor) {
            CoinPilotTokenEditor(store: store)
        }
        .sheet(isPresented: $showingTuningEditor) {
            CoinPilotTuningEditor(store: store)
        }
        .confirmationDialog("이 기기에서 로그아웃", isPresented: $showingLogoutConfirmation, titleVisibility: .visible) {
            Button("로그아웃", role: .destructive) { store.logOut() }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이 기기에 저장된 서버 토큰을 삭제합니다. 서버 주소는 유지됩니다.")
        }
    }

    /// 인증이 꺼진 개인 서버는 토큰 없이도 운영 자격을 가진다.
    private var operatesWithCurrentAccess: Bool {
        !store.authenticationRequired || store.authenticationScope.canOperate
    }

    private func systemStatusCount(_ value: Any?) -> String {
        guard let number = value as? NSNumber, String(cString: number.objCType) != "c",
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue.rounded(.down) == number.doubleValue else { return "—" }
        return "\(number.stringValue)개"
    }

    /// /api/system-status의 lastTradeTime은 ISO 문자열 또는 epoch(ms/s)일 수 있다.
    private func systemStatusTimestamp(_ value: Any?) -> String {
        if let text = value as? String, !text.isEmpty { return CoinPilotFormatting.dateTime(text) }
        if let number = value as? NSNumber, number.doubleValue > 0 {
            let seconds = number.doubleValue > 1e12 ? number.doubleValue / 1000 : number.doubleValue
            return CoinPilotFormatting.localDateTime(Date(timeIntervalSince1970: seconds))
        }
        return "기록된 거래 없음"
    }

    private var engineState: String {
        if !operatesWithCurrentAccess { return "조회 전용" }
        if !store.serverModeMatchesWorkspace { return "서버 모드 불일치" }
        if store.status?.runtimeState == "SYNC_REQUIRED" || store.status?.exchangeStateKnown == false {
            return "계좌 확인 중"
        }
        if store.runtimeSafetyMessage != nil { return "위험 감시 전용" }
        if store.isObserverAccount { return "조회 전용" }
        switch store.status?.isRunning {
        case true: return "실행 중"
        case false: return "중지"
        case nil: return "확인할 수 없음"
        }
    }

    private var engineExplanation: String {
        if !operatesWithCurrentAccess {
            return "주문이나 설정 변경에는 운영 토큰이 필요합니다."
        }
        if let mismatch = store.workspaceModeMismatchMessage { return mismatch }
        if let safetyMessage = store.runtimeSafetyMessage { return safetyMessage }
        if store.isObserverAccount { return "이 계좌는 조회 전용입니다. 앱에서는 주문을 실행하지 않습니다." }
        switch store.status?.isRunning {
        case true: return "앱을 닫아도 서버에서 계속 실행됩니다."
        case false: return ""
        case nil: return "자동매매 상태를 확인하지 못했습니다."
        }
    }

    private var accessScope: String {
        switch store.authenticationScope {
        case .operatorFull: return "전체 대시보드"
        case .mobileOperator: return "모바일 운영"
        case .readOnly: return "조회 전용"
        case .unauthenticated: return store.authenticationRequired ? "인증되지 않음" : "인증 불필요"
        }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "—"
        let build = info["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }

    private func modeName(_ mode: String?) -> String {
        switch mode {
        case "DRY_RUN": return "모의투자"
        case "LIVE": return "실거래"
        default: return "확인할 수 없음"
        }
    }
}
