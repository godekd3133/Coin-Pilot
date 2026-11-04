import SwiftUI

struct CoinPilotWorkspaceSelector: View {
    @ObservedObject var store: CoinPilotStore

    private var selection: Binding<CoinPilotWorkspaceMode> {
        Binding(
            get: { store.activeWorkspace },
            set: { store.selectWorkspace($0) }
        )
    }

    var body: some View {
        Picker("작업공간", selection: selection) {
            ForEach(CoinPilotWorkspaceMode.allCases) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .pickerStyle(SegmentedPickerStyle())
        .accessibilityLabel("실거래 또는 모의투자 작업공간")
    }
}

struct CoinPilotLiveCredentialSetupView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 13) {
                SectionHeading(title: "\(store.exchangeDisplayName) API 키 등록")
                if store.canUseLiveCredentialRegistration {
                    Text("\(store.exchangeDisplayName) Open API에서 발급한 키를 입력하세요.")
                        .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                    DisclosureGroup("발급과 권한 설정") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("자산조회, 주문조회, 주문하기 권한을 선택하세요. 출금 권한은 필요하지 않습니다.")
                            Text("허용 IP에는 거래 서버가 외부 통신에 사용하는 고정 공인 IP를 등록하세요.")
                        }
                        .font(.footnote).foregroundColor(CPColor.secondaryInk)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                    }.font(.footnote).frame(minHeight: 44)
                    VStack(alignment: .leading, spacing: 7) {
                        FieldTitle(title: "Access Key")
                        SecureField("Access Key 입력", text: $store.liveAccessKeyDraft)
                            .cpNoAutocapitalization()
                            .cpNoAutocorrection()
                            .textFieldStyle(.plain)
                            .font(.body)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CPColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .overlay(RoundedRectangle(cornerRadius: 11).stroke(CPColor.line, lineWidth: 1))
                            .accessibilityLabel("\(store.exchangeDisplayName) Access Key")
                    }

                    VStack(alignment: .leading, spacing: 7) {
                        FieldTitle(title: "Secret Key")
                        SecureField("Secret Key 입력", text: $store.liveSecretKeyDraft)
                            .cpNoAutocapitalization()
                            .cpNoAutocorrection()
                            .textFieldStyle(.plain)
                            .font(.body)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CPColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .overlay(RoundedRectangle(cornerRadius: 11).stroke(CPColor.line, lineWidth: 1))
                            .accessibilityLabel("\(store.exchangeDisplayName) Secret Key")
                    }

                    Button {
                        Task { _ = await store.submitLiveCredentials() }
                    } label: {
                        HStack(spacing: 8) {
                            if store.isSubmittingLiveCredentials { ProgressView().tint(.white) }
                            Text(store.isSubmittingLiveCredentials ? "키 등록 중" : "실거래 서버에 키 등록")
                                .font(.subheadline.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 48)
                        .foregroundColor(.white)
                        .background(CPColor.blueFill)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .disabled(!store.canSubmitLiveCredentials)
                    .opacity(store.canSubmitLiveCredentials ? 1 : 0.45)
                    Text("키는 서버에만 저장되며 등록 시도 뒤 입력란을 비웁니다.")
                        .font(.caption).foregroundColor(CPColor.secondaryInk)
                } else {
                    Text(store.currentLiveCredentialTransportIsSecure == false
                         ? "키를 등록하려면 HTTPS 서버를 연결해 주세요."
                         : "키를 등록하려면 운영 토큰을 연결해 주세요.")
                        .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                    NavigationLink(destination: CoinPilotSettingsView(store: store)) {
                        Text("연결 설정")
                    }.buttonStyle(CoinPilotSecondaryButtonStyle())
                }
            }
        }
    }
}
