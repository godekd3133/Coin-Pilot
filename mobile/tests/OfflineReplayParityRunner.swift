import Foundation

@main
struct OfflineReplayParityRunner {
    static func main() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(CoinPilotOfflineReplay.Request.self, from: input)
        let result = try CoinPilotOfflineReplay.run(request)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let output = try encoder.encode(result)
        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
