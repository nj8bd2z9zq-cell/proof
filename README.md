# Proof

Single-author essay drafting with an adversarial editor. Installable on iPhone and Mac, works offline, syncs to a private GitHub repo. No build step, no backend, no API key needed.

## Deploy

1. Put this folder in a GitHub repo and turn on Pages (Settings, Pages, deploy from branch). Netlify drop also works. The app repo holds no secrets and can be public.
2. Create a second, private repo for the writing, for example `essays`.
3. Create a fine-grained GitHub token limited to that one repo, with Contents set to read and write.
4. iPhone: open the Pages URL in Safari, Share, Add to Home Screen. Mac: open it in Safari and choose File, Add to Dock, or use Chrome's install button.
5. Create an empty Claude Project on claude.ai (Pro plan). In Proof's Settings, paste the Project link, tap Copy Project setup text, and paste that into the Project's instructions. Then enter `owner/essays` and the token.

The GitHub token lives in this device's IndexedDB and goes only to GitHub.

## Use

- Write in the editor. The strip under the title shows words, passive voice, repeated openers, long paragraphs, and flagged vocabulary. Tap it for the list and jump to any item.
- Review tab: pick a pass, set a scope (selection, section at cursor, whole piece), optionally add an instruction, run.
  - Audit runs on the device. It reports hedges, vague attributions, reform appeals, mystical State language, significance inflation, generic conclusions, chatbot phrasing, forbidden words, passive voice, repeated openers, long paragraphs, triads, and em dashes. Phrase lists are editable in Settings.
  - Outline, Draft section, Critique, and Revise use your Claude Project. Copy prompt copies the prompt and opens the Project. Paste it, send it, copy the reply, then press Paste and read.
  - Outline and Draft section return text you insert. Critique returns notes. Revise returns edits shown as strikes and insertions, and nothing touches your text until you accept it.
- Every pass saves a snapshot first. History lists snapshots, compares, and restores.
- Checkpoint saves a named snapshot and syncs.
- Sync pulls on open and pushes dirty pieces. If both sides changed a piece, you pick a side per difference.

Mac shortcuts: Cmd+S checkpoint, Option+Enter run pass, Option+Down/Up move between edits, Option+A accept, Option+R reject.

## Files

`app.js` UI and state. `store.js` IndexedDB. `sync.js` GitHub. `passes.js` prompts and API call. `lint.js` local checks. `diff.js` word and line diffs. `md.js` frontmatter and HTML export. `rules.js` default voice and rules. `sw.js` offline cache.

## Notes

- Optional API mode: switch Mode to API in Settings, add an API key, and passes run inside Proof (billed separately from Pro). Defaults to `claude-sonnet-5-5` at effort `low`.
- Re-copy the Project setup text after you change the voice profile, forbidden list, or limits.
- Snapshots stay on the device. Git history in the essays repo keeps pushed versions.
- iOS can clear web storage for apps unused for weeks. Sync or save a backup from Settings.
- After deploying an update, close and reopen the app twice to load the new files.
