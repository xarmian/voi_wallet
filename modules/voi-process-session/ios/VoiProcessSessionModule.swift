import ExpoModulesCore
import Foundation

private let voiProcessSessionId = UUID().uuidString

public class VoiProcessSessionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VoiProcessSession")
    Constants(["id": voiProcessSessionId])
    Function("getId") { voiProcessSessionId }
  }
}
