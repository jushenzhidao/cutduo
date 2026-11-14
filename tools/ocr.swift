// tools/ocr.swift · 用 macOS Vision 逐张读屏幕字（gate.mjs --ocr 用）
//
//   swiftc -O tools/ocr.swift -o ~/.cache/cutduo/bin/ocr
//   ocr frame1.png frame2.png ...
//
// 输出（与 vibe-knowledge 的 ocr.swift 同一线格式，方便互相照抄解析逻辑）：
//   @@ 1
//   [y0.412 h0.038] 三其凌
//   @@ 2
//   ...
// y/h 是 Vision 归一化坐标（0 在底），行号由调用方换算时间。
//
// 为什么要它：屏幕上出现什么字，只有读回来才知道。ffprobe 能告诉你帧数和响度，
// 告诉不了你「6:12 那屏的数字是不是 389」。这是交付前唯一能验证"画面内容"的手段。

import Foundation
import Vision
import AppKit

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
    FileHandle.standardError.write("usage: ocr <image...>\n".data(using: .utf8)!)
    exit(2)
}

for (i, p) in paths.enumerated() {
    guard let img = NSImage(contentsOfFile: p),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("skip \(p)\n".data(using: .utf8)!)
        continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = false          // 数字/专名要原样，别被"纠错"成别的词
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch {
        FileHandle.standardError.write("ocr fail \(p): \(error)\n".data(using: .utf8)!)
        continue
    }
    print("@@ \(i + 1)")
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox
        // 竖向位置取框中心，和上游一致；调用方可据此判断是不是字幕区
        let yc = bb.midY
        print(String(format: "[y%.3f h%.3f] %@", yc, bb.height, top.string))
    }
}
