package expo.modules.voiprocesssession

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private val voiProcessSessionId: String = java.util.UUID.randomUUID().toString()

class VoiProcessSessionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VoiProcessSession")
    Constants("id" to voiProcessSessionId)
    Function("getId") { voiProcessSessionId }
  }
}
