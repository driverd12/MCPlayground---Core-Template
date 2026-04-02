import AVFoundation
import Foundation

enum DesktopListenError: Error, LocalizedError {
    case invalidArguments
    case recorderUnavailable
    case recordStartFailed

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "usage: swift desktop_listen.swift <output-path> <duration-seconds>"
        case .recorderUnavailable:
            return "unable to initialize AVAudioRecorder"
        case .recordStartFailed:
            return "failed to start microphone capture"
        }
    }
}

func main() throws {
    guard CommandLine.arguments.count >= 3 else {
        throw DesktopListenError.invalidArguments
    }

    let outputPath = CommandLine.arguments[1]
    let duration = max(1.0, min(300.0, Double(CommandLine.arguments[2]) ?? 5.0))
    let outputURL = URL(fileURLWithPath: outputPath)
    let directoryURL = outputURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)

    let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    guard let recorder = try? AVAudioRecorder(url: outputURL, settings: settings) else {
        throw DesktopListenError.recorderUnavailable
    }
    recorder.prepareToRecord()
    guard recorder.record() else {
        throw DesktopListenError.recordStartFailed
    }

    let stopSemaphore = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + duration) {
        recorder.stop()
        stopSemaphore.signal()
    }
    stopSemaphore.wait()
    print(outputURL.path)
}

do {
    try main()
} catch {
    fputs("\((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)\n", stderr)
    exit(1)
}
