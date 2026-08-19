import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function installGlobalStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
  document.head.append(style);
  return style;
}
