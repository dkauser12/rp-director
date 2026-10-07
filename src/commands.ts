/** Slash-command registration is injected, so commands are testable without the host. */
import type { HostSlashCommand } from './host.ts';

export interface DirectorCommandContext {
  SlashCommandParser?: { addCommandObject: (command: unknown) => unknown };
  SlashCommand?: { fromProps: (props: HostSlashCommand) => unknown };
}

export interface DirectorCommandActions {
  pause: (paused: boolean) => unknown | Promise<unknown>;
  reroll: () => unknown | Promise<unknown>;
  reassess: () => unknown | Promise<unknown>;
  setPack: (id: string) => unknown | Promise<unknown>;
  setSpeaker: (name: string) => unknown | Promise<unknown>;
  get: (key: string) => string;
}

/** /director [tab] remains owned by the workspace, which knows its mounted tabs. */
export function registerDirectorCommands(context: DirectorCommandContext, actions: DirectorCommandActions): boolean {
  const { SlashCommandParser, SlashCommand } = context;
  if (!SlashCommandParser || !SlashCommand) return false;
  const add = (name: string, helpString: string, callback: (text: string) => unknown | Promise<unknown>, returns = 'Nothing') => {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
      name, helpString, returns, splitUnnamedArgument: false,
      callback: async (_named, unnamed) => callback(typeof unnamed === 'string' ? unnamed.trim() : ''),
    }));
  };
  add('director-pause', 'Pause this chat: /director-pause on|off.', async text => {
    const value = text.toLowerCase();
    if (value !== 'on' && value !== 'off') throw new Error('Use /director-pause on or /director-pause off.');
    await actions.pause(value === 'on'); return '';
  });
  add('director-reroll', 'Draw new dice for the selected Director reply and generate a new swipe.', async () => { await actions.reroll(); return ''; });
  add('director-reassess', 'Ask the judge again for the selected Director reply and generate a new swipe.', async () => { await actions.reassess(); return ''; });
  add('director-pack', 'Set this chat’s genre pack: /director-pack <id|auto>.', async text => {
    if (!text) throw new Error('Use /director-pack <id|auto>.');
    await actions.setPack(text.toLowerCase() === 'auto' ? 'auto' : text); return '';
  });
  add('director-speaker', 'Choose the next speaker: /director-speaker <name|auto|yield>.', async text => {
    if (!text) throw new Error('Use /director-speaker <name|auto|yield>.');
    await actions.setSpeaker(['auto', 'yield'].includes(text.toLowerCase()) ? text.toLowerCase() : text); return '';
  });
  add('director-get', 'Read a Director macro: /director-get <key>, for example meter::Guide::regard.', text => actions.get(text), 'The macro value, or an empty string');
  return true;
}
