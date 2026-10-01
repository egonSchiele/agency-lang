// SPIKE: run a JS bundle inside a WKWebView, the engine an iPad app would use,
// and print whatever the page reports. No Node is involved at run time.
//   swift run-webkit.swift bundle.js
import AppKit
import WebKit

final class Reporter: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as? [String: Any] ?? [:]
        let kind = body["kind"] as? String ?? "?"
        let text = body["text"] as? String ?? ""
        if kind == "report" {
            print(text)
            exit(text.hasPrefix("FAILED") ? 1 : 0)
        }
        FileHandle.standardError.write(("[page " + kind + "] " + text + "\n").data(using: .utf8)!)
    }
}

let bundlePath = CommandLine.arguments[1]
let bundle = try! String(contentsOfFile: bundlePath, encoding: .utf8)

let prelude = """
globalThis.__report = (text) => window.webkit.messageHandlers.spike.postMessage({ kind: "report", text: String(text) });
for (const level of ["log", "warn", "error"]) {
  console[level] = (...args) => window.webkit.messageHandlers.spike.postMessage({ kind: level, text: args.map(String).join(" ") });
}
window.addEventListener("error", (e) => globalThis.__report("FAILED: uncaught " + e.message + " at " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => globalThis.__report("FAILED: unhandled rejection " + (e.reason && e.reason.stack ? e.reason.stack : e.reason)));
"""

let config = WKWebViewConfiguration()
let reporter = Reporter()
config.userContentController.add(reporter, name: "spike")
config.userContentController.addUserScript(WKUserScript(source: prelude, injectionTime: .atDocumentStart, forMainFrameOnly: true))
// A user script's own errors reach `window.onerror` with no detail, so catch
// load-time failures here and report them in full.
let guarded = "try {\n" + bundle + "\n} catch (e) { globalThis.__report(\"FAILED: while loading: \" + (e && e.stack ? e.message + \"\\n\" + e.stack : String(e)) + \"\\nnode APIs called: \" + JSON.stringify(globalThis.__nodeStubCalls || {})); }"
config.userContentController.addUserScript(WKUserScript(source: guarded, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

let webView = WKWebView(frame: .zero, configuration: config)
webView.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: URL(string: "https://bmo.invalid/"))

DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    print("FAILED: no report after 30 seconds")
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
