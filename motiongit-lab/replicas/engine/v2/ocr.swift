import Foundation
import Vision
import ImageIO
import CoreGraphics

// 从公开参考帧做 OCR 测量：输出文字内容与归一化 bbox（左上原点）。
// 用于 v2 复刻的「文字层独立重建」，不读取模板包内任何受保护实现。
let args = CommandLine.arguments
guard args.count > 1 else { exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(3) }

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["en-US", "zh-Hans"]
req.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { exit(4) }

var out: [[String: Any]] = []
for obs in (req.results ?? []) {
    guard let c = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    let txt = c.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if txt.isEmpty { continue }
    out.append([
        "text": txt,
        "conf": Double(round(Double(c.confidence) * 1000) / 1000),
        "x": Double(round(Double(b.minX) * 10000) / 10000),
        "y": Double(round(Double(1.0 - b.maxY) * 10000) / 10000),
        "w": Double(round(Double(b.width) * 10000) / 10000),
        "h": Double(round(Double(b.height) * 10000) / 10000)
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
