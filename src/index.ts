/**
 * RP Director entry point: registration and lifecycle.
 */
import { Host } from './host.ts';
import { Controller } from './controller.ts';
import { mountUi } from './ui.ts';

const host = new Host();
const controller = new Controller(host);

// Host generate_interceptor (manifest.json). Must exist before the first generation.
(globalThis as unknown as Record<string, unknown>).rpDirectorInterceptor = (chat: unknown, contextSize: number, abort: (immediately: boolean) => void, type: string) =>
  controller.interceptor(chat, contextSize, abort, type);

// Debug handle for the host harness; not a public API.
(globalThis as unknown as Record<string, unknown>).rpDirector = { controller, host, version: '0.7.0' };

async function boot(): Promise<void> {
  try {
    host.takeOverAuto();
    await controller.init();
    mountUi(controller);
    host.saveSettings();
    console.log('[RP Director] ready (v0.7.0)');
  } catch (error) {
    console.error('[RP Director] failed to initialise', error);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
