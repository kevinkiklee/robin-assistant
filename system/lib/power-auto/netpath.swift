// Prints the current default network path's cost flags as one JSON line.
//
// Built by system/scripts/build-netpath.mjs into dist/lib/power-auto/netpath
// (macOS only). Network.framework's path flags need no Location Services
// permission, unlike the Wi-Fi SSID, which macOS redacts for background
// processes. isExpensive = Personal Hotspot or cellular; isConstrained = Low
// Data Mode, set per network in System Settings.
import Foundation
import Network

let monitor = NWPathMonitor()
let done = DispatchSemaphore(value: 0)
monitor.pathUpdateHandler = { path in
  let satisfied = path.status == .satisfied
  print(
    "{\"satisfied\":\(satisfied),\"expensive\":\(path.isExpensive),\"constrained\":\(path.isConstrained)}"
  )
  done.signal()
}
monitor.start(queue: DispatchQueue(label: "robin.netpath"))
if done.wait(timeout: .now() + 2) == .timedOut {
  exit(1)
}
