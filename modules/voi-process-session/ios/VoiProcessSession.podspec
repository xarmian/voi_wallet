require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'VoiProcessSession'
  s.version = package['version']
  s.summary = 'Process-scoped session identifier for Voi'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'Voi'
  s.homepage = 'https://github.com/xarmian/voi_wallet'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/xarmian/voi_wallet.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
