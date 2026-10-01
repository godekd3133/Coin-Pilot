import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// iOS 전용 수식어를 macOS에서는 무시하는 호환 래퍼.
/// 네이티브 macOS 빌드와 iOS 빌드가 같은 뷰 코드를 공유할 수 있게 한다.
extension View {
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
    func cpKeyboardDecimalPad() -> some View {
        #if canImport(UIKit)
        keyboardType(.decimalPad)
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
        #if os(macOS)
        self
        #else
        autocorrectionDisabled(true)
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
