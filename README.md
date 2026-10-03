# Proof

Single-author essay drafting with an adversarial editor. Installable on iPhone and Mac, works offline, syncs to a private GitHub repo. No build step, no backend.

## Deploy

1. Put this folder in a GitHub repo and turn on Pages (Settings, Pages, deploy from branch). Netlify drop also works. The app repo holds no secrets and can be public.
2. Create a second, private repo for the writing, for example `essays`.
3. Create a fine-grained GitHub token limited to that one repo, with Contents set to read and write.
4. iPhone: open the Pages URL in Safari, Share, Add to Home Screen. Mac: open it in Safari and choose File, Add to Dock, or use Chrome's install button.
5. In Settings, paste the Anthropic API key, `owner/essays`, and the token.

Keys live in this device's IndexedDB and are never sent anywhere except Anthropic and GitHub.

## Use

- Write in the editor. The strip under the title shows words, passive voice, repeated openers, long paragraphs, and flagged vocabulary. Tap it for the list and jump to any item.
- Review tab: pick a pass, set a scope (selection, section at cursor, whole piece), optionally add an instruction, run.
  - Outline and Draft section return text you insert.
  - Critique and Audit return notes. They change nothing.
  - Revise returns edits shown as strikes and insertions. Nothing touches your text until you accept it.
- Every pass saves a snapshot first. History lists snapshots, compares, and restores.
- Checkpoint saves a named snapshot and syncs.
- Sync pulls on open and pushes dirty pieces. If both sides changed a piece, you pick a side per difference.

Mac shortcuts: Cmd+S checkpoint, Option+Enter run pass, Option+Down/Up move between edits, Option+A accept, Option+R reject.

## Files

`app.js` UI and state. `store.js` IndexedDB. `sync.js` GitHub. `passes.js` prompts and API call. `lint.js` local checks. `diff.js` word and line diffs. `md.js` frontmatter and HTML export. `rules.js` default voice and rules. `sw.js` offline cache.

## Notes

- Model defaults to `claude-sonnet-5-5` at effort `low`. Change either in Settings.
- Snapshots stay on the device. Git history in the essays repo keeps pushed versions.
- iOS can clear web storage for apps unused for weeks. Sync or save a backup from Settings.
- After deploying an update, close and reopen the app twice to load the new files.
