import SwiftUI

struct CoinPilotTuningEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var numericDrafts: [String: String] = [:]
    @State private var booleanDrafts: [String: Bool] = [:]
    @State private var universeDraft = ""
    @State private var scalpMaxMarketsDraft = ""
    @State private var maxPositionsDraft = ""
    @State private var validationMessage: String?
    @State private var didLoadDrafts = false
    @State private var search = ""
    @State private var expandedCategories: Set<String> = []
    private let commonKeys: Set<String> = ["investmentRatio", "stopLossPercent", "takeProfitPercent", "maxHoldMinutes"]

    private var hasDraftChanges: Bool {
        if let values = try? CoinPilotTuningEdits.changes(fields: store.tuningFields, numeric: numericDrafts, boolean: booleanDrafts) {
            if !values.isEmpty { return true }
        } else { return true }
        guard showsUniverseEditor else { return false }
        let originalCoins = (store.tuningValues["targetCoins"] as? [String] ?? []).joined(separator: ", ")
        let originalMarkets = (store.tuningValues["scalpMaxMarkets"] as? Double).map(numberText) ?? ""
        let originalPositions = (store.tuningValues["maxPositions"] as? Double).map(numberText) ?? ""
        return universeDraft.trimmingCharacters(in: .whitespacesAndNewlines) != originalCoins ||
            scalpMaxMarketsDraft.trimmingCharacters(in: .whitespaces) != originalMarkets ||
            maxPositionsDraft.trimmingCharacters(in: .whitespaces) != originalPositions
    }

    private var showsUniverseEditor: Bool {
        store.tuningValues["targetCoins"] != nil || store.tuningValues["scalpMaxMarkets"] != nil
    }

    private var filteredFields: [CoinPilotTuningField] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.tuningFields.filter {
            query.isEmpty || CoinPilotTuningEdits.matches($0, query: query) ||
            categoryTitle($0.category).localizedCaseInsensitiveContains(query)
        }
    }

    private var commonFields: [CoinPilotTuningField] { filteredFields.filter { commonKeys.contains($0.key) } }

    private var categories: [String] {
        let priority = ["risk", "trading", "scalping", "rsi", "macd", "ema", "bb", "volume"]
        return Array(Set(filteredFields.filter { !commonKeys.contains($0.key) }.map(\.category))).sorted {
            let first = priority.firstIndex(of: $0.lowercased()) ?? priority.count
            let second = priority.firstIndex(of: $1.lowercased()) ?? priority.count
            return first == second ? $0 < $1 : first < second
        }
    }

    var body: some View {
        CoinPilotNavigationHost {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let blockReason = store.tuningBlockReason {
                        InlineNotice(text: blockReason, color: CPColor.amber)
                    }
                    if let message = validationMessage ?? (hasDraftChanges ? nil : store.tuningMessage) {
                        InlineNotice(text: message, color: validationMessage == nil && store.lastTuningSaveRefreshed ? CPColor.green : CPColor.amber)
                    }
                    if store.isLoadingTuning && store.tuningFields.isEmpty {
                        NativeCard {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("서버 설정을 불러오고 있습니다.")
                                    .font(.subheadline)
                                    .foregroundColor(CPColor.secondaryInk)
                            }
                        }
                    } else if store.tuningFields.isEmpty {
                        NativeCard {
                            EmptyMessage(text: store.tuningMessage ?? "이 서버에서 조정할 수 있는 튜닝값을 확인하지 못했습니다.")
                        }
                    } else {
                        HStack(spacing: 10) {
                            Image(systemName: "magnifyingglass").foregroundColor(CPColor.secondaryInk)
                            TextField("설정 검색", text: $search).textFieldStyle(.plain)
                                .cpNoAutocapitalization().cpNoAutocorrection().accessibilityLabel("설정 검색")
                            if !search.isEmpty {
                                Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                                    .frame(minWidth: 44, minHeight: 44).accessibilityLabel("설정 검색어 지우기")
                            }
                        }
                        .padding(.horizontal, 14).frame(minHeight: 48)
                        .background(CPColor.surface).clipShape(RoundedRectangle(cornerRadius: 12))
                        if filteredFields.isEmpty {
                            NativeCard { EmptyMessage(text: "맞는 설정이 없습니다.", actionTitle: "검색어 지우기") { search = "" } }
                        }
                        if !commonFields.isEmpty {
                            NativeCard {
                                VStack(alignment: .leading, spacing: 13) {
                                    SectionHeading(title: "기본 설정")
                                    fieldRows(commonFields)
                                }
                            }
                        }
                        ForEach(categories, id: \.self) { category in
                            NativeCard {
                                DisclosureGroup(isExpanded: Binding(
                                    get: { !search.isEmpty || expandedCategories.contains(category) },
                                    set: { if $0 { expandedCategories.insert(category) } else { expandedCategories.remove(category) } }
                                )) {
                                    fieldRows(filteredFields.filter { $0.category == category && !commonKeys.contains($0.key) })
                                        .padding(.top, 12)
                                } label: {
                                    Text(categoryTitle(category)).font(.subheadline.weight(.semibold))
                                        .foregroundColor(CPColor.ink).frame(minHeight: 44)
                                }
                            }
                        }
                    }
                    if showsUniverseEditor && search.isEmpty {
                        NativeDisclosureCard(title: "분석 대상 시장") {
                            VStack(alignment: .leading, spacing: 13) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("대상 코인")
                                        .font(.body.weight(.medium))
                                        .foregroundColor(CPColor.ink)
                                    TextField(store.quoteCurrency == "USDT" ? "USDT-BTC, USDT-ETH 또는 ALL" : "KRW-BTC, KRW-ETH 또는 ALL", text: $universeDraft)
                                        .accessibilityLabel("분석 대상 코인")
                                        .cpNoAutocapitalization()
                                        .cpNoAutocorrection()
                                        .multilineTextAlignment(.leading)
                                        .textFieldStyle(.plain)
                                        .frame(minHeight: 38)
                                        .padding(.horizontal, 8)
                                        .background(CPColor.paper)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    Text("쉼표로 구분한 KRW-·USDT- 형식 코드이거나 ALL입니다. ALL은 유동성 상위 마켓을 다시 선택합니다.")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Divider().overlay(CPColor.line)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("스캔 마켓 수 상한")
                                        .font(.body.weight(.medium))
                                        .foregroundColor(CPColor.ink)
                                    TextField("20", text: $scalpMaxMarketsDraft)
                                        .accessibilityLabel("스캔 마켓 수 상한")
                                        .cpKeyboardNumberPad()
                                        .multilineTextAlignment(.trailing)
                                        .textFieldStyle(.plain)
                                        .frame(width: 106)
                                        .frame(minHeight: 38)
                                        .padding(.horizontal, 8)
                                        .background(CPColor.paper)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    Text("ALL 선택 시 유동성 상위로 자를 최대 마켓 수 (1~500)")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("최대 동시 포지션")
                                        .font(.body.weight(.medium))
                                        .foregroundColor(CPColor.ink)
                                    TextField("3", text: $maxPositionsDraft)
                                        .accessibilityLabel("최대 동시 포지션")
                                        .cpKeyboardNumberPad()
                                        .multilineTextAlignment(.trailing)
                                        .textFieldStyle(.plain)
                                        .frame(width: 106)
                                        .frame(minHeight: 38)
                                        .padding(.horizontal, 8)
                                        .background(CPColor.paper)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    Text("동시에 보유할 수 있는 최대 포지션 수 (1~50)")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }

                            }
                        }
                    }
                    Text("설정은 \(store.activeWorkspace.title) 서버에만 적용됩니다. 자동매매 실행 중이거나 성과 점검이 잠긴 동안에는 저장할 수 없습니다.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .cpReadableWidth()
            .background(CPColor.paper.ignoresSafeArea())
            .navigationTitle("튜닝값 설정")
            .cpInlineTitle()
            .cpScrollDismissesKeyboard()
            .cpKeyboardDoneToolbar()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(store.isSavingTuning ? "저장 중" : "저장") {
                        save()
                    }
                    .disabled(store.isSavingTuning || store.isLoadingTuning || store.tuningBlockReason != nil || store.tuningFields.isEmpty || !hasDraftChanges)
                }
            }
        }
        .cpEditorSheetFrame()
        .task {
            if await store.loadTuning() { hydrateDrafts() }
        }
    }

    @ViewBuilder
    private func tuningRow(_ field: CoinPilotTuningField) -> some View {
        if let booleanValue = field.booleanValue {
            Toggle(field.label, isOn: booleanBinding(for: field, fallback: booleanValue))
                .font(.body.weight(.medium))
                .tint(CPColor.blue)
            if !field.description.isEmpty {
                DisclosureGroup("설명") {
                    Text(field.description).font(.caption).foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 5)
                }.font(.caption).frame(minHeight: 44)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 12) {
                    Text(field.label)
                        .font(.body.weight(.medium))
                        .foregroundColor(CPColor.ink)
                    Spacer(minLength: 4)
                    TextField("값", text: numericBinding(for: field))
                        .cpKeyboardDecimalPad(allowNegative: (field.minimum ?? 0) < 0)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.plain)
                        .frame(width: 106)
                        .frame(minHeight: 38)
                        .padding(.horizontal, 8)
                        .background(CPColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel(field.label)
                }
                if !field.description.isEmpty {
                    DisclosureGroup("설명") {
                        Text(field.description).font(.caption).foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 5)
                    }.font(.caption).frame(minHeight: 36)
                }
                if let minimum = field.minimum, let maximum = field.maximum {
                    let multiplier = field.displayMultiplier
                    MetadataLine(text: "허용 범위 \(numberText(minimum * multiplier))~\(numberText(maximum * multiplier)) · 간격 \(numberText((field.step ?? 0) * multiplier))")
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                }
            }
        }
    }

    private func numericBinding(for field: CoinPilotTuningField) -> Binding<String> {
        Binding(
            get: { self.numericDrafts[field.key] ?? field.displayValue.map(self.numberText) ?? "" },
            set: { self.numericDrafts[field.key] = $0; self.validationMessage = nil }
        )
    }

    private func booleanBinding(for field: CoinPilotTuningField, fallback: Bool) -> Binding<Bool> {
        Binding(
            get: { self.booleanDrafts[field.key] ?? fallback },
            set: { self.booleanDrafts[field.key] = $0; self.validationMessage = nil }
        )
    }

    private func hydrateDrafts() {
        var numeric: [String: String] = [:]
        var boolean: [String: Bool] = [:]
        for field in store.tuningFields {
            if let value = field.booleanValue { boolean[field.key] = value }
            if let value = field.displayValue { numeric[field.key] = numberText(value) }
        }
        numericDrafts = numeric
        booleanDrafts = boolean
        if let coins = store.tuningValues["targetCoins"] as? [String] {
            universeDraft = coins.joined(separator: ", ")
        }
        if let limit = store.tuningValues["scalpMaxMarkets"] as? Double {
            scalpMaxMarketsDraft = numberText(limit)
        }
        if let cap = store.tuningValues["maxPositions"] as? Double {
            maxPositionsDraft = numberText(cap)
        }
        didLoadDrafts = true
    }

    private func universeChanges() -> [String: Any]? {
        var updates: [String: Any] = [:]
        let trimmedUniverse = universeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let originalUniverse = (store.tuningValues["targetCoins"] as? [String] ?? []).joined(separator: ", ")
        if trimmedUniverse != originalUniverse {
            if trimmedUniverse.uppercased() == "ALL" {
                updates["targetCoins"] = "ALL"
            } else {
                let codes = trimmedUniverse.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespaces).uppercased()
                }
                guard !codes.isEmpty,
                      codes.allSatisfy({
                          $0.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil
                      }) else {
                    validationMessage = "대상 코인: KRW-·USDT- 코드를 쉼표로 구분하거나 ALL."
                    return nil
                }
                updates["targetCoins"] = codes
            }
        }
        let trimmedMaxMarkets = scalpMaxMarketsDraft.trimmingCharacters(in: .whitespaces)
        let originalMaxMarkets = (store.tuningValues["scalpMaxMarkets"] as? Double).map(numberText) ?? ""
        if trimmedMaxMarkets != originalMaxMarkets {
            guard let value = Int(trimmedMaxMarkets), (1...500).contains(value) else {
                validationMessage = "스캔 마켓 수 상한: 1~500 정수."
                return nil
            }
            updates["scalpMaxMarkets"] = value
        }
        let trimmedMaxPositions = maxPositionsDraft.trimmingCharacters(in: .whitespaces)
        let originalMaxPositions = (store.tuningValues["maxPositions"] as? Double).map(numberText) ?? ""
        if trimmedMaxPositions != originalMaxPositions {
            guard let value = Int(trimmedMaxPositions), (1...50).contains(value) else {
                validationMessage = "최대 동시 포지션: 1~50 정수."
                return nil
            }
            updates["maxPositions"] = value
        }
        return updates
    }

    private func save() {
        guard didLoadDrafts else { return }
        var updates: [String: Any]
        do {
            updates = try CoinPilotTuningEdits.changes(fields: store.tuningFields, numeric: numericDrafts, boolean: booleanDrafts)
        } catch let error as CoinPilotTuningEditError {
            validationMessage = error.message
            return
        } catch { return }
        if showsUniverseEditor {
            guard let marketChanges = universeChanges() else { return }
            updates.merge(marketChanges) { _, latest in latest }
        }
        guard !updates.isEmpty else {
            validationMessage = "변경한 설정이 없습니다."
            return
        }
        validationMessage = nil
        Task {
            if await store.saveTuning(updates), store.lastTuningSaveRefreshed { hydrateDrafts() }
        }
    }

    private func fieldRows(_ fields: [CoinPilotTuningField]) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            ForEach(fields) { field in
                tuningRow(field)
                if field.id != fields.last?.id { Divider().overlay(CPColor.line) }
            }
        }
    }

    private func categoryTitle(_ value: String) -> String {
        switch value.lowercased() {
        case "investment": return "투자 금액"
        case "risk": return "위험 관리"
        case "trading": return "매매 조건"
        case "volume": return "거래량"
        case "scalping": return "전략 진입·보유"
        default: return value
        }
    }

    private func numberText(_ value: Double) -> String {
        CoinPilotFormatting.editableNumber(value)
    }
}
