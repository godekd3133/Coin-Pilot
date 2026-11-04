import SwiftUI

struct CoinPilotServerEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    @State private var message: String?

    init(store: CoinPilotStore) {
        self.store = store
        _address = State(initialValue: store.serverDraft)
    }

    var body: some View {
        CoinPilotNavigationHost {
            Form {
                Section {
                        TextField("서버 주소", text: $address, prompt: Text("https://example.com"))
                        .cpKeyboardURL()
                        .cpNoAutocapitalization()
                        .cpNoAutocorrection()
                } header: {
                    Text("서버 주소")
                } footer: {
                    Text("같은 Wi-Fi의 서버는 내부 주소로, 외부 서버는 HTTPS 주소로 연결해 주세요.")
                }
                if !store.bundledServerPresets.isEmpty {
                    Section {
                        ForEach(store.bundledServerPresets, id: \.url.absoluteString) { preset in
                            Button {
                                address = preset.url.absoluteString
                            } label: {
                                HStack {
                                    Text(preset.label).foregroundColor(CPColor.ink)
                                    Spacer()
                                    Text(preset.url.absoluteString)
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                            }
                        }
                    } header: {
                        Text("등록된 서버")
                    } footer: {
                        Text("서버를 선택하면 주소가 채워집니다. 연결 후 거래소를 확인할 수 있어요.")
                    }
                }
                if let message {
                    Text(message).foregroundColor(CPColor.red)
                }
                Section {
                    Button {
                        Task {
                            let updated = await store.updateServerAddress(address)
                            if updated { dismiss() }
                            else { message = store.connectionMessage }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isWorking { ProgressView().padding(.trailing, 6) }
                            Text(store.isWorking ? "연결 중" : "저장하고 연결")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(store.isWorking)
                }
            }
            .cpSettingsFormStyle()
            .background(CPColor.paper)
            .navigationTitle("서버 주소")
            .cpInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                }
            }
        }
        .cpEditorSheetFrame()
    }
}

struct CoinPilotTokenEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var message: String?

    var body: some View {
        CoinPilotNavigationHost {
            Form {
                Section {
                    SecureField("서버 토큰 입력", text: $token)
                        .cpNoAutocapitalization()
                        .cpNoAutocorrection()
                } header: {
                    Text("서버 토큰")
                } footer: {
                    Text("\(store.serverAddress) 서버의 운영 토큰을 입력해 주세요. 기존 토큰은 새 토큰이 확인된 뒤 교체됩니다. 거래소 API 키는 서버에만 보관합니다.")
                }
                if let message {
                    Text(message).foregroundColor(CPColor.red)
                }
                Section {
                    Button {
                        Task {
                            if let error = await store.updateServerToken(token) {
                                message = error
                            } else {
                                token = ""
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isWorking { ProgressView().padding(.trailing, 6) }
                            Text(store.isWorking ? "토큰 확인 중" : "토큰 확인 후 저장")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(store.isWorking || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .cpSettingsFormStyle()
            .background(CPColor.paper)
            .navigationTitle("서버 토큰 입력")
            .cpInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") {
                        token = ""
                        dismiss()
                    }
                    .keyboardShortcut(.cancelAction)
                }
            }
        }
        .cpEditorSheetFrame()
    }
}
