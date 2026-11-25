{
  'targets': [
    {
      'target_name': 'veylo-builtin-ai',
      'sources': ['builtin-ai.cpp'],
      'include_dirs': ['.'],
      'defines': ['NAPI_VERSION=8', 'WIN32_LEAN_AND_MEAN', 'NOMINMAX'],
      'win_delay_load_hook': 'true',
      'msvs_settings': {
        'VCCLCompilerTool': {
          'AdditionalOptions': ['/utf-8', '/std:c++17'],
          'ExceptionHandling': 1,
          'RuntimeLibrary': 0
        },
        'VCLinkerTool': { 'GenerateDebugInformation': 'false' }
      }
    }
  ]
}
