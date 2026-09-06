import SwiftUI
import UIKit

/// Uses directional UIKit recognition so a vertical drag can still scroll the quote page.
struct CandleGestureSurface: UIViewRepresentable {
    let viewport: CandleViewport
    let identifier: String
    let onChange: (CandleViewport) -> Void
    let onSelect: (Double) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isMultipleTouchEnabled = true
        view.isAccessibilityElement = true
        view.accessibilityIdentifier = identifier
        view.accessibilityLabel = identifier.hasSuffix("volume") ? "成交量手势区域" : "K线手势区域"
        view.accessibilityHint = "双指缩放，单指左右拖动，轻点查看对应价格。"

        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        view.addGestureRecognizer(pan)
        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinch(_:)))
        pinch.delegate = context.coordinator
        view.addGestureRecognizer(pinch)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        tap.require(toFail: pan)
        tap.require(toFail: pinch)
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.parent = self
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: CandleGestureSurface
        private var panStart: CandleViewport?
        private var pinchStart: CandleViewport?
        private var pinchAnchor = 0.5

        init(_ parent: CandleGestureSurface) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return pinchStart == nil && abs(velocity.x) > abs(velocity.y)
        }

        func gestureRecognizer(_ gesture: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            guard gesture.view === other.view else { return false }
            // Adding a second finger can transition our one-finger pan into a pinch.
            // This permission never extends to the surrounding page's scroll recognizer.
            return (gesture is UIPanGestureRecognizer && other is UIPinchGestureRecognizer)
                || (gesture is UIPinchGestureRecognizer && other is UIPanGestureRecognizer)
        }

        func gestureRecognizer(_ gesture: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            // The ancestor waits for our directional decision. A vertical pan fails above,
            // releasing the page; a horizontal pan belongs to the chart alone.
            guard gesture is UIPanGestureRecognizer,
                  let scroll = other.view as? UIScrollView,
                  other === scroll.panGestureRecognizer,
                  let view = gesture.view else { return false }
            return view.isDescendant(of: scroll)
        }

        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            guard let view = gesture.view, view.bounds.width > 0 else { return }
            switch gesture.state {
            case .began:
                panStart = parent.viewport
                movePan(gesture, in: view)
            case .changed:
                movePan(gesture, in: view)
            case .ended:
                movePan(gesture, in: view)
                panStart = nil
            case .cancelled, .failed:
                panStart = nil
            default: break
            }
        }

        private func movePan(_ gesture: UIPanGestureRecognizer, in view: UIView) {
            guard let start = panStart, pinchStart == nil else { return }
            parent.onChange(start.panned(translation: Double(gesture.translation(in: view).x),
                                         plotWidth: Double(view.bounds.width)))
        }

        @objc func pinch(_ gesture: UIPinchGestureRecognizer) {
            guard let view = gesture.view, view.bounds.width > 0 else { return }
            switch gesture.state {
            case .began:
                panStart = nil
                pinchStart = parent.viewport
                pinchAnchor = min(1, max(0, Double(gesture.location(in: view).x / view.bounds.width)))
                movePinch(gesture, in: view)
            case .changed:
                movePinch(gesture, in: view)
            case .ended:
                movePinch(gesture, in: view)
                pinchStart = nil
            case .cancelled, .failed:
                pinchStart = nil
            default: break
            }
        }

        private func movePinch(_ gesture: UIPinchGestureRecognizer, in view: UIView) {
            guard let start = pinchStart else { return }
            let zoomed = start.zoomed(scale: Double(gesture.scale), anchor: pinchAnchor)
            let translation = Double(gesture.location(in: view).x) - pinchAnchor * Double(view.bounds.width)
            parent.onChange(zoomed.panned(translation: translation, plotWidth: Double(view.bounds.width)))
        }

        @objc func tap(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended, let view = gesture.view, view.bounds.width > 0 else { return }
            parent.onSelect(min(1, max(0, Double(gesture.location(in: view).x / view.bounds.width))))
        }
    }
}
