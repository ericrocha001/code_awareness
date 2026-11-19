declare const __WEB_ACTIVATION_BUILD_ID__: string | undefined
declare const __WEB_ACTIVATION_NATIVE_HOST__: string | undefined

export const DEFAULT_WEB_NATIVE_HOST_NAME = 'com.ericrocha.codeawareness.web_activation'

export function getBuiltWebExtensionBuildId(): string {
  return typeof __WEB_ACTIVATION_BUILD_ID__ === 'string' && __WEB_ACTIVATION_BUILD_ID__.trim()
    ? __WEB_ACTIVATION_BUILD_ID__
    : 'dev-unbuilt'
}

export function getConfiguredNativeHostApplication(): string {
  return typeof __WEB_ACTIVATION_NATIVE_HOST__ === 'string' && __WEB_ACTIVATION_NATIVE_HOST__.trim()
    ? __WEB_ACTIVATION_NATIVE_HOST__
    : DEFAULT_WEB_NATIVE_HOST_NAME
}
