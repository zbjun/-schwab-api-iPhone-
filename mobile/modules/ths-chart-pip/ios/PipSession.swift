import AVFoundation
import AVKit
import CoreMedia
import CoreVideo
import UIKit

private struct Bar: Sendable {
  let time: Double
  let open: Double
  let high: Double
  let low: Double
  let close: Double
}

private let frameWidth = 960
private let frameHeight = 540
private let keptBars = 200
private let shownBars = 70
// Seconds. No good reply for this long, or a quote that stopped moving for this long, means the price may be old.
private let unansweredAfter = 5.0
private let stalledAfter = 30.0
private let linesOldAfter = 60.0

/** A clock that keeps running while the phone sleeps, and that changing the time cannot move. */
private func monotonicSeconds() -> Double {
  Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
}

private struct LiveReply: Sendable {
  let bars: [Bar]
  let lastPrice: Double
  let changeRate: Double?
  let quoteTime: Double
}

/** The device key must only ever reach the gateway it was issued for, as in the JavaScript client. */
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

/**
 * One floating chart. Picture in Picture only plays video, so the chart is drawn into frames for a sample buffer layer.
 * While it floats the JavaScript side may be paused, so this keeps itself current through the gateway's read-only
 * `live` call. Everything here runs on the main queue except the network reply, which hops back to it.
 */
@MainActor
final class PipSession: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
  private let config: PipConfig
  private let report: (String, String?) -> Void
  private let host: UIView
  private let displayLayer: AVSampleBufferDisplayLayer
  private let requests: URLSession
  private let endpoint: URL?
  private let clockFormat = DateFormatter()
  private var controller: AVPictureInPictureController?
  private var bars: [Bar] = []
  private var lines: [PipLine] = []
  private var lastPrice: Double?
  private var changeRate: Double?
  private var quoteTime: Double?
  private var repliedAt = monotonicSeconds()
  private var movedAt = monotonicSeconds()
  private var linesAt = monotonicSeconds()
  private var keyRefused = false
  private var gapped = false
  private var floating = false
  private var polling = false
  private var timer: Timer?
  private var closed = false

  init(config: PipConfig, report: @escaping (String, String?) -> Void) {
    self.config = config
    self.report = report
    host = UIView(frame: CGRect(x: 0, y: 0, width: 160, height: 90))
    displayLayer = AVSampleBufferDisplayLayer()
    endpoint = PipSession.gatewayEndpoint(origin: config.origin, deviceKey: config.deviceKey)
    let connection = URLSessionConfiguration.ephemeral
    // The whole request, as in the JavaScript client: a reply trickling in must not hold off the warning.
    connection.timeoutIntervalForResource = 5
    requests = URLSession(configuration: connection, delegate: RefuseRedirects(), delegateQueue: nil)
    super.init()
    clockFormat.dateFormat = "HH:mm:ss"
    bars = PipSession.bars(from: config.candles)
    lines = config.lines
    lastPrice = bars.last?.close

    // The system only lets a video keep running from an active playback session. Mixing leaves other audio playing.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try? AVAudioSession.sharedInstance().setActive(true)

    displayLayer.frame = host.bounds
    displayLayer.videoGravity = .resizeAspect
    host.layer.addSublayer(displayLayer)
    host.isUserInteractionEnabled = false
    attachHost()

    // A running clock is what makes the layer count as playing.
    var timebase: CMTimebase?
    let clock = CMClockGetHostTimeClock()
    if CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: clock, timebaseOut: &timebase) == noErr, let timebase {
      CMTimebaseSetTime(timebase, time: CMClockGetTime(clock))
      CMTimebaseSetRate(timebase, rate: 1)
      displayLayer.controlTimebase = timebase
    }

    let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: displayLayer, playbackDelegate: self)
    let controller = AVPictureInPictureController(contentSource: source)
    controller.delegate = self
    controller.canStartPictureInPictureAutomaticallyFromInline = true
    controller.requiresLinearPlayback = true
    self.controller = controller
    render()
    controller.invalidatePlaybackState()
  }

  /** The same rules as the JavaScript client's, so a bad value cannot send the key anywhere else. */
  private static func gatewayEndpoint(origin: String, deviceKey: String) -> URL? {
    guard deviceKey.range(of: "^[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil,
          let parts = URLComponents(string: origin), parts.scheme == "https", parts.host?.isEmpty == false,
          parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty else { return nil }
    return URL(string: origin + "/rpc")
  }

  private func keyWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  /** Behind the app's own views: never seen, but in the window as the system requires. */
  private func attachHost() {
    if host.superview == nil { keyWindow()?.insertSubview(host, at: 0) }
  }

  // MARK: Commands

  func update(candles: [PipCandle], lines: [PipLine]) {
    guard !closed else { return }
    self.lines = lines
    linesAt = monotonicSeconds()
    // While it floats this keeps itself current, and the app's copy may be old: taking it would show an old price as the current one.
    if !floating {
      let incoming = PipSession.bars(from: candles)
      if !incoming.isEmpty {
        bars = incoming
        lastPrice = incoming.last?.close
        gapped = false
      }
    }
    render()
  }

  func start() {
    guard let controller, !closed else { return }
    attachHost()
    guard controller.isPictureInPicturePossible else {
      report("failed", "系统现在不允许打开小窗")
      return
    }
    controller.startPictureInPicture()
  }

  func stop() {
    controller?.stopPictureInPicture()
  }

  func close() {
    guard !closed else { return }
    closed = true
    stopPolling()
    controller?.stopPictureInPicture()
    controller = nil
    requests.invalidateAndCancel()
    displayLayer.flushAndRemoveImage()
    host.removeFromSuperview()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  // MARK: Keeping current while floating

  private func startPolling() {
    guard timer == nil, !closed else { return }
    tick()
    // Holds this session until `stopPolling`, which `close` always reaches.
    let timer = Timer(timeInterval: 1, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  private func stopPolling() {
    timer?.invalidate()
    timer = nil
  }

  @objc private func tick() {
    // The device key stays out of use while the phone is locked, where the app itself could not read it.
    if UIApplication.shared.isProtectedDataAvailable { poll() }
    // Also for the countdown, whether or not a new price arrived.
    render()
  }

  private func poll() {
    let payload: [String: Any] = ["method": "live", "args": [config.symbol, config.range]]
    guard !polling, let endpoint, let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
    polling = true
    var request = URLRequest(url: endpoint, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(config.deviceKey)", forHTTPHeaderField: "Authorization")
    let symbol = config.symbol
    requests.dataTask(with: request) { [weak self] data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode
      let result = status == 200 ? data.flatMap { PipSession.decodeLive($0, symbol: symbol) } : nil
      let refused = status == 401 || status == 403
      DispatchQueue.main.async { self?.finishPoll(result, refused: refused) }
    }.resume()
  }

  private func finishPoll(_ result: LiveReply?, refused: Bool) {
    polling = false
    guard !closed else { return }
    if refused {
      // Asking again cannot help, and this must not read as a network problem.
      keyRefused = true
      stopPolling()
      render()
      return
    }
    guard let result else { return }
    let now = monotonicSeconds()
    repliedAt = now
    if result.quoteTime != quoteTime {
      quoteTime = result.quoteTime
      movedAt = now
    }
    merge(result.bars)
    lastPrice = result.lastPrice
    if let rate = result.changeRate { changeRate = rate }
    render()
  }

  /** Same time replaces, newer appends, older is ignored, as the chart in the app does. */
  private func merge(_ incoming: [Bar]) {
    let sorted = incoming.sorted { $0.time < $1.time }
    // Two new candles cannot fill what was missed, and drawn side by side the hole would not show.
    if let period = config.barSeconds, let last = bars.last, let first = sorted.first, first.time - last.time > period * 1000 {
      gapped = true
    }
    for bar in sorted {
      if let last = bars.last, bar.time < last.time {
        if let index = bars.lastIndex(where: { $0.time == bar.time }) { bars[index] = bar }
      } else if let last = bars.last, bar.time == last.time {
        bars[bars.count - 1] = bar
      } else {
        bars.append(bar)
      }
    }
    if bars.count > keptBars { bars.removeFirst(bars.count - keptBars) }
  }

  private static func bars(from candles: [PipCandle]) -> [Bar] {
    let rows = candles.map { Bar(time: $0.time, open: $0.open, high: $0.high, low: $0.low, close: $0.close) }
    return rows.filter { valid($0) }.sorted { $0.time < $1.time }
  }

  private nonisolated static func valid(_ bar: Bar) -> Bool {
    [bar.time, bar.open, bar.high, bar.low, bar.close].allSatisfy { $0.isFinite && $0 > 0 }
  }

  /** A reply without a usable price counts as no reply, so it cannot make an old price look confirmed. */
  private nonisolated static func decodeLive(_ data: Data, symbol: String) -> LiveReply? {
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let result = root["result"] as? [String: Any], result["symbol"] as? String == symbol,
          let candles = result["candles"] as? [[String: Any]],
          let ticker = result["ticker"] as? [String: Any], ticker["symbol"] as? String == symbol,
          let lastPrice = (ticker["lastPrice"] as? NSNumber)?.doubleValue, lastPrice.isFinite, lastPrice > 0,
          let quoteTime = (ticker["timestamp"] as? NSNumber)?.doubleValue, quoteTime.isFinite, quoteTime > 0 else { return nil }
    let rows = candles.compactMap { row -> Bar? in
      guard let time = (row["time"] as? NSNumber)?.doubleValue, let open = (row["open"] as? NSNumber)?.doubleValue,
            let high = (row["high"] as? NSNumber)?.doubleValue, let low = (row["low"] as? NSNumber)?.doubleValue,
            let close = (row["close"] as? NSNumber)?.doubleValue else { return nil }
      let bar = Bar(time: time, open: open, high: high, low: low, close: close)
      return valid(bar) ? bar : nil
    }
    return LiveReply(bars: rows, lastPrice: lastPrice, changeRate: (ticker["riseFallRate"] as? NSNumber)?.doubleValue, quoteTime: quoteTime)
  }

  // MARK: Frames

  private func render() {
    guard !closed, let frame = makeFrame() else { return }
    if displayLayer.status == .failed { displayLayer.flush() }
    displayLayer.enqueue(frame)
  }

  private func makeFrame() -> CMSampleBuffer? {
    var pixelBuffer: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary
    guard CVPixelBufferCreate(kCFAllocatorDefault, frameWidth, frameHeight, kCVPixelFormatType_32BGRA, attributes, &pixelBuffer) == kCVReturnSuccess,
          let pixels = pixelBuffer else { return nil }
    CVPixelBufferLockBaseAddress(pixels, [])
    defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
    guard let context = CGContext(
      data: CVPixelBufferGetBaseAddress(pixels), width: frameWidth, height: frameHeight, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return nil }
    // Top-left origin, as UIKit text drawing expects.
    context.translateBy(x: 0, y: CGFloat(frameHeight))
    context.scaleBy(x: 1, y: -1)
    UIGraphicsPushContext(context)
    draw(in: context)
    UIGraphicsPopContext()

    var format: CMVideoFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &format) == noErr,
          let format else { return nil }
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
          let sample else { return nil }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
      let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(first, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return sample
  }

  private func color(_ hex: String) -> UIColor {
    let digits = hex.replacingOccurrences(of: "#", with: "")
    guard digits.count >= 6, let value = UInt32(digits.prefix(6), radix: 16) else { return .white }
    return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
  }

  private func priceText(_ value: Double) -> String {
    String(format: "%.\(min(8, max(0, config.decimals)))f", value)
  }

  private func text(_ string: String, at point: CGPoint, size: CGFloat, color: UIColor, weight: UIFont.Weight = .regular, alignRight: Bool = false) {
    let font = UIFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
    let attributed = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
    attributed.draw(at: alignRight ? CGPoint(x: point.x - attributed.size().width, y: point.y) : point)
  }

  private func textWidth(_ string: String, size: CGFloat, weight: UIFont.Weight = .regular) -> CGFloat {
    let font = UIFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
    return ceil(NSAttributedString(string: string, attributes: [.font: font]).size().width)
  }

  private func countdown() -> String? {
    guard let period = config.barSeconds, period > 0, let last = bars.last else { return nil }
    let remaining = Int(ceil(last.time / 1000 + period - Date().timeIntervalSince1970))
    guard remaining > 0, Double(remaining) <= period else { return nil }
    let hours = remaining / 3600, minutes = (remaining % 3600) / 60, seconds = remaining % 60
    return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, seconds) : String(format: "%02d:%02d", minutes, seconds)
  }

  private func draw(in context: CGContext) {
    let width = CGFloat(frameWidth), height = CGFloat(frameHeight)
    context.setFillColor(UIColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let up = color(config.up), down = color(config.down), muted = UIColor(white: 0.55, alpha: 1)
    let rising = (changeRate ?? 0) >= 0
    let now = monotonicSeconds()
    // Old prices must not pass for current ones on a chart someone may act on.
    let stale = floating && (keyRefused || now - repliedAt > unansweredAfter || now - movedAt > stalledAfter)
    let tint = stale ? muted : changeRate == nil ? UIColor.white : (rising ? up : down)

    // Header.
    text("\(config.title)  \(config.rangeLabel)", at: CGPoint(x: 24, y: 16), size: 30, color: muted)
    if let price = lastPrice {
      text(priceText(price), at: CGPoint(x: 24, y: 54), size: 58, color: tint, weight: .bold)
    }
    if let rate = changeRate {
      text(String(format: "%@%.2f%%", rate >= 0 ? "+" : "", rate * 100), at: CGPoint(x: width - 24, y: 16), size: 36, color: tint, weight: .semibold, alignRight: true)
    }
    // Printed into the frame, so a chart the system has frozen still says how old it is.
    if let time = quoteTime {
      text("行情 \(clockFormat.string(from: Date(timeIntervalSince1970: time / 1000)))", at: CGPoint(x: width - 24, y: 62), size: 26, color: muted, alignRight: true)
    }
    if stale {
      text(keyRefused ? "设备密钥失效，请回到 App" : "连接中断，价格不是最新", at: CGPoint(x: width - 24, y: 96), size: 26, color: UIColor.orange, weight: .semibold, alignRight: true)
    }

    let visible = Array(bars.suffix(shownBars))
    guard !visible.isEmpty else {
      text("正在读取 K 线…", at: CGPoint(x: 24, y: 260), size: 32, color: muted)
      return
    }
    var low = visible.map { $0.low }.min() ?? 0, high = visible.map { $0.high }.max() ?? 1
    if let price = lastPrice { low = min(low, price); high = max(high, price) }
    let padding = max((high - low) * 0.06, high * 0.0002)
    low -= padding
    high += padding
    // The right side is only as wide as its longest text: this window is small, and the rest belongs to the chart.
    let left = countdown()
    var longest = [high, (high + low) / 2, low].map { textWidth(priceText($0), size: 22) }.max() ?? 0
    if let price = lastPrice { longest = max(longest, textWidth(priceText(price), size: 24, weight: .bold)) }
    if let left { longest = max(longest, textWidth(left, size: 24)) }
    let plot = CGRect(x: 16, y: 134, width: width - 16 - (longest + 24), height: height - 134 - 16)
    let y = { (price: Double) -> CGFloat in plot.minY + CGFloat((high - price) / (high - low)) * plot.height }

    // Axis.
    for fraction in [0.0, 0.5, 1.0] {
      let value = high - (high - low) * fraction
      let position = plot.minY + CGFloat(fraction) * plot.height
      context.setStrokeColor(UIColor(white: 0.18, alpha: 1).cgColor)
      context.setLineWidth(1)
      context.setLineDash(phase: 0, lengths: [])
      context.move(to: CGPoint(x: plot.minX, y: position))
      context.addLine(to: CGPoint(x: plot.maxX, y: position))
      context.strokePath()
      text(priceText(value), at: CGPoint(x: width - 12, y: position - (fraction == 0 ? 0 : fraction == 1 ? 26 : 13)), size: 22, color: muted, alignRight: true)
    }

    // Candles.
    let step = plot.width / CGFloat(max(shownBars, visible.count))
    let body = max(2, step * 0.68)
    let offset = plot.maxX - step * CGFloat(visible.count)
    for (index, bar) in visible.enumerated() {
      let center = offset + step * (CGFloat(index) + 0.5)
      let tint = bar.close >= bar.open ? up : down
      context.setStrokeColor(tint.cgColor)
      context.setLineWidth(max(1.5, body * 0.18))
      context.setLineDash(phase: 0, lengths: [])
      context.move(to: CGPoint(x: center, y: y(bar.high)))
      context.addLine(to: CGPoint(x: center, y: y(bar.low)))
      context.strokePath()
      context.setFillColor(tint.cgColor)
      let top = y(max(bar.open, bar.close)), bottom = y(min(bar.open, bar.close))
      context.fill(CGRect(x: center - body / 2, y: top, width: body, height: max(2, bottom - top)))
    }

    // Levels: cost, take-profit, stop-loss. Only the app can refresh them, so old ones say so: a stop may be gone by now.
    let linesAge = now - linesAt
    let linesOld = linesAge > linesOldAfter
    let linesNote = linesOld ? " \(max(1, Int(linesAge / 60)))分钟前" : ""
    for line in lines where line.price >= low && line.price <= high {
      let position = y(line.price), tint = linesOld ? muted : color(line.color)
      context.setStrokeColor(tint.cgColor)
      context.setLineWidth(2)
      context.setLineDash(phase: 0, lengths: [12, 8])
      context.move(to: CGPoint(x: plot.minX, y: position))
      context.addLine(to: CGPoint(x: plot.maxX, y: position))
      context.strokePath()
      text("\(line.label) \(priceText(line.price))\(linesNote)", at: CGPoint(x: plot.minX + 6, y: position - 30), size: 24, color: tint, weight: .semibold)
    }

    if gapped {
      text("K 线有缺口，回到 App 补齐", at: CGPoint(x: plot.minX + 6, y: plot.minY + 4), size: 24, color: UIColor.orange, weight: .semibold)
    }

    // Last price, with the time left in this bar.
    if let price = lastPrice {
      let position = y(price)
      let closing = visible.last.map { price >= $0.open } ?? true
      let tint = stale ? muted : closing ? up : down
      context.setStrokeColor(tint.cgColor)
      context.setLineWidth(1.5)
      context.setLineDash(phase: 0, lengths: [6, 6])
      context.move(to: CGPoint(x: plot.minX, y: position))
      context.addLine(to: CGPoint(x: plot.maxX, y: position))
      context.strokePath()
      context.setLineDash(phase: 0, lengths: [])
      let tagHeight: CGFloat = left == nil ? 36 : 66
      let tag = CGRect(x: plot.maxX + 4, y: min(max(plot.minY, position - tagHeight / 2), plot.maxY - tagHeight), width: width - plot.maxX - 12, height: tagHeight)
      context.setFillColor(tint.cgColor)
      context.fill(tag)
      text(priceText(price), at: CGPoint(x: tag.maxX - 6, y: tag.minY + 4), size: 24, color: .white, weight: .bold, alignRight: true)
      if let left {
        text(left, at: CGPoint(x: tag.maxX - 6, y: tag.minY + 34), size: 24, color: .white, alignRight: true)
      }
    }
  }

  // MARK: Picture in Picture

  private func pictureStarted() {
    guard !closed else { return }
    floating = true
    keyRefused = false
    let now = monotonicSeconds()
    repliedAt = now
    movedAt = now
    report("active", nil)
    startPolling()
  }

  private func pictureStopped() {
    floating = false
    stopPolling()
    guard !closed else { return }
    report("inactive", nil)
  }

  private func pictureFailed(_ message: String) {
    guard !closed else { return }
    report("failed", message)
  }

  // AVKit does not promise a queue for these, so they answer with a constant or hop to the main queue.
  nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    DispatchQueue.main.async { self.pictureStarted() }
  }

  nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    DispatchQueue.main.async { self.pictureStopped() }
  }

  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
    let message = error.localizedDescription
    DispatchQueue.main.async { self.pictureFailed(message) }
  }

  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
    completionHandler(true)
  }

  // A live stream with nothing to pause or seek: the system hides those controls.
  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {}

  nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
    CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  nonisolated func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
    false
  }

  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
    completionHandler()
  }
}
