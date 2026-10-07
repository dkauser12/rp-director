/** Reserved standalone blocks are metadata even after Continue appends prose. */
export function stripResultFooter(text: string): string {
  return text.replace(/(?:\r?\n){0,2}^\[RP_DIRECTOR\]\r?\n\{[^\r\n]*\}\r?\n\[\/RP_DIRECTOR\]/gm, '');
}

interface FooterMessage {
  mes: string;
  display_text?: string;
  swipes?: string[];
  extra?: Record<string, unknown>;
  swipe_info?: { extra?: Record<string, unknown> }[];
}

/** Remove only the old reserved format, including unselected swipes and display copies. */
export function stripChatResultFooters(messages: FooterMessage[]): { messages: number; copies: number; changedMessageIds: number[] } {
  let copies = 0;
  const changedMessageIds: number[] = [];
  const strip = (value: string): string => {
    const clean = stripResultFooter(value);
    if (clean !== value) copies += (value.match(/^\[RP_DIRECTOR\]\r?\n\{[^\r\n]*\}\r?\n\[\/RP_DIRECTOR\]/gm) ?? []).length;
    return clean;
  };
  for (const [index, message] of messages.entries()) {
    const before = copies;
    if (typeof message.mes === 'string') message.mes = strip(message.mes);
    if (typeof message.display_text === 'string') message.display_text = strip(message.display_text);
    if (Array.isArray(message.swipes)) message.swipes = message.swipes.map(value => typeof value === 'string' ? strip(value) : value);
    const extras = new Set([message.extra, ...(message.swipe_info ?? []).map(info => info?.extra)]);
    for (const extra of extras) if (extra && typeof extra.display_text === 'string') extra.display_text = strip(extra.display_text);
    if (copies > before) changedMessageIds.push(index);
  }
  return { messages: changedMessageIds.length, copies, changedMessageIds };
}
