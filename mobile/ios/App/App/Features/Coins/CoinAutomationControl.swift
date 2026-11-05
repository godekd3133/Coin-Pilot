import SwiftUI

struct CoinPilotAutomationControl: View {
    @ObservedObject var store: CoinPilotStore
    @State private var pendingConfirmation: CPConfirmation?

    private var presentation: CoinPilotAutomationPresentation {
        CoinPilotAutomationPresentation(
            isBundledPreview: store.isBundledPreview,
            isRunning: store.status?.isRunning
        )
    }

    private var isRunning: Bool? { store.isBundledPreview ? nil : store.status?.isRunning }

    private var isEnabled: Bool {
        guard !store.isBundledPreview, store.canOperate, store.status?.mode == store.activeWorkspace.serverMode,
              let isRunning else { return false }
        return isRunning || store.status?.runtimeState != "PROTECTIVE_ONLY"
    }

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        SectionHeading(title: presentation.sectionTitle)
                        if isRunning == nil {
                            Text(presentation.explanation)
                                .font(.footnote)
                                .foregroundColor(CPColor.secondaryInk)
                        }
                    }
                    Spacer()
                    Text(presentation.stateLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(!store.isBundledPreview && isRunning == true
                                         ? CPColor.green
                                         : CPColor.secondaryInk)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(store.isBundledPreview ? "자동매매 예시" : "운영 상태") · \(presentation.stateLabel). \(presentation.explanation)")
                if store.activeWorkspace == .live && !store.isBundledPreview {
                    Text("시작하면 실제 주문이 발생할 수 있습니다. 중지 후에도 보유 자산의 위험 감시는 계속될 수 있습니다.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if presentation.showsControls {
                    Button(isRunning == true ? "자동매매 중지" : "자동매매 시작") {
                        pendingConfirmation = confirmation(forStart: isRunning != true)
                    }
                    .buttonStyle(CoinPilotPrimaryButtonStyle())
                    .disabled(!isEnabled || store.isWorking)
                    if !isEnabled {
                        Text(!store.canOperate
                             ? "조회 전용 권한. 주문·설정 권한은 설정에서 확인."
                             : isRunning == nil
                                ? "서버 실행 상태 확인 후 사용 가능."
                                : "보유 포지션 보호 종료 후 재시작 가능. 상태는 주문 전 점검에서 확인.")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !store.isBundledPreview {
                    DisclosureGroup("운용 상세") {
                        VStack(alignment: .leading, spacing: 10) {
                            if let response = store.lastAutomationResponse {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("최근 요청 응답").font(.caption.weight(.semibold))
                                    Text(response).font(.caption).fixedSize(horizontal: false, vertical: true)
                                }
                                .foregroundColor(CPColor.secondaryInk)
                            }
                            if store.isBundledPreview {
                                EmptyView()
                            } else if store.activeWorkspace == .live {
                                Text("실거래 시작 후 서버의 검증을 통과하면 자동 주문이 나갈 수 있습니다. 중지 요청 후에도 보유 포지션의 위험 감시는 계속될 수 있습니다.")
                                    .font(.footnote)
                                    .foregroundColor(CPColor.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                                if store.status?.liveManualPrepareOnBoot == true {
                                    if store.status?.liveManualPrepared == true {
                                        Text("실거래 계좌 확인 완료")
                                            .font(.footnote.weight(.semibold))
                                            .foregroundColor(CPColor.green)
                                    } else {
                                        Text("서버는 자동매매를 시작하지 않은 상태로 계좌와 대상 주문을 확인하고 있습니다. 확인이 끝날 때까지 주문이 잠겨 있습니다.")
                                            .font(.footnote)
                                            .foregroundColor(CPColor.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                            } else {
                                Text("모의투자 서버의 가상 계좌만 사용합니다. 실거래 서버의 상태와 자산은 이 작업공간에 섞이지 않습니다.")
                                    .font(.footnote)
                                    .foregroundColor(CPColor.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if !store.isBundledPreview {
                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(store.liveEventsConnected ? CPColor.green : CPColor.secondaryInk)
                                        .frame(width: 7, height: 7)
                                        .accessibilityHidden(true)
                                    Text(store.liveEventsConnected
                                         ? "실시간 서버 알림 수신 중"
                                         : "앱 사용 중 30초마다 갱신")
                                        .font(.caption2)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                                .accessibilityElement(children: .combine)
                            }
                            if let desired = store.status?.desiredAutomationRunning {
                                Text(desired ? "자동매매 켜짐 저장됨. 서버 재시작 시 계좌·시세 확인 후 재개."
                                     : "자동매매 꺼짐 저장됨. 서버 재시작 시에도 꺼진 상태 유지.")
                                    .font(.caption).foregroundColor(CPColor.secondaryInk)
                                if let savedAt = store.status?.automationTrackingSavedAt {
                                    MetadataLine(text: "진행 기록 저장 · \(savedAt)")
                                        .font(.caption2).foregroundColor(CPColor.secondaryInk)
                                }
                            }
                            if let message = store.orderNotificationMessage {
                                Text(message).font(.caption).foregroundColor(CPColor.secondaryInk)
                            }
                            if !store.isBundledPreview {
                                NavigationLink(destination: CoinPilotResearchDeskView(store: store)) {
                                    HStack(spacing: 12) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("주문 전 점검")
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundColor(CPColor.blue)
                                            Text("서버 연결과 투자 전략 자료 확인")
                                                .font(.caption)
                                                .foregroundColor(CPColor.secondaryInk)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                        Spacer(minLength: 8)
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.semibold))
                                            .foregroundColor(CPColor.secondaryInk)
                                            .accessibilityHidden(true)
                                    }
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(CoinPilotPressableButtonStyle())
                                .accessibilityHint("실거래 주문 조건과 서버의 안전 상태를 확인합니다. 이 화면에서는 주문을 보내지 않습니다.")
                            }
                        }.padding(.top, 8)
                    }
                    .font(.subheadline)
                    .frame(minHeight: 44)
                }
            }
        }
        .cpConfirmationSheet($pendingConfirmation)
    }

    private func confirmation(forStart startRequest: Bool) -> CPConfirmation {
        let isLive = store.activeWorkspace == .live
        return CPConfirmation(
            title: startRequest ? "자동매매 시작" : "자동매매 중지",
            message: startRequest && isLive
                ? "서버의 시작 조건을 통과해야 자동매매가 시작됩니다. 시작 후에는 서버에서 실제 주문이 발생할 수 있습니다."
                : !startRequest && isLive
                    ? "신규 자동 진입을 중지합니다. 보유 포지션 위험 감시는 서버 상태에 따라 계속될 수 있습니다."
                    : "모의투자 서버의 가상 계좌에만 영향을 줍니다.",
            confirmTitle: startRequest ? (isLive ? "실거래 자동매매 시작" : "모의투자 시작") : "자동매매 중지 요청",
            isDestructive: startRequest && isLive,
            isLive: isLive
        ) {
            Task { _ = await store.setAutomationRunning(startRequest) }
        }
    }
}
