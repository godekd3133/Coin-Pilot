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
                    Text("같은 Wi-Fi 서버는 내부 주소, 외부 서버는 HTTPS 주소.")
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
                        Text("서버 선택 시 주소 자동 입력.")
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
                    Text("\(store.serverAddress) 서버 운영 토큰. 새 토큰 확인 후 기존 토큰 교체. 거래소 API 키는 서버에만 보관.")
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
