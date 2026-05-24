/**
 * AudioSessionPlugin.m
 *
 * Capacitor Objective-C bridge macro for AudioSessionPlugin.
 * Must live alongside AudioSessionPlugin.swift in ios/App/App/Plugins/
 *
 * CAP_PLUGIN registers the class name "AudioSessionPlugin" under the JS key
 * "AudioSession" so the JS bridge can call:
 *   Capacitor.Plugins.AudioSession.configure()
 *   Capacitor.Plugins.AudioSession.setSpeaker({ enabled: true })
 *   Capacitor.Plugins.AudioSession.deactivate()
 */
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(AudioSessionPlugin, "AudioSession",
  CAP_PLUGIN_METHOD(configure, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(setSpeaker, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(deactivate, CAPPluginReturnPromise);
)
