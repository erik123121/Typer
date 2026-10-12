# Typer

A Firefox extension that types text into any field the way a person would. It has natural rhythm, makes typos, catches most of them straight away, and leaves some in. It then goes back after a few paragraphs to reread and fix them.

## How it types

**Timing** (US QWERTY)
- Speed is set as net WPM. Pauses and corrections count toward it, so 55 wpm finishes in the time a 55 wpm typist would take.
- The gap between keystrokes comes from a log-normal distribution, not a fixed delay. Each gap is shaped by the previous key:
  - Common letter pairs (`th`, `er`, `in`) are fast.
  - Pairs typed with the same finger are slow.
  - Pairs that switch hands are faster than pairs on one hand.
  - Shifted keys, digits and symbols take longer.
- Short pauses come after commas, longer ones after sentences, longer still at new paragraphs. There are occasional thinking pauses, and long words get a short hesitation first.
- Speed also varies per word and drifts slowly over the run. The first few words are slightly slower while it warms up.
- Every keystroke sends `keydown`/`keypress`/`keyup` with real `key`/`code` values. Capitals add Shift events, and how long each key is held varies.

**Typos**
- Types of mistake: hitting a neighbouring QWERTY key, swapped letters (`teh`), skipped letters, extra letters, doubled letters, and Shift held too long (`THe`).
- **Fixed right away.** Most typos are noticed 0–3 letters later. There's a short reaction pause, a burst of backspaces (sometimes one too many), then the rest of the word is retyped.
- **Left in for later.** Some typos stay in. After a random 1–4 paragraphs it stops, takes time to "reread" (longer for more text), and goes back to the typos one by one. It fixes most of them and skips some, then returns to the end and carries on. Each fix uses one of three methods:
  - click just after the typo, backspace it and retype;
  - click at the end of the word and backspace to the error;
  - double-click the word and retype it.
- **Final pass.** When everything is typed, one more pass over the whole text catches about half of what's still wrong. The remaining few typos stay in.

Every number above can be changed in the popup. With the defaults, about 6% of words get a typo. Around 40% of those are left for a review pass, and roughly 1 in 6 of those survives to the end.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox` and choose **Load Temporary Add-on…**. Pick `manifest.json`.
   - Alternatively, run `npm install` and then `npm start`. This launches a clean Firefox with the extension loaded and the playground page open.
2. If Firefox asks, allow access to websites. The popup also shows an **Allow** button if access is missing.
3. Tabs that were already open need a reload before the extension can type in them.

## Use

- Open the popup and paste your text. The popup estimates how long the run will take and how many typos will be left in.
- Press **Start**, then click into the field before the 3-second countdown ends.
- You can also click into a field and press **Alt+Shift+Y**, which starts immediately using the saved text.
- **Alt+Shift+P** pauses and resumes. **Esc** or **Alt+Shift+X** stops.
- Typing pauses by itself if you press a key, click inside the field, or the field loses focus. When you resume, the caret goes back where it was.
- Shortcuts can be changed at `about:addons` → ⚙ → *Manage Extension Shortcuts*.

## Supported fields

| Field | Notes |
|---|---|
| `<textarea>`, `<input type=text/search/url/tel/password>` | Full support. Caret moves to exact positions. |
| `<input type=email/number>` | Types and fixes typos immediately. Nothing is left in, because the browser doesn't allow moving the caret in these fields. |
| `contenteditable` (including in iframes and shadow DOM) | Full support. The caret is moved character by character, like arrow keys. |

Canvas-based editors that draw text themselves, such as Google Docs, are not supported.

Text is inserted with `execCommand('insertText')`. Editors receive normal `beforeinput`/`input` events and undo history still works. Key events dispatched by an extension are marked `isTrusted: false`, and a page can check for that.

If you edit the field yourself while typing is paused, the extension loses track of where its text is. Stop the run instead of resuming.

Firefox throttles timers in background tabs, so keep the tab in front while it types.

## Layout

```
manifest.json         MV3 manifest (Firefox 128+)
src/engine.js         pure planner: text + settings → timed list of actions
src/content.js        applies the plan to the focused field, on-page overlay
src/background.js     keyboard shortcuts
src/popup/            text box, settings, estimate
test/engine.test.js   engine tests (node --test)
test/playground.html  manual test page with every field type
```

## Develop

```
npm test        # engine tests
npm run lint    # web-ext lint
npm run build   # zip into web-ext-artifacts/
```
