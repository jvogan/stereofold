// applespeech — transcribe one audio file with Apple's on-device Speech
// framework, so a Mac that has never installed whisper-cpp can still turn a
// headset push-to-talk recording into text.
//
//   applespeech <audio-file> [--hint "phrase, phrase"] [--locale en-US]
//               [--ffmpeg /opt/homebrew/bin/ffmpeg] [--timeout 30]
//
// stdout: the final transcript, one line.
// stderr: `applespeech: <k>=<v>` diagnostics, including `latency_ms`.
// exit 0 success; 2 bad usage; 3 authorization denied/undetermined;
//      4 no on-device model for the locale; 5 decode failure; 6 recognition
//      failure or timeout.
//
// On-device is required, never requested as a preference: `requiresOnDevice
// Recognition = true` makes Apple fail the request rather than quietly send the
// audio to Apple's servers, which is the property this whole feature rests on.

import Foundation
import Speech
import AVFoundation

let toolName = "applespeech"

func note(_ key: String, _ value: String) {
  FileHandle.standardError.write("\(toolName): \(key)=\(value)\n".data(using: .utf8)!)
}

func fail(_ code: Int32, _ reason: String) -> Never {
  FileHandle.standardError.write("\(toolName): error: \(reason)\n".data(using: .utf8)!)
  exit(code)
}

/// Pump the main run loop until `done` or the deadline. Speech framework
/// callbacks are delivered through the run loop, and a command-line tool has
/// nobody else running one.
func pump(until deadline: Date, done: () -> Bool) {
  while !done() && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
  }
}

// ---------------------------------------------------------------- arguments

var audioPath: String?
var hints: [String] = []
var localeId = "en-US"
var ffmpegPath: String?
var timeoutSeconds = 60.0

var argv = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < argv.count {
  let argument = argv[index]
  switch argument {
  case "--hint", "--hints":
    index += 1
    guard index < argv.count else { fail(2, "--hint needs a value.") }
    hints += argv[index].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  case "--locale":
    index += 1
    guard index < argv.count else { fail(2, "--locale needs a value.") }
    localeId = argv[index]
  case "--ffmpeg":
    index += 1
    guard index < argv.count else { fail(2, "--ffmpeg needs a value.") }
    ffmpegPath = argv[index]
  case "--timeout":
    index += 1
    guard index < argv.count, let value = Double(argv[index]) else { fail(2, "--timeout needs a number of seconds.") }
    timeoutSeconds = value
  case "--help", "-h":
    print("usage: \(toolName) <audio-file> [--hint \"phrase, phrase\"] [--locale en-US] [--ffmpeg PATH] [--timeout SECONDS]")
    exit(0)
  default:
    if argument.hasPrefix("-") { fail(2, "Unknown option \(argument).") }
    if audioPath != nil { fail(2, "Only one audio file at a time.") }
    audioPath = argument
  }
  index += 1
}

guard let inputPath = audioPath else { fail(2, "usage: \(toolName) <audio-file> [--hint \"phrase, phrase\"]") }
let inputURL = URL(fileURLWithPath: inputPath)
guard FileManager.default.fileExists(atPath: inputURL.path) else { fail(2, "No such file: \(inputURL.path)") }

// ------------------------------------------------------------------- decode

/// Whether AVFoundation can open the file itself. Quest Browser records
/// WebM/Opus, which AVFoundation does not read, so that case is decoded with
/// ffmpeg first rather than handed to the recognizer and refused.
func readableByAVFoundation(_ url: URL) -> Bool {
  (try? AVAudioFile(forReading: url)) != nil
}

var temporaryDirectory: URL?
var recognitionURL = inputURL

if !readableByAVFoundation(inputURL) {
  let ffmpeg = ffmpegPath
    ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].first { FileManager.default.isExecutableFile(atPath: $0) }
  guard let ffmpeg else {
    fail(5, "AVFoundation cannot read \(inputURL.lastPathComponent) and no ffmpeg was found to decode it. Pass --ffmpeg PATH.")
  }
  let directory = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("applespeech-\(UUID().uuidString)")
  try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                           attributes: [.posixPermissions: 0o700])
  temporaryDirectory = directory
  let decoded = directory.appendingPathComponent("utterance.wav")
  let process = Process()
  process.executableURL = URL(fileURLWithPath: ffmpeg)
  process.arguments = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                       "-i", inputURL.path, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", decoded.path]
  let errorPipe = Pipe()
  process.standardError = errorPipe
  process.standardOutput = FileHandle.nullDevice
  do { try process.run() } catch { fail(5, "ffmpeg could not be started: \(error.localizedDescription)") }
  process.waitUntilExit()
  let stderrText = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  guard process.terminationStatus == 0, readableByAVFoundation(decoded) else {
    fail(5, "ffmpeg could not decode \(inputURL.lastPathComponent). \(stderrText.prefix(400))")
  }
  note("decoded_with", "ffmpeg")
  recognitionURL = decoded
}

func cleanUp() {
  if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
}

// ------------------------------------------------------------ authorization

/**
 * Never make a held button wait on a dialog.
 *
 * This used to call `requestAuthorization` unconditionally and pump the run
 * loop for up to thirty seconds. The grant belongs to the app that launched
 * the host, so a Mac that granted Terminal and is now running under Claude
 * Code is `notDetermined` again — and then every push-to-talk press sat silent
 * for half a minute before exiting 3 and falling back to whisper. From inside
 * the headset that reads as a hung voice loop, and the dialog it is waiting on
 * is on a screen the wearer is not wearing.
 *
 * So: read the status first and act on it with no wait at all. Only a
 * genuinely undetermined status asks, and that ask is capped at two seconds —
 * long enough for an already-answered grant to come back, short enough that
 * the press falls through to whisper while the dialog stays up for someone to
 * click. The press after that one finds the answer waiting.
 */
var authorization = SFSpeechRecognizer.authorizationStatus()
if authorization == .notDetermined {
  var authorizationAnswered = false
  SFSpeechRecognizer.requestAuthorization { status in
    authorization = status
    authorizationAnswered = true
  }
  pump(until: Date(timeIntervalSinceNow: 2)) { authorizationAnswered }
}

switch authorization {
case .authorized:
  note("authorization", "authorized")
case .denied:
  cleanUp()
  fail(3, "Speech recognition is denied for this process. Grant it under System Settings > Privacy & Security > Speech Recognition.")
case .restricted:
  cleanUp()
  fail(3, "Speech recognition is restricted on this Mac (device management or Screen Time).")
case .notDetermined:
  cleanUp()
  fail(3, "Speech recognition authorization was never answered. macOS shows a dialog for the app running this tool; it must be accepted once.")
@unknown default:
  cleanUp()
  fail(3, "Speech recognition authorization returned an unknown status.")
}

// -------------------------------------------------------------- recognition

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
  cleanUp()
  fail(4, "No speech recognizer exists for locale \(localeId).")
}
guard recognizer.isAvailable else {
  cleanUp()
  fail(4, "The speech recognizer for \(localeId) is not available right now.")
}
note("supports_on_device", recognizer.supportsOnDeviceRecognition ? "yes" : "no")
guard recognizer.supportsOnDeviceRecognition else {
  cleanUp()
  fail(4, "On-device recognition is unsupported for \(localeId) on this Mac. The model may still be downloading; check System Settings > Keyboard > Dictation.")
}

let request = SFSpeechURLRecognitionRequest(url: recognitionURL)
// On-device is a requirement, not a preference: with it false, Apple may send
// the audio to its servers, and this feature promises that no audio leaves the
// Mac.
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
request.taskHint = .search
if #available(macOS 13.0, *) {
  request.addsPunctuation = false
}
if !hints.isEmpty {
  request.contextualStrings = hints
  note("hints", String(hints.count))
}

let started = Date()
var transcript: String?
var recognitionError: Error?
var finished = false

let task = recognizer.recognitionTask(with: request) { result, error in
  if let error {
    recognitionError = error
    finished = true
    return
  }
  guard let result else { return }
  if result.isFinal {
    transcript = result.bestTranscription.formattedString
    finished = true
  }
}

pump(until: Date(timeIntervalSinceNow: timeoutSeconds)) { finished }
let latencyMilliseconds = Int(Date().timeIntervalSince(started) * 1000)

if !finished {
  task.cancel()
  cleanUp()
  note("latency_ms", String(latencyMilliseconds))
  fail(6, "Recognition did not finish within \(Int(timeoutSeconds)) s.")
}

cleanUp()
note("latency_ms", String(latencyMilliseconds))

if let recognitionError {
  let asNSError = recognitionError as NSError
  note("error_domain", asNSError.domain)
  note("error_code", String(asNSError.code))
  // Apple reports "no speech detected" as an error rather than an empty final
  // result. That is a transcript of nothing, not a failure of the tool, so it
  // exits 0 with an empty line — the same shape whisper's silence gives.
  if asNSError.domain == "kAFAssistantErrorDomain" && (asNSError.code == 1110 || asNSError.code == 203) {
    note("result", "no_speech")
    print("")
    exit(0)
  }
  fail(6, "Recognition failed: \(recognitionError.localizedDescription)")
}

print(transcript ?? "")
exit(0)
