# Code Mode Plus for DeepSeek Harness

An additive local bundle for DSH Web. On a top-level native agent such as **Standard**, ordinary tools remain available. Use `code_batch` when skillful filtering or chaining several tool calls is more useful than making them separately. PTC and delegated agents are not given the hybrid tool. The bundle does not patch the DSH installation or replace an agent preset.

## Install and try

From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
dsh plugin --profile web add "link:$PWD"
```

Keep this directory at the same path: the profile links to it. Check **Plugins > Code Mode Plus** in DSH, reload the existing Web page if needed, and use a **Standard** session. Try a harmless prompt such as:

> Use `code_batch` to read the first 20 lines of README.md and return only the Markdown headings.

The **View code** disclosure starts closed. DSH's ordinary child cards keep the steps and their outcomes visible; completed edits retain their diff where it fits the metadata budget. Only the batch result and any native deferred context enter the model's ordinary tool history, not each full intermediate tool result.

## Program contract

`code_batch` accepts a one-line `description` and a JavaScript async function body as `code`. Use `await` for every call and `return` for a JSON result. `console.log` is available with a small output cap.

```js
const file = await tools.read({ file_path: 'notes.txt' });
await edit(file.path, 'retry: 3', 'retry: 5');
return { changed: file.path, changes: await $`git diff --stat`.text() };
```

- `tools.read`, `grep`, `glob`, `write`, `edit`, and compatible foreground `bash`/`pwsh` use the same argument objects as the native calls, and are bound only if visible to the session. Calls dispatch in submission order, even inside `Promise.all`.
- `edit(path, oldText, newText, options?)` delegates to native `edit`, including its read-before-edit rules. Use `{ replace_all: true }` only if intended.
- The `$` tag is for literal Bash commands, with no template substitutions. `.text()` returns untruncated stdout and `.lines()` does the same split into lines. `` await $`...` `` returns a foreground result object; `.nothrow()` tolerates a normal nonzero exit only. A denial, interruption, or timeout still throws. PowerShell is available only as `tools.pwsh` when supported.
- The guest is a fresh QuickJS/WASM context in DSH's managed Node PTC process. It is not a Node program: it has no Node imports, filesystem, environment or networking APIs. Every effect goes through a visible native tool and the session's registry/policies. Full access remains Full access for a tool that already has it; this bundle is not a replacement for DSH permissions or an externally audited sandbox.
- A batch runs in the foreground and is non-transactional. Do not rerun a failed batch blindly: completed changes are not rolled back. Use native shell/job tools for long or intentionally detached commands. The bundle rejects explicit job starts and attempts to stop its own auto-promoted shell jobs by their recorded call identity.
- Plan Mode, unavailable tools, and changed session permissions fail closed for the batch. Approval for one native step does not grant approval to the batch. Tool arguments, bounded previews and edit metadata can still appear in the DSH session log; do not pass secrets through the batch. For full diagnostic artifacts use native tools; this bundle does not implement its own output spill system.

## Compatibility

Targets DSH `0.2.2-rc.1` (separate native tool executors, batch `tools.execute`). Compared with the earlier 0.2.1 line:

- every parked step dispatches through `tools.execute({ calls: [...] })` and reads the settled batch result, because the registry no longer accepts a single-call object;
- the test composition mounts `tools` plus `tool-executor-native` instead of the removed `tools` `mode` config;
- a promoted job is matched by either the nested or the top-level call id, because a batch dispatch carries no parent token and `exec.schema` is no longer projected.

## Limits and maintenance

The bundle defaults to 24 tool calls, 120 seconds of active time, and a 15-minute wall limit. The active budget pauses only while a matching DSH approval request is outstanding. The wall limit and user cancellation keep applying. The PTC subprocess and in-flight calls can take additional time to clean up. Override these bounds on the `local-code-mode-plus` entry in the profile editor if necessary. There is no retained REPL state, nested task scheduling, or MCP binding in this release.

The bundle uses a separate instance of DSH's managed Node PTC runtime, leaving the runtime for other presets unchanged. If DSH Web was started with Homebrew's `/opt/homebrew/Cellar/node/...` executable, the bundle's worker uses `/opt/homebrew/bin/node` so Homebrew replacing the versioned executable does not break the running Web session. Other installations use the normal DSH launcher choice.

The installer can update DSH without overwriting this directory. That does **not** guarantee API compatibility. Its declared `engines.dsh` range is deliberately limited to the tested release line; change it only after verification. After an update:

```sh
dsh --version
DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh" npm run test:dsh
dsh --profile web --dump-config
```

Set `DSH_INSTALL_DIR` directly if using a non-npm installation. The integration suite uses installed DSH services, a fresh temporary workspace, and no model or account. `--dump-config` checks composition, not live activation. Check **Plugins**, try the read-only example again, and keep the folder and lockfile in your regular backup/version control.

To roll back, switch off **Code Mode Plus** in **Plugins**. To uninstall the bundle from the profile without deleting the source directory:

```sh
dsh plugin --profile web remove @local/dsh-code-mode-plus
```
