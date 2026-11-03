Pod::Spec.new do |s|
  s.name           = 'ThsChartPip'
  s.version        = '1.0.0'
  s.summary        = 'Keeps a live chart on screen in Picture in Picture.'
  s.description    = 'Draws a live chart into a sample buffer layer, so it can float over other apps.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = "**/*.{h,m,swift}"
end
