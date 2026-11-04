import SwiftUI

struct CoinPilotLocalMarketView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var search = ""

    private var visibleMarkets: [CoinPilotBundledMarketData.Market] {
        (store.localMarketData?.markets ?? []).filter { market in
            search.isEmpty || market.market.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("오프라인 시세", systemImage: "internaldrive")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CPColor.blue)
                        Text("앱에 저장된 고정 시세로 가격 흐름을 보고 과거 구간을 계산해요. 출처와 최신 여부는 온라인에서 확인하지 않으며, 계좌 연결이나 주문 기능은 없습니다.")
                            .font(.subheadline)
                            .foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        MetadataLine(text: store.freshnessLabel(for: "market-prices"))
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                            .textSelection(.enabled)
                    }
                }

                if let recoveryMessage = store.offlineReplaySessionRecoveryMessage {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "과거 재생 상태 복구 필요")
                            Text(recoveryMessage)
                                .font(.footnote)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("저장된 재생 상태 지우기") {
                                Task { _ = await store.resetOfflineReplaySession() }
                            }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                        }
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "원화 시장")
                        if let error = store.localMarketDataError {
                            EmptyMessage(text: error)
                        } else if store.localMarketData == nil {
                            ProgressView("시세 자료 불러오는 중")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "magnifyingglass")
                                    .font(.subheadline)
                                    .foregroundColor(CPColor.secondaryInk)
                                TextField("시장 검색", text: $search)
                                    .cpAutocapitalizeCharacters()
                                    .cpNoAutocorrection()
                                    .textFieldStyle(.plain)
                                if !search.isEmpty {
                                    Button {
                                        search = ""
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(CPColor.secondaryInk)
                                    }
                                    .accessibilityLabel("검색어 지우기")
                                }
                            }
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(CPColor.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            if visibleMarkets.isEmpty {
                                EmptyMessage(text: "검색 결과가 없습니다.")
                            } else {
                                VStack(spacing: 0) {
                                    ForEach(visibleMarkets) { market in
                                        NavigationLink(destination: CoinPilotLocalMarketDetailView(store: store, marketCode: market.market)) {
                                            localMarketRow(market)
                                        }
                                        .buttonStyle(CoinPilotPressableButtonStyle())
                                        if market.id != visibleMarkets.last?.id {
                                            Divider().overlay(CPColor.line)
                                        }
                                    }
                                }
                            }
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
    }

    private func localMarketRow(_ market: CoinPilotBundledMarketData.Market) -> some View {
        let latest = store.localMarketLatestCandle(for: market.market)
        let windowCandles = market.candles
            .filter { $0.intervalMinutes == (latest?.intervalMinutes ?? -1) }
            .sorted(by: { $0.timestamp < $1.timestamp })
        let windowChange: Double? = {
            guard let first = windowCandles.first?.open, let last = windowCandles.last?.close,
                  first.isFinite, last.isFinite, first > 0 else { return nil }
            return (last - first) / first * 100
        }()
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(CoinPilotFormatting.symbol(market.market))
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                    MetadataLine(text: "\(market.market) · \(latest.map { "\($0.intervalMinutes)분 캔들" } ?? "캔들 자료 없음")")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(CoinPilotFormatting.price(latest?.close))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundColor(CPColor.ink)
                    if let windowChange {
                        Text("구간 \(CoinPilotFormatting.percent(windowChange))")
                            .font(.caption2.weight(.medium))
                            .monospacedDigit()
                            .foregroundColor(profitColor(windowChange))
                    }
                }
            }
            if let latest {
                Text(store.localMarketTimestampLabel(for: market.market, interval: latest.intervalMinutes))
                    .font(.caption2)
                    .foregroundColor(CPColor.secondaryInk)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 10)
    }
}

struct CoinPilotLocalMarketDetailView: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var showsOfflineReplayResult = false
    let marketCode: String

    private var intervals: [Int] { store.localMarketIntervals(for: marketCode) }

    private var selectedInterval: Int {
        intervals.contains(store.selectedCandleInterval) ? store.selectedCandleInterval : (intervals.first ?? 5)
    }

    private var latestCandle: CoinPilotBundledMarketData.Candle? {
        store.localMarketLatestCandle(for: marketCode, interval: selectedInterval)
    }

    private var offlineReplayBlockReason: String? {
        store.offlineReplayBlockReason(forMarket: marketCode, intervalMinutes: selectedInterval)
    }

    private var sessionMatchesSelection: Bool {
        guard let checkpoint = store.offlineReplaySessionCheckpoint else { return true }
        return checkpoint.market == marketCode && checkpoint.intervalMinutes == selectedInterval
    }

    private var playbackTaskID: String {
        "\(scenePhase == .active)-\(store.offlineReplaySessionPlaybackTaskID(forMarket: marketCode, intervalMinutes: selectedInterval))"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = store.localMarketDataError {
                    NativeCard { EmptyMessage(text: error) }
                } else {
                    playbackSessionSection

                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(CoinPilotFormatting.symbol(marketCode))
                                        .font(.title2.weight(.bold))
                                        .foregroundColor(CPColor.ink)
                                    MetadataLine(text: "\(marketCode) · 앱에 저장된 고정 시세")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                                Spacer()
                                Text(CoinPilotFormatting.price(latestCandle?.close))
                                    .font(.title3.weight(.bold))
                                    .monospacedDigit()
                            }
                            let visibleLows = store.candles.compactMap(\.low)
                            let visibleHighs = store.candles.compactMap(\.high)
                            if let low = visibleLows.min(), let high = visibleHighs.max(),
                               let last = latestCandle?.close, high > low {
                                CoinPilotPriceRangeBar(
                                    low: low, high: high, price: last,
                                    lowLabel: "표시 구간 저가", highLabel: "표시 구간 고가"
                                )
                            }
                            Text(store.localMarketTimestampLabel(for: marketCode, interval: selectedInterval))
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                                .textSelection(.enabled)
                        }
                    }

                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                SectionHeading(title: "캔들 기록")
                                Spacer()
                                Text("캔들 시각은 UTC")
                                    .font(.caption)
                                    .foregroundColor(CPColor.secondaryInk)
                            }
                            if !intervals.isEmpty {
                                Picker("캔들 간격", selection: Binding(
                                    get: { selectedInterval },
                                    set: { value in
                                        Task {
                                            await store.pauseOfflineReplaySessionForInterruption()
                                            await store.loadMarketDetail(coin: marketCode, interval: value)
                                        }
                                    }
                                )) {
                                    ForEach(intervals, id: \.self) { interval in
                                        Text(interval == 60 ? "1시간" : "\(interval)분").tag(interval)
                                    }
                                }
                                .pickerStyle(SegmentedPickerStyle())
                            }
                            if let message = store.featureMessages["market"] {
                                EmptyMessage(text: message)
                            } else if store.candles.count < 2 {
                                EmptyMessage(text: "차트를 표시할 가격 기록이 충분하지 않습니다.")
                            } else {
                                CoinPilotCandleChart(candles: store.candles)
                                    .frame(height: 228)
                                if let windowLabel = store.localMarketChartWindowLabel(for: marketCode, interval: selectedInterval) {
                                    Text(windowLabel)
                                        .font(.caption2)
                                        .foregroundColor(CPColor.secondaryInk)
                                        .textSelection(.enabled)
                                }
                            }
                            CoinPilotCandleDataDisclosure(candles: store.candles)
                            Text(store.localMarketTimestampLabel(for: marketCode, interval: selectedInterval))
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                                .textSelection(.enabled)
                            Text("출처와 최신 여부는 온라인으로 확인하지 않습니다.")
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                            if let generatedAt = store.localMarketData?.generatedAt {
                                MetadataLine(text: "시세 자료 생성 시각 · \(CoinPilotFormatting.utcMarketTimestamp(generatedAt))")
                                    .font(.caption2)
                                    .foregroundColor(CPColor.secondaryInk)
                                    .textSelection(.enabled)
                            }
                        }
                    }

                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "과거 시세 재생")
                            Text("선택한 간격의 전체 캔들로 기본 전략을 계산해요. 결과는 이 기기에 저장하고 주문은 보내지 않습니다.")
                                .font(.subheadline)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)

                            Button {
                                Task {
                                    if await store.runBundledOfflineReplay(
                                        marketCode: marketCode,
                                        intervalMinutes: selectedInterval
                                    ) {
                                        showsOfflineReplayResult = true
                                    }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    if store.isRunningOfflineReplay {
                                        ProgressView()
                                            .progressViewStyle(CircularProgressViewStyle(tint: CPColor.blue))
                                    } else {
                                        Image(systemName: "play.fill")
                                            .accessibilityHidden(true)
                                    }
                                    Text(store.isRunningOfflineReplay ? "과거 시세를 살펴보고 있어요" : "과거 구간 돌려보기")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(CoinPilotPrimaryButtonStyle())
                            .disabled(store.isLoadingLocalMarketData || store.localMarketDataError != nil ||
                                      store.isRunningOfflineReplay || offlineReplayBlockReason != nil)
                            .accessibilityHint("선택한 시장과 간격의 전체 캔들을 사용합니다.")

                            if let message = store.offlineReplayMessage {
                                InlineNotice(text: message, color: CPColor.amber)
                            } else if store.isRunningOfflineReplay {
                                Text("자료와 시간 간격을 확인한 뒤 결과를 계산합니다.")
                                    .font(.caption)
                                    .foregroundColor(CPColor.secondaryInk)
                            } else if let offlineReplayBlockReason {
                                Text(offlineReplayBlockReason)
                                    .font(.caption)
                                    .foregroundColor(CPColor.amber)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let message = store.offlineReplayPersistenceMessage {
                                Text(message)
                                    .font(.caption)
                                    .foregroundColor(CPColor.amber)
                            }
                            if let previousResult = store.offlineReplayResults.first(where: {
                                $0.metadata.market == marketCode && $0.metadata.intervalMinutes == selectedInterval
                            }) {
                                Button {
                                    store.selectOfflineReplayResult(previousResult)
                                    showsOfflineReplayResult = true
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text("저장된 결과")
                                                .font(.caption)
                                                .foregroundColor(CPColor.secondaryInk)
                                            Spacer(minLength: 8)
                                            Text(CoinPilotFormatting.percent(previousResult.summary.totalReturnPercent))
                                                .font(.caption.weight(.semibold))
                                                .monospacedDigit()
                                                .foregroundColor(profitColor(previousResult.summary.totalReturnPercent))
                                        }
                                        MetadataLine(text: "자료 생성 \(utcReplayTimestampFromISO8601(previousResult.metadata.generatedAt)) · 캔들 \(previousResult.metadata.rowCount)개")
                                            .font(.caption2)
                                            .foregroundColor(CPColor.secondaryInk)
                                            .multilineTextAlignment(.leading)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(CoinPilotPressableButtonStyle())
                                .accessibilityHint("이 시장과 간격의 저장된 과거 재생 결과를 엽니다.")
                            }
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
        .navigationTitle(CoinPilotFormatting.ticker(marketCode))
        .cpInlineTitle()
        .task { await store.loadMarketDetail(coin: marketCode, interval: selectedInterval) }
        .task(id: playbackTaskID) {
            guard scenePhase == .active,
                  let delay = store.offlineReplaySessionDelayNanoseconds(
                    forMarket: marketCode,
                    intervalMinutes: selectedInterval
                  ) else { return }
            do {
                try await Task.sleep(nanoseconds: delay)
            } catch {
                return
            }
            guard !Task.isCancelled, scenePhase == .active else { return }
            _ = await store.advanceOfflineReplaySession(marketCode: marketCode, intervalMinutes: selectedInterval)
        }
        .cpOnChange(of: scenePhase) { phase in
            if phase != .active {
                Task { await store.pauseOfflineReplaySessionForInterruption() }
            }
        }
        .onDisappear {
            Task { await store.pauseOfflineReplaySessionForInterruption() }
        }
        .sheet(isPresented: $showsOfflineReplayResult) {
            if let result = store.offlineReplayResult {
                CoinPilotNavigationHost {
                    CoinPilotOfflineReplayResultView(result: result)
                        .navigationTitle("과거 시세 재생")
                        .cpInlineTitle()
                        .toolbar {
                            ToolbarItem(placement: .cpTrailing) {
                                Button("닫기") { showsOfflineReplayResult = false }
                            }
                        }
                }
            }
        }
    }

    private var playbackSessionSection: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "빠른 과거 재생")
                Text("앱에 저장된 고정 캔들을 순서대로 살펴봅니다. 종가와 가상 잔액은 과거 시뮬레이션 값이며 현재 시세·계좌·체결이 아닙니다.")
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                Picker("재생 속도", selection: Binding(
                    get: { store.offlineReplayPlaybackSpeed },
                    set: { speed in Task { _ = await store.setOfflineReplayPlaybackSpeed(speed) } }
                )) {
                    ForEach(CoinPilotOfflineReplayPlaybackSpeed.allCases) { speed in
                        Text(speed.title).tag(speed)
                    }
                }
                .pickerStyle(SegmentedPickerStyle())

                Text("비정상 종료 뒤에는 마지막 저장 시점부터 최대 1초 구간이 다시 재생될 수 있습니다. 재생 위치는 한 번에 한 캔들씩 이어집니다.")
                    .font(.caption2)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                if let recoveryMessage = store.offlineReplaySessionRecoveryMessage {
                    InlineNotice(text: recoveryMessage, color: CPColor.amber)
                    Button("저장된 재생 상태 지우기") {
                        Task { _ = await store.resetOfflineReplaySession() }
                    }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                } else if !sessionMatchesSelection {
                    Text("다른 시장 또는 간격의 재생 기록이 있습니다. 처음부터 다시 설정한 뒤 시작하세요.")
                        .font(.footnote)
                        .foregroundColor(CPColor.amber)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("기록을 지우고 처음부터") {
                        Task { _ = await store.resetOfflineReplaySession() }
                    }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.isUpdatingOfflineReplaySession)
                } else {
                    sessionPlaybackState
                    if let message = store.offlineReplaySessionMessage {
                        InlineNotice(text: message, color: CPColor.amber)
                    }
                    sessionPlaybackControls
                }
            }
        }
    }

    @ViewBuilder
    private var sessionPlaybackState: some View {
        if let checkpoint = store.offlineReplaySessionCheckpoint {
            HStack {
                Text(sessionStatusTitle(checkpoint.status))
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                Spacer()
                Text("\(checkpoint.nextCandleIndex) / \(checkpoint.candleCount) 캔들")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(CPColor.secondaryInk)
            }
            ProgressView(value: Double(checkpoint.nextCandleIndex), total: Double(max(checkpoint.candleCount, 1)))
                .tint(CPColor.blue)
                .accessibilityLabel("재생 진행률")
                .accessibilityValue("\(checkpoint.nextCandleIndex)/\(checkpoint.candleCount) 캔들")
            if let frame = store.offlineReplaySessionFrame {
                VStack(alignment: .leading, spacing: 5) {
                    MetadataLine(text: "당시 캔들 종가 · \(utcReplayTimestamp(frame.timestampMilliseconds))")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(CoinPilotFormatting.price(frame.historicalClose))
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .foregroundColor(CPColor.ink)
                    if let equity = frame.historicalSimulationEquity {
                        MetadataLine(text: "과거 가상 잔액 · \(CoinPilotFormatting.price(equity))")
                            .font(.caption.weight(.medium))
                            .foregroundColor(CPColor.secondaryInk)
                    } else {
                        Text("전략 계산 준비 구간")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } else {
            HStack {
                Text("정지")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                Spacer()
                Text("0 / \(store.localMarketData?.markets.first(where: { $0.market == marketCode })?.candles.filter { $0.intervalMinutes == selectedInterval }.count ?? 0) 캔들")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(CPColor.secondaryInk)
            }
        }
    }

    @ViewBuilder
    private var sessionPlaybackControls: some View {
        let status = store.offlineReplaySessionCheckpoint?.status ?? .stopped
        switch status {
        case .stopped:
            Button(store.isPreparingOfflineReplaySession ? "준비 중" : "과거 캔들 재생") {
                Task { _ = await store.startOfflineReplaySession(marketCode: marketCode, intervalMinutes: selectedInterval) }
            }
            .buttonStyle(CoinPilotPrimaryButtonStyle())
            .disabled(store.isPreparingOfflineReplaySession || store.isUpdatingOfflineReplaySession || offlineReplayBlockReason != nil)
        case .playing:
            HStack(spacing: 10) {
                Button("일시정지") { Task { _ = await store.pauseOfflineReplaySession() } }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.isUpdatingOfflineReplaySession)
                Button("처음부터") { Task { _ = await store.resetOfflineReplaySession() } }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.isUpdatingOfflineReplaySession)
            }
        case .paused:
            HStack(spacing: 10) {
                Button("계속 재생") { Task { _ = await store.resumeOfflineReplaySession() } }
                    .buttonStyle(CoinPilotPrimaryButtonStyle())
                    .disabled(store.isUpdatingOfflineReplaySession)
                Button("처음부터") { Task { _ = await store.resetOfflineReplaySession() } }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.isUpdatingOfflineReplaySession)
            }
        case .completed:
            HStack(spacing: 10) {
                Button("처음부터 재생") {
                    Task {
                        if await store.resetOfflineReplaySession() {
                            _ = await store.startOfflineReplaySession(marketCode: marketCode, intervalMinutes: selectedInterval)
                        }
                    }
                }
                .buttonStyle(CoinPilotPrimaryButtonStyle())
                Button("전체 결과 보기") { showsOfflineReplayResult = store.offlineReplayResult != nil }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.offlineReplayResult == nil)
            }
        }
    }

    private func sessionStatusTitle(_ status: CoinPilotOfflineReplaySessionStatus) -> String {
        switch status {
        case .stopped: return "정지"
        case .playing: return "재생 중"
        case .paused: return "일시정지"
        case .completed: return "완료"
        }
    }
}

struct CoinPilotOfflineReplayResultView: View {
    let result: CoinPilotOfflineReplay.Result

    private var metadata: CoinPilotOfflineReplay.Metadata { result.metadata }
    private var summary: CoinPilotOfflineReplay.Summary { result.summary }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        MetadataLine(text: "\(CoinPilotFormatting.symbol(metadata.market)) · \(intervalTitle(metadata.intervalMinutes))")
                            .font(.title3.weight(.bold))
                            .foregroundColor(CPColor.ink)
                        MetadataLine(text: "앱에 저장된 고정 시세 · 캔들 \(metadata.rowCount)개")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                        Text("출처와 최신 여부는 온라인으로 확인하지 않습니다.")
                            .font(.caption2)
                            .foregroundColor(CPColor.secondaryInk)
                        Text("\(utcReplayTimestamp(metadata.startTimestampMilliseconds)) – \(utcReplayTimestamp(metadata.endTimestampMilliseconds))")
                            .font(.caption2)
                            .foregroundColor(CPColor.secondaryInk)
                            .textSelection(.enabled)
                        Divider().overlay(CPColor.line)
                        Text("시뮬레이션 후 잔액")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                        Text(CoinPilotFormatting.price(summary.finalBalance))
                            .font(.largeTitle.weight(.bold))
                            .monospacedDigit()
                            .foregroundColor(CPColor.ink)
                        HStack(spacing: 14) {
                            Text("수익률 \(CoinPilotFormatting.percent(summary.totalReturnPercent))")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(profitColor(summary.totalReturnPercent))
                            Text("완료 거래 \(summary.completedTradeCount)건")
                                .font(.caption.weight(.medium))
                                .foregroundColor(CPColor.secondaryInk)
                        }
                    }
                }

                if !result.equityCurve.isEmpty {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "잔액 흐름")
                            CoinPilotOfflineReplayEquityChart(
                                points: result.equityCurve,
                                returnPercent: summary.totalReturnPercent
                            )
                            .frame(height: 118)
                            HStack {
                                Text(CoinPilotFormatting.price(summary.initialBalance))
                                Spacer()
                                Text(CoinPilotFormatting.price(summary.finalBalance))
                            }
                            .font(.caption2.monospacedDigit())
                            .foregroundColor(CPColor.secondaryInk)
                            Text("각 시점은 캔들 종가로 계산했고, 마지막 금액에는 구간 종료 비용을 반영했습니다.")
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "거래 기록")
                        if result.trades.isEmpty {
                            EmptyMessage(text: "이 구간에서 기본 전략 조건을 만족한 거래가 없습니다.")
                        } else {
                            ForEach(Array(result.trades.suffix(20).reversed().enumerated()), id: \.offset) { item in
                                let trade = item.element
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack {
                                        Text(exitReasonTitle(trade.reason))
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundColor(CPColor.ink)
                                        Spacer()
                                        Text(CoinPilotFormatting.percent(trade.profitPercent))
                                            .font(.subheadline.weight(.semibold))
                                            .monospacedDigit()
                                            .foregroundColor(profitColor(trade.profitPercent))
                                    }
                                    Text("진입 \(utcReplayTimestamp(trade.entryTimestampMilliseconds))")
                                    Text("청산 \(utcReplayTimestamp(trade.exitTimestampMilliseconds))")
                                    MetadataLine(text: "손익 \(CoinPilotFormatting.signedWon(trade.netProfit)) · 수수료 \(CoinPilotFormatting.price(trade.buyFee + trade.sellFee))")
                                }
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                                .textSelection(.enabled)
                                if item.offset < min(result.trades.count, 20) - 1 {
                                    Divider().overlay(CPColor.line)
                                }
                            }
                        }
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeading(title: "계산 기준")
                        PaperEvidenceRow(title: "시작 금액", value: CoinPilotFormatting.price(summary.initialBalance), tint: CPColor.ink)
                        PaperEvidenceRow(title: "거래 수수료", value: CoinPilotFormatting.price(summary.fees), tint: CPColor.ink)
                        PaperEvidenceRow(title: "자료 생성", value: utcReplayTimestampFromISO8601(metadata.generatedAt), tint: CPColor.secondaryInk)
                        Text("매수와 매도에 각각 수수료 0.05%, 슬리피지 0.10%를 적용했습니다.")
                        Text("같은 캔들에서 손절과 목표가가 함께 닿으면 손절을 먼저 적용하고, 시가가 손절가보다 낮으면 시가로 계산했습니다.")
                        Text("분봉만으로 체결 시점을 알 수 없어 다음 캔들이 시작한 가격으로 진입했다고 계산했습니다. 실제 거래 결과와 다를 수 있습니다.")
                    }
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
    }
}

struct CoinPilotOfflineReplayEquityChart: View {
    let points: [CoinPilotOfflineReplay.EquityPoint]
    let returnPercent: Double

    private var sampledValues: [Double] {
        let values = points.map(\.equity).filter(\.isFinite)
        guard values.count > 600 else { return values }
        return (0..<600).map { sampleIndex in
            let sourceIndex = Int((Double(sampleIndex) * Double(values.count - 1) / 599).rounded())
            return values[sourceIndex]
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let values = sampledValues
            let minimum = values.min() ?? 0
            let maximum = values.max() ?? minimum
            let spread = max(maximum - minimum, 1)
            let width = geometry.size.width
            let height = geometry.size.height

            ZStack(alignment: .topLeading) {
                Path { path in
                    guard values.count > 1 else { return }
                    for (index, value) in values.enumerated() {
                        let x = width * CGFloat(index) / CGFloat(values.count - 1)
                        let y = maximum == minimum
                            ? height / 2
                            : height - (CGFloat(value - minimum) / CGFloat(spread)) * height
                        if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(profitColor(returnPercent), style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                if values.count > 1 {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(CoinPilotFormatting.compactWon(maximum))
                            .font(.caption2.monospacedDigit())
                        Spacer(minLength: 0)
                        Text(CoinPilotFormatting.compactWon(minimum))
                            .font(.caption2.monospacedDigit())
                    }
                    .foregroundColor(CPColor.secondaryInk)
                    .padding(3)
                    if let lastValue = values.last {
                        let lastY = maximum == minimum
                            ? height / 2
                            : height - (CGFloat(lastValue - minimum) / CGFloat(spread)) * height
                        Circle()
                            .fill(profitColor(returnPercent))
                            .frame(width: 6, height: 6)
                            .overlay(Circle().stroke(CPColor.surface, lineWidth: 1.5))
                            .position(x: max(width - 4, 0), y: lastY)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("과거 구간 잔액 흐름")
            .accessibilityValue("시작 \(CoinPilotFormatting.price(points.first?.equity)) · 마지막 \(CoinPilotFormatting.price(points.last?.equity)) · 최저 \(CoinPilotFormatting.price(minimum)) · 최고 \(CoinPilotFormatting.price(maximum))")
        }
    }
}

func intervalTitle(_ interval: Int) -> String {
    interval == 60 ? "1시간 캔들" : "\(interval)분 캔들"
}

func utcReplayTimestamp(_ milliseconds: Int64) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy. MM. dd. HH:mm:ss 'UTC'"
    return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
}

func utcReplayTimestampFromISO8601(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
        return utcReplayTimestamp(Int64((date.timeIntervalSince1970 * 1_000).rounded()))
    }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: value) else { return "시각 미제공" }
    return utcReplayTimestamp(Int64((date.timeIntervalSince1970 * 1_000).rounded()))
}

func exitReasonTitle(_ reason: String) -> String {
    switch reason {
    case "TAKE_PROFIT": return "목표 가격 도달"
    case "STOP_LOSS": return "손절 기준 도달"
    case "MAX_HOLD_TIME": return "보유 시간 종료"
    case "BACKTEST_END": return "자료 구간 종료"
    default: return "청산"
    }
}
