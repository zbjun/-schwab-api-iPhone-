import ExpoModulesCore
import AVKit

struct PipCandle: Record {
  @Field var time: Double = 0
  @Field var open: Double = 0
  @Field var high: Double = 0
  @Field var low: Double = 0
  @Field var close: Double = 0
}

struct PipLine: Record {
  @Field var label: String = ""
  @Field var price: Double = 0
  @Field var color: String = "#FFFFFF"
}

struct PipConfig: Record {
  @Field var origin: String = ""
  @Field var deviceKey: String = ""
  @Field var symbol: String = ""
  @Field var title: String = ""
  @Field var range: String = ""
  @Field var rangeLabel: String = ""
  @Field var barSeconds: Double? = nil
  @Field var decimals: Int = 2
  @Field var up: String = "#FF4B3E"
  @Field var down: String = "#26B463"
  @Field var candles: [PipCandle] = []
  @Field var lines: [PipLine] = []
}

/** The floating chart. It only ever reads market data; no order, cancel or setting passes through here. */
public class ThsChartPipModule: Module {
  private var session: PipSession?

  public func definition() -> ModuleDefinition {
    Name("ThsChartPip")

    Events("onPipState")

    Function("isSupported") { () -> Bool in
      return AVPictureInPictureController.isPictureInPictureSupported()
    }

    // `runOnQueue(.main)` puts each of these on the main queue, which the compiler cannot see for itself.
    AsyncFunction("prepare") { (config: PipConfig) -> Void in
      MainActor.assumeIsolated {
        self.session?.close()
        self.session = PipSession(config: config) { [weak self] state, message in
          self?.sendEvent("onPipState", ["state": state, "message": message])
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("update") { (candles: [PipCandle], lines: [PipLine]) -> Void in
      MainActor.assumeIsolated {
        self.session?.update(candles: candles, lines: lines)
      }
    }.runOnQueue(.main)

    AsyncFunction("start") { () -> Void in
      MainActor.assumeIsolated {
        self.session?.start()
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") { () -> Void in
      MainActor.assumeIsolated {
        self.session?.stop()
      }
    }.runOnQueue(.main)

    AsyncFunction("release") { () -> Void in
      MainActor.assumeIsolated {
        self.session?.close()
        self.session = nil
      }
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async {
        self.session?.close()
        self.session = nil
      }
    }
  }
}
