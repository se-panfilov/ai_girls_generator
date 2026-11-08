// Runs the real `parseCharacter` of @aigg/rig-runtime from its TypeScript source, in a child Node.js process.
// Why: @aigg/control has no dependency on @aigg/rig-runtime, and the control CI job does not build it. Node.js strips the types of the
// source files. A resolve hook maps the `@rig-runtime/*` alias to the source directory. This file is test code only.
// Usage: node parse-character.mjs <rig.contract.json> <character.json>. Prints one JSON line: { ok, slots } or { ok: false, code }.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const source = new URL('../../../rig-runtime/src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@rig-runtime\/([a-z-]+)$/.exec(specifier);
    return nextResolve(match ? new URL(`${match[1]}.ts`, source).href : specifier, context);
  }
});

const [contractPath, characterPath] = process.argv.slice(2);
const { parseRigContract } = await import(new URL('contract.ts', source).href);
const { parseCharacter } = await import(new URL('character.ts', source).href);
try {
  const contract = parseRigContract(JSON.parse(readFileSync(contractPath, 'utf8')));
  const character = parseCharacter(JSON.parse(readFileSync(characterPath, 'utf8')), contract);
  process.stdout.write(`${JSON.stringify({ ok: true, slots: Object.keys(character.parts).length })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'E_UNEXPECTED', message: String(error?.message ?? error) })}\n`);
}
