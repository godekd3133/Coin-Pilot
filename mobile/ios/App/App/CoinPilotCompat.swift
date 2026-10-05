import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// iOS 전용 수식어를 macOS에서는 무시하는 호환 래퍼.
/// 네이티브 macOS 빌드와 iOS 빌드가 같은 뷰 코드를 공유할 수 있게 한다.
extension View {
    @ViewBuilder
    func cpEditorSheetFrame() -> some View {
        #if os(macOS)
        frame(minWidth: 560, idealWidth: 640, maxWidth: 760,
              minHeight: 420, idealHeight: 560, maxHeight: 700)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpSettingsFormStyle() -> some View {
        #if os(macOS)
        formStyle(.grouped)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpInlineTitle() -> some View {
        #if canImport(UIKit)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// 단일 화면 스택 동작은 iOS 전용 스타일; macOS에서는 기본 스타일을 둔다.
    @ViewBuilder
    func cpStackNavigation() -> some View {
        #if canImport(UIKit)
        navigationViewStyle(StackNavigationViewStyle())
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpKeyboardURL() -> some View {
        #if canImport(UIKit)
        keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpKeyboardNumberPad() -> some View {
        #if canImport(UIKit)
        keyboardType(.numberPad)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpKeyboardDecimalPad(allowNegative: Bool = false) -> some View {
        #if canImport(UIKit)
        keyboardType(allowNegative ? .numbersAndPunctuation : .decimalPad)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpNoAutocapitalization() -> some View {
        #if canImport(UIKit)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpAutocapitalizeCharacters() -> some View {
        #if canImport(UIKit)
        textInputAutocapitalization(.characters)
        #else
        self
        #endif
    }

    @ViewBuilder
    func cpNoAutocorrection() -> some View {
        autocorrectionDisabled(true)
    }

    /// 스크롤/드래그 중 키보드를 내린다. iOS 15에는 없는 API라 이전 버전에서는
    /// no-op이다.
    @ViewBuilder
    func cpScrollDismissesKeyboard() -> some View {
        #if canImport(UIKit)
        if #available(iOS 16.0, *) {
            scrollDismissesKeyboard(.interactively)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// 숫자 패드에는 리턴 키가 없으므로 상단에 "완료" 버튼을 띄운다.
    @ViewBuilder
    func cpKeyboardDoneToolbar() -> some View {
        #if canImport(UIKit)
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("완료") {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil, from: nil, for: nil
                    )
                }
            }
        }
        #else
        self
        #endif
    }

    /// macOS에서는 내용을 넓은 창에 맞춰 늘리지 않고 읽기 좋은 폭으로 중앙 정렬한다.
    /// iOS는 원래 폭을 그대로 쓴다.
    @ViewBuilder
    func cpReadableWidth() -> some View {
        #if os(macOS)
        frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        #else
        self
        #endif
    }

    /// `.navigationBarDrawer` 검색 배치는 macOS에 없다. iOS는 네비게이션 바에
    /// 상시 노출하고, macOS는 기본 배치(사이드바/자동)를 쓴다.
    @ViewBuilder
    func cpSearchableSheet<S: StringProtocol>(text: Binding<String>, prompt: S) -> some View {
        #if os(macOS)
        searchable(text: text, prompt: prompt)
        #else
        searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        #endif
    }
}

/// iOS의 네비게이션 바 위치를 macOS 툴바 위치로 매핑한다.
extension ToolbarItemPlacement {
    /// iOS 네비게이션 바 우측 ↔ macOS 주요 동작 영역.
    static var cpTrailing: ToolbarItemPlacement {
        #if canImport(UIKit)
        .navigationBarTrailing
        #else
        .primaryAction
        #endif
    }

    /// iOS 네비게이션 바 좌측 ↔ macOS 네비게이션(사이드바) 영역.
    static var cpLeading: ToolbarItemPlacement {
        #if canImport(UIKit)
        .navigationBarLeading
        #else
        .navigation
        #endif
    }
}

/// iOS는 `NavigationView`+stack, macOS는 `NavigationStack`을 쓴다.
/// macOS의 `NavigationView`는 master-detail 스플릿으로 렌더되어 본문이
/// 좁은 좌측 컬럼에 갇히고 우측이 빈 채로 남는다.
struct CoinPilotNavigationHost<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        #if os(macOS)
        NavigationStack { content }
        #else
        NavigationView { content }
            .cpStackNavigation()
        #endif
    }
}
