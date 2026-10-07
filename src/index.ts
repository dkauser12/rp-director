/**
 * RP Director entry point: registration and lifecycle.
 */
import { Host } from './host.ts';
import { Controller } from './controller.ts';
import { mountUi } from './ui.ts';
import packageInfo from '../package.json' with { type: 'json' };

const host = new Host();
const controller = new Controller(host);

// Host generate_interceptor (manifest.json). Must exist before the first generation.
(globalThis as unknown as Record<string, unknown>).rpDirectorInterceptor = (chat: unknown, contextSize: number, abort: (immediately: boolean) => void, type: string) =>
  controller.interceptor(chat, contextSize, abort, type);

// Debug handle for the host harness; not a public API.
(globalThis as unknown as Record<string, unknown>).rpDirector = { controller, host, version: packageInfo.version };

async function boot(): Promise<void> {
  try {
    // Unknown macros remain literal (and truthy) in host guards, so install safe
    // empty readers before any fallible or asynchronous initialization.
    host.registerDirectorMacros(() => controller.macroState());
    host.registerDirectorCommands({ pause: value => controller.setPaused(value),
      reroll: () => controller.reroll(true), reassess: () => controller.reassess(true),
      setPack: id => controller.setChatPack(id), setSpeaker: name => controller.setSpeakerByName(name), get: key => controller.getMacro(key) });
    host.takeOverAuto();
    await controller.init();
    mountUi(controller);
    host.saveSettings();
    console.log(`[RP Director] ready (v${packageInfo.version})`);
  } catch (error) {
    console.error('[RP Director] failed to initialise', error);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
