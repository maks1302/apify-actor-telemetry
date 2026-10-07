#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const artifactDirectory = join(root, 'artifacts');
await mkdir(artifactDirectory, { recursive: true });
const { stdout } = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactDirectory], { cwd: root });
const [pack] = JSON.parse(stdout);
const documentationFiles = ['README.md', 'llms.txt', 'docs/api.md', 'docs/integration.md',
    'docs/testing-and-upgrades.md', 'docs/agent-guide.md', 'prompts/integrate-actor.md',
    'prompts/migrate-legacy-monitoring.md'];
assert.ok(pack.files.every(({ path }) => path === 'package.json' || path.startsWith('src/')
    || path === 'scripts/smoke.js' || documentationFiles.includes(path)));
assert.ok(pack.files.every(({ path }) => !/storage|credential|\.env|test\//i.test(path)));
for (const path of documentationFiles) assert.ok(pack.files.some((file) => file.path === path), `Missing packaged guide: ${path}`);
const directory = await mkdtemp(join(tmpdir(), 'actor-telemetry-consumer-'));
try {
    const modules = join(directory, 'node_modules');
    const installed = join(modules, 'actor-telemetry-provisional');
    await mkdir(installed, { recursive: true });
    await exec('tar', ['-xzf', join(artifactDirectory, pack.filename), '--strip-components=1', '-C', installed]);
    await mkdir(join(modules, '@sentry'), { recursive: true });
    // Reuse available dependencies without invoking an installer or changing an Actor.
    await symlink(join(root, 'node_modules/@sentry/node'), join(modules, '@sentry/node'), 'dir');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    await writeFile(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
const before = ['uncaughtException','unhandledRejection','beforeExit'].map((name) => process.listeners(name));
const {createActorTelemetry} = await import('actor-telemetry-provisional');
const adapters = await import('actor-telemetry-provisional/apify');
for(const [index,name] of ['uncaughtException','unhandledRejection','beforeExit'].entries()) assert.deepEqual(process.listeners(name), before[index], 'import side effects');
assert.equal(typeof adapters.runActorMain, 'function'); assert.equal(typeof adapters.exitActor, 'function');
let count = 0;
const telemetry = createActorTelemetry({actorName:'artifact-consumer',env:{SENTRY_DSN:'https://synthetic@telemetry.invalid/1',SENTRY_ENVIRONMENT:'test'},transport:()=>({send:async()=>{count++;return {statusCode:200};},flush:async()=>true})});
telemetry.setRawInput({ordinary:true});
assert.equal((await telemetry.captureException(new Error('artifact smoke'))).status,'accepted');
assert.equal((await telemetry.flush()).status,'drained'); await telemetry.dispose(); assert.equal(count,1);
for(const [index,name] of ['uncaughtException','unhandledRejection','beforeExit'].entries()) assert.deepEqual(process.listeners(name), before[index], 'cleanup leaks');
`);
    await exec(process.execPath, ['consumer.mjs'], { cwd: directory, timeout: 5000, env: { ...process.env, SENTRY_DSN: '' } });
    await exec(process.execPath, [join(installed, 'scripts/smoke.js')], { cwd: directory, timeout: 5000 });
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    for (const entry of Object.values(manifest.exports)) { assert.ok((await readFile(join(installed, entry.types), 'utf8')).includes('export')); }
    for (const { path } of pack.files.filter(({ path }) => path.startsWith('src/'))) {
        const source = await readFile(join(installed, path), 'utf8');
        assert.ok(!source.includes('/Users/') && !source.includes('readFileSync') && !source.includes("from 'apify'"));
    }
    // Optional compiler path uses an existing compiler. No dependencies are installed.
    if (process.env.TELEMETRY_TSC_PATH) {
        await writeFile(join(directory, 'consumer.ts'), `import {createActorTelemetry,type EventContext} from 'actor-telemetry-provisional';
import {attachActorLifecycle,runActorMain,exitActor,loadActorInput} from 'actor-telemetry-provisional/apify';
const m = createActorTelemetry({actorName:'types',env:{}});
const context:EventContext={operation:'fetch',errorCategory:'network',request:{id:'one'},failure:{endedRun:true}};
await m.withOperation(context,()=>m.captureException(new Error('failure')));
void attachActorLifecycle; void runActorMain; void exitActor; void loadActorInput;
await m.dispose();`);
        await exec(process.execPath, [process.env.TELEMETRY_TSC_PATH, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: directory, timeout: 10000 });
    }
    console.log(JSON.stringify({ artifact: join(artifactDirectory, pack.filename), files: pack.files.map(({ path }) => path), runtimeConsumer: 'passed', declarationConsumer: process.env.TELEMETRY_TSC_PATH ? 'passed' : 'compiler_not_supplied', dependencies: 'reused_existing; no_install' }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
