import SwiftUI

struct CoinPilotConnectionView: View {
    @ObservedObject var store: CoinPilotStore
    private enum LoginField: Hashable { case username, password, token }
    @FocusState private var focusedField: LoginField?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("CoinPilot")
                        .font(.headline.weight(.bold))
                        .foregroundColor(CPColor.blue)
                    Spacer()
                }

                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(connectionTitle)
                            .font(.title.weight(.bold))
                            .foregroundColor(CPColor.ink)
                        if !connectionExplanation.isEmpty {
                            Text(connectionExplanation)
                                .font(.body)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 9) {
                    Text("사용할 계좌")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                    CoinPilotWorkspaceSelector(store: store)
                    Text(store.activeWorkspace == .paper
                         ? "가상 자금으로 거래합니다."
                         : "주문 시 실제 자금이 사용됩니다.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !store.usesManagedServerConnection {
                    if store.phase == .login {
                        DisclosureGroup("연결 서버") { serverAddressForm.padding(.top, 10) }
                            .font(.subheadline)
                    } else {
                        serverAddressForm
                    }
                }

                if store.phase == .login {
                    VStack(alignment: .leading, spacing: 10) {
                        if store.showsPasswordLogin {
                            FieldTitle(title: "아이디")
                            TextField("아이디", text: $store.usernameDraft)
                                .cpNoAutocapitalization()
                                .cpNoAutocorrection()
                                .textContentType(.username)
                                .modifier(LoginFieldStyle())
                                .focused($focusedField, equals: .username)
                                .submitLabel(.next)
                                .onSubmit { focusedField = .password }
                                .accessibilityLabel("아이디")
                            FieldTitle(title: "비밀번호")
                            SecureField("비밀번호", text: $store.passwordDraft)
                                .textContentType(.password)
                                .modifier(LoginFieldStyle())
                                .focused($focusedField, equals: .password)
                                .submitLabel(.go)
                                .onSubmit(submit)
                                .accessibilityLabel("비밀번호")
                            Text(passwordStorageNotice)
                                .font(.footnote)
                                .foregroundColor(CPColor.secondaryInk)
                        } else {
                            FieldTitle(title: store.usesManagedServerConnection ? "서버 토큰으로 로그인" : "서버 토큰")
                            SecureField("토큰 입력", text: $store.tokenDraft)
                                .cpNoAutocapitalization()
                                .cpNoAutocorrection()
                                .modifier(LoginFieldStyle())
                                .focused($focusedField, equals: .token)
                                .accessibilityLabel("서버 토큰")
                            Text(tokenStorageNotice)
                                .font(.footnote)
                                .foregroundColor(CPColor.secondaryInk)
                        }
                        if store.passwordLoginAvailable == true {
                            Button(store.showsPasswordLogin ? "토큰으로 로그인" : "아이디로 로그인") {
                                store.setLoginUsesPassword(!store.showsPasswordLogin)
                            }
                            .font(.footnote.weight(.semibold))
                            .foregroundColor(CPColor.blue)
                            .frame(minHeight: 44)
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let message = store.connectionMessage {
                    Text(message)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(CPColor.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.updatesFrequently)
                }

                Button(action: submit) {
                    HStack(spacing: 9) {
                        if store.isWorking { ProgressView().tint(.white) }
                        Text(store.isWorking ? "연결 중" : store.phase == .login ? "로그인" : store.usesManagedServerConnection ? "다시 연결" : store.phase == .setup ? "서버 확인" : "다시 연결")
                            .font(.headline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 54)
                    .foregroundColor(.white)
                    .background(CPColor.blueFill)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(CoinPilotPressableButtonStyle())
                .disabled(store.isWorking)

                if store.canUseBundledPreview {
                    Button {
                        store.useBundledPreview()
                    } label: {
                        HStack(spacing: 8) {
                            Text("예시 데이터로 둘러보기")
                                .font(.body.weight(.semibold))
                            Image(systemName: "arrow.right")
                                .font(.footnote.weight(.semibold))
                        }
                        .foregroundColor(CPColor.blue)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(CoinPilotPressableButtonStyle())
                }

                Label(store.usesManagedServerConnection
                      ? "계좌에 맞는 서버로 자동 연결됩니다. 거래소 API 키는 서버에만 보관합니다."
                      : "거래소 API 키는 서버에만 보관합니다.", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 22)
            .padding(.top, 20)
            .padding(.bottom, 36)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
    }

    private func submit() {
        focusedField = nil
        Task { await store.primaryConnectionAction() }
    }

    private var passwordStorageNotice: String {
        "로그인하면 서버가 발급한 접속 권한만 이 기기의 보안 저장소에 보관합니다. 비밀번호는 저장하지 않습니다."
    }

    private var serverAddressForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldTitle(title: "서버 주소")
            TextField("https://example.com", text: $store.serverDraft)
                .cpKeyboardURL()
                .cpNoAutocapitalization()
                .cpNoAutocorrection()
                .textFieldStyle(.plain)
                .font(.body)
                .padding(.horizontal, 15)
                .frame(minHeight: 54)
                .background(CPColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(CPColor.line, lineWidth: 1))
                .accessibilityLabel("서버 주소")
            Text(serverAddressHelp)
                .font(.footnote)
                .foregroundColor(CPColor.secondaryInk)
        }
    }

    private var tokenStorageNotice: String {
#if targetEnvironment(simulator) || COINPILOT_TEST_SIMULATOR_TOKEN_STORE
        return "검증 환경에서는 앱이 실행되는 동안만 임시 보관됩니다. 앱을 다시 열면 토큰을 입력해 주세요."
#else
        return "토큰은 이 기기의 보안 저장소에 보관됩니다."
#endif
    }

    private var connectionTitle: String {
        if store.workspaceModeMismatchMessage != nil { return "다른 모드의 서버가 연결됐어요" }
        if store.phase == .dashboard && !store.serverModeMatchesWorkspace { return "서버 연결을 확인해 주세요" }
        if store.phase == .login { return "내 계좌에 로그인하세요" }
        if store.usesManagedServerConnection {
            return store.isWorking ? "내 계좌에 연결하고 있어요" : "계좌 연결을 확인해 주세요"
        }
        return "계좌 연결"
    }

    private var connectionExplanation: String {
        if let message = store.workspaceModeMismatchMessage { return message }
        if store.phase == .dashboard,
           !store.serverModeMatchesWorkspace,
           let message = store.dashboardMessage {
            return message
        }
        if store.phase == .login {
            return store.showsPasswordLogin
                ? "서버에 등록한 아이디와 비밀번호로 로그인하세요."
                : "연결한 서버에서 발급한 토큰을 입력하세요."
        }
        return ""
    }

    private var serverAddressHelp: String {
        "\(store.activeWorkspace.title) 계좌의 서버 주소를 입력하세요. 외부에서 연결할 때는 HTTPS 주소를 사용하세요."
    }
}

private struct LoginFieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.body)
            .padding(.horizontal, 15)
            .frame(minHeight: 54)
            .background(CPColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(CPColor.line, lineWidth: 1))
    }
}
