import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const forbiddenPaths = ['plugins', 'host'];
const forbiddenTokens = [
    'onMessageExternal', 'sendExternalMessage', 'EXTENSIONS_WHITE_LIST',
    'groups-external', 'mapForExternalExtension', 'githubGist',
    'sync-cloud', 'sendNativeMessage', 'nativeMessaging', 'resetSyncAlarm',
    'tab-organizer@example.local',
];
const forbiddenPatterns = [
    ['cross-extension runtime sendMessage', /\bbrowser\.runtime\.sendMessage\s*\(\s*(?!\{)[^,)\s][^,)]*,/],
    ['cross-extension runtime connect', /\bbrowser\.runtime\.connect\s*\(\s*(?!\{)[^,)\s][^,)]*(?:,|\))/],
];
const scanRoots = [
    'addon/src', 'addon/webpack.config.mjs', 'addon/scripts/build-zip.js',
    'README.md', 'translate/index.js',
];
const failures = [];

function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) return readdirSync(path)
        .filter(name => name !== '_locales')
        .flatMap(name => visit(resolve(path, name)));
    return [path];
}

for (const path of forbiddenPaths) {
    if (existsSync(resolve(root, path))) failures.push(`forbidden path: ${path}`);
}
for (const scanRoot of scanRoots) {
    const fullPath = resolve(root, scanRoot);
    if (!existsSync(fullPath)) continue;
    for (const file of visit(fullPath)) {
        const text = readFileSync(file, 'utf8');
        for (const token of forbiddenTokens) {
            if (text.includes(token)) failures.push(`${relative(root, file)}: ${token}`);
        }
        for (const [name, pattern] of forbiddenPatterns) {
            if (pattern.test(text)) failures.push(`${relative(root, file)}: ${name}`);
        }
    }
}
if (failures.length) throw new Error(failures.join('\n'));
console.log('Standalone-core checks passed.');
