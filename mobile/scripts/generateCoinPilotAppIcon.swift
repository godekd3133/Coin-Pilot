import AppKit
import Foundation

let size = 1024
let outputPath = CommandLine.arguments.dropFirst().first
    ?? "ios/App/App/CoinPilotMinimal.xcassets/CoinPilotAppIconFlat.appiconset/CoinPilotAppIconFlat.png"

guard let symbol = NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: "CoinPilot") else {
    fatalError("The required SF Symbol chart.bar.xaxis is unavailable.")
}

let canvas = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
)!

let graphics = NSGraphicsContext(bitmapImageRep: canvas)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.imageInterpolation = .high

let iconBounds = NSRect(x: 0, y: 0, width: size, height: size)
NSColor(calibratedRed: 49 / 255, green: 130 / 255, blue: 246 / 255, alpha: 1).setFill()
NSBezierPath(rect: iconBounds).fill()

let sizing = NSImage.SymbolConfiguration(pointSize: 560, weight: .medium, scale: .large)
let palette = NSImage.SymbolConfiguration(paletteColors: [.white])
let configuredSymbol = symbol.withSymbolConfiguration(sizing.applying(palette))!
configuredSymbol.draw(
    in: NSRect(x: 232, y: 232, width: 560, height: 560),
    from: .zero,
    operation: .sourceOver,
    fraction: 1,
    respectFlipped: false,
    hints: nil
)
NSGraphicsContext.restoreGraphicsState()

let png = canvas.representation(using: .png, properties: [:])!
try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
