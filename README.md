# stream-mixer

A Chrome extension that gently balances audio levels across live streams and spreads them across the stereo field. Audio processing continues when the popup is closed. Streams are treated equally by default; the main test coverage is for 2–6 simultaneous tabs.

## Installation

Requires Chrome 116 or later and uses Manifest V3. Node.js and a build step are not required to use the extension.

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository's **`extension` folder**.
4. Pin stream-mixer using the extensions menu in the toolbar.

After updating the source, reload the extension from the extensions page. Add previously controlled tabs again.

## Display language

The extension supports English and Japanese. It follows Chrome's display language and falls back to English for unsupported languages. Popup controls, descriptions, accessibility labels, the extension description, and guidance for adding tabs are localized. Errors and recovery notices from the background audio processing that handles normalization, panning, and NR are in English. Stream titles and diagnostic details from Chrome or audio libraries are displayed as received.

Reload the extension after an update. Restart Chrome after changing its display language. There is no language selector in the extension.

## Usage

1. Play audio in a stream's tab. Unmute the tab if necessary.
2. Open stream-mixer in that tab and click **Add this tab** in the upper right. The label changes to **Added**.
3. Repeat for other streams. Volume correction and stereo placement are automatic.
4. Open **Mix settings** to adjust overall volume, Normalize strength, and stereo width.
5. Drag a number in **STEREO FIELD** to adjust its placement while temporarily listening to that stream solo. The drop location is treated as a preference, and all streams are repositioned with suitable spacing.
6. Click a card's headphones icon (**Solo**) to hear only that tab. Click it again to restore the full mix.
7. Use the shield and waveform icon (**NR**) to toggle noise reduction for that stream. Select **Low**, **Medium**, or **High** beside it. Try **Low** if speech is being cut off.
8. Click **Bypass all** to temporarily disable processing, then **Resume mix** to restore the previous settings.
9. Use a card's **×** to release that tab, or **Release all** to restore normal playback for all controlled tabs.

Other audible tabs are listed in the popup. Clicking one switches to that tab; open the extension there to add it.

### Reading the popup

The popup is 680 px wide and displays stream cards in two columns.

The first control row groups Solo, Focus, mute, and per-stream volume adjustment. The second row groups NR with its strength selector and Normalize with its correction value. OUTPUT and PAN readings sit below both rows, and release stays at the top right.

Card controls use icons: headphones for Solo, a target for Focus, a shield and waveform for NR, arrows pointing toward a center line for Normalize, a speaker for mute, and × for release. Hover over a button for its description. Enabled controls use the tab's color, while mute uses a red tint. Accessibility labels support English and Japanese. A spinner appears while NR is loading.

Drag a card's title, number, or empty space to reorder it. The left half of a destination card indicates insertion before it; the right half indicates insertion after it. Dropping renumbers both the cards and STEREO FIELD markers from the beginning. Press Esc to cancel. With a card focused, use Left/Right to move one position, Up/Down to move two, or Home/End to move to the first/last position.

The order survives closing the popup, and newly added tabs appear at the end. Reordering preserves pan positions and Solo, Focus, and NR settings, and remains available during bypass. Releasing all tabs or restarting Chrome resets the order to the order in which tabs are next added.

The list heading shows the current state: standby, mixing, solo playback, focus playback, bypassed, or paused.

- **STEREO FIELD / PAN**: Each stream's horizontal position. Numbers correspond to the card list. Markers move to their target positions while the audio follows smoothly. A glowing ring responds to each stream's audio level.
- **OUTPUT**: Left and right RMS meters after NR, normalization, peak limiting, panning, Solo, Focus, mute, and per-stream volume adjustment, but before overall volume. During bypass, meters still reflect mute. White lines show peaks from roughly the last 100 ms. The scale is −60 to 0 dBFS.
- **Normalize (arrows)**: Toggles automatic volume correction for that tab. A lit button means it is enabled. The value beside the button shows current correction: `+3 dB` boosts the signal and `−3 dB` attenuates it. Momentary peak limiting is shown separately beside the OUTPUT label.
- **Silent / paused**: The tab remains controlled and keeps its position. Gain is not increased to amplify silence.

### Video thumbnails

If a controlled tab has an accessible `video` element, a 54 × 30 px snapshot appears behind the number at the top left of its card, without increasing card height. A snapshot is taken when the popup opens and refreshed about every three seconds. When multiple videos exist, playing videos take priority; among videos in the same playback state, the largest displayed area wins. A paused video can still provide a loaded frame.

Videos in same-origin iframes and open Shadow DOM are supported. Cross-origin iframes, closed Shadow DOM, and videos whose pixels cannot be read because of content protection or CORS restrictions are not supported. If a snapshot becomes unavailable, including after navigation revokes access, or the video disappears, the image is hidden and audio processing continues.

Images are JPEGs of at most 240 × 135 px, handled only in memory on the device. They are not saved to files or storage, or sent elsewhere. Closing the popup stops periodic capture; reopening starts it again. Snapshot capture does not change playback state or video settings.

### Volume and panning

Normalize is enabled by default on each card. Enabled tabs use the Normalize strength in **Mix settings**; disabled tabs do not. Turning it off smoothly returns correction to 0 dB with a time constant of about 20 ms. NR, panning, Solo, and peak limiting remain active. The displayed value tracks the actual correction during the transition.

Each tab's setting survives reopening the popup, card reordering, global setting changes, and bypass. Individual Normalize buttons are disabled during bypass. Releasing and re-adding a tab, or restarting Chrome, restores the default enabled state.

Setting Normalize to 0% gradually returns automatic correction to 0 dB while keeping peak limiting active. Setting stereo width to 0% centers every stream. The default width is 100%; with two or more tabs, automatic placement spans the full range from left (−1) to right (+1). At 100%, dragging and the Home/End keys can also request the endpoints. Previously saved width settings are retained, so set width to 100% in **Mix settings** if an older setting limits the range. Playback hardware is not restricted. Mono output does not provide stereo separation.

### Per-stream volume adjustment

If a stream still sounds too loud after Normalize and NR, use the small selector beside its mute button. Choose **Normal**, **−3 dB**, **−6 dB**, **−9 dB**, **−12 dB**, or **−15 dB**. Normal is the default and adds no attenuation. Each stream can have its own setting.

This adjustment is applied after Normalize and NR, so automatic correction does not cancel it. It works with Normalize off as well. Solo and drag previews retain the adjustment; Focus adds its 18 dB attenuation to the other streams' selected adjustments. Mute always takes priority. The displayed Normalize correction remains separate, while OUTPUT meters include the manual adjustment.

The selection survives card reordering and closing the popup. Bypass temporarily suspends it and disables the selector; resuming restores it. Releasing and re-adding a tab or restarting Chrome resets its adjustment to Normal.

### Adjusting positions by dragging

Holding a numbered marker temporarily solos that stream. Dropping restores the previous playback state and rebalances the order and spacing of all streams, giving priority to the drop location. The marker moves directly from the drop location to its new target without first returning to its original position.

Placement combines the requested position with even spacing instead of fixing the stream at an exact coordinate. Requested positions have four times the weight of even spacing, and neighboring streams retain at least 65% of their evenly spaced separation. Positions remain within the configured stereo width, so a crowded layout may shift a stream slightly from its drop location. A single stream can also reach the width limit when an endpoint is requested. Dropping onto an existing stream near an edge moves that stream inward and adjusts the ordering.

- Position preferences survive closing the popup and are reapplied when tabs or stereo width change.
- **Reset positions** clears preferences and restores even placement in the order tabs were added.
- Left/Right keys also adjust placement. Home/End request the left/right endpoints.
- Escape, a canceled drag, or closing the popup ends temporary Solo. Canceling leaves placement unchanged.
- If communication is lost, temporary Solo expires after about three seconds so it cannot remain stuck.
- Dragging is disabled at 0% width, but saved preferences are retained.

### Bypass and release

**Bypass all** retains the controlled tabs but removes NR, normalization, panning, Solo, Focus, per-stream volume adjustment, overall volume, and peak limiting from the signal path. It plays the original stereo audio, so loudness may differ from the processed mix. During bypass, audio and placement controls other than mute are disabled. Meters show the original signal after mute, correction shows `—`, and pan shows `BYPASS`.

**Resume mix** restores the previous settings and positions. Bypass remains active when the popup is closed. **Release all** is a separate action that stops capture entirely.

### Mute

The speaker icon at the top right of a card toggles that tab's output. Tabs start unmuted. While muted, the icon shows a speaker with an ×, uses a red tint, and the card displays **Muted**. Switching uses a short fade; capture, NR, and Normalize keep running. Chrome's own tab mute setting is not changed.

Mute takes priority over Solo, Focus, temporary Solo while dragging, and bypass. Soloing a muted tab makes the whole mix silent; unmuting it plays only that tab. Mute remains available during bypass and survives reopening the popup and reordering cards. Releasing and re-adding a tab resets it to unmuted.

### Solo

Solo selects a single tab to hear. Its button lights up in the tab's color, and the selection persists when the popup closes. Clicking another tab's Solo button changes the selection; clicking the selected button restores the full mix. Normalization, pan, and overall volume settings still apply.

- Temporary Solo while dragging takes priority. Ending or canceling the drag restores the previous Solo or Focus state.
- Bypass plays the original audio of all unmuted tabs and disables Solo buttons. The selection is retained and restored when the mix resumes.
- Closing or releasing the selected tab restores the full mix for the remaining tabs.
- Tabs added during Solo wait silently. Restarting Chrome or releasing all tabs clears the selection.

### Focus

Each card's target icon (**Focus**) independently adds or removes that stream from the selection. Selected streams keep their current levels, while unselected streams are reduced by 18 dB whenever at least one stream is selected. Other streams remain faintly audible, unlike Solo, which silences them. Attenuation is applied after Normalize so automatic correction cannot undo it. Switching uses a short fade and does not change pan positions.

- Select multiple cards to keep them in the foreground together. Click a selected button to remove only that card. With no cards selected, all streams return to their normal levels; selecting every card also leaves all levels unchanged.
- Focus and regular Solo are mutually exclusive: enabling Solo clears all Focus selections, and enabling Focus clears Solo.
- Temporary Solo while dragging a STEREO FIELD marker takes priority, then restores Focus afterward.
- Mute retains priority. Muting a selected tab keeps its Focus selection; unselected streams remain at their reduced levels. Per-stream volume adjustments still apply to both groups.
- Bypass removes Focus attenuation and disables its buttons. The selection is retained and restored when the mix resumes.
- The selection survives reopening the popup and reordering cards. Newly added streams join at the reduced level.
- Closing or releasing a selected tab removes only that selection. Remaining selections stay active. Removing the last selection restores normal levels. Releasing all tabs and restarting Chrome clear every selection.

### NR (noise reduction)

Each tab's NR button enables speech-oriented noise suppression. Enabled buttons use the tab's color. NR starts disabled with **Medium** strength selected. Effectiveness depends on the noise type and level; it may have little effect on faint white noise, for example. Music and sound effects may also be reduced, so use it as needed for speech-focused streams.

Choose a strength beside the NR button for each tab. You can select a strength even while NR is off.

| Strength | Behavior |
| --- | --- |
| Low | Retains 75% of the original audio, prioritizing speech preservation with lighter suppression. |
| Medium | Retains 50% of the original audio. This is the default strength. |
| High | Uses only the NR output, matching the original full-strength behavior. |

Low and Medium mix processed and original audio to retain some speech that the model might mistakenly remove. They also retain more noise. Compare the results for each stream and adjust to taste.

- RNNoise runs locally with separate state for each stereo channel. Audio is not sent to a server.
- Strength survives closing the popup and toggling NR. Bypass disables NR controls and restores the saved settings when the mix resumes.
- Strength transitions smoothly over about 20 ms without rebuilding the model or disconnecting the audio path. Toggling NR uses a short fade. A model loading failure preserves the original path; a processing failure disables NR and keeps playback running.
- Releasing and re-adding a tab, or restarting Chrome, resets NR to off and strength to Medium.
- NR adds latency and CPU load. It is not intended for speaker separation or dereverberation.

### Persistence

- Audio processing continues when the popup closes; video snapshot capture stops.
- Paused or silent tabs remain controlled and retain their pan positions.
- Closing or releasing a tab smoothly repositions the remaining streams.
- Overall volume, Normalize strength, and stereo width are saved locally.
- After restarting Chrome, add the desired tabs again manually.

## Audio processing

```text
Each tab's MediaStream
  → RNNoise (only when NR is enabled, separate channel states)
  → Stereo normalization + linked-channel peak limiting
  → StereoPanner
  → Start/switch fades / Solo, Focus, temporary drag Solo / Mute
  → Left/right level metering
  → Sum all tabs → Overall volume → Output peak limiting → Playback

During bypass:
Each tab's MediaStream → Switch fades / Mute → Left/right metering → Playback
```

Normalization uses gentle RMS-based automatic gain control. Input at or below −50 dBFS is excluded from the reference level, which is smoothed over about 0.7 seconds. The target is −22 dBFS RMS, with correction limited to −18 to +12 dB. The strength setting scales the correction. Gain follows falling targets with a time constant of about 0.35 seconds and rising targets with one of about three seconds.

Normalization applies the same gain to both channels without converting them to mono. StereoPanner changes the channel blend according to pan position. Sample peaks are limited to −4 dBFS per stream and −1 dBFS after summing. This is neither LUFS measurement nor true-peak limiting. There is no speaker separation. Noise suppression runs only for tabs with NR enabled.

Audio processing runs at 48 kHz; the browser resamples inputs with other sample rates. NR processes 480-sample frames, adding 20 ms of latency: 10 ms for frame adaptation and 10 ms inside the model. The original audio mixed in at Low and Medium is also delayed by 960 samples (20 ms) to align it with the processed signal. These figures cover NR only; tab capture and output devices add their own latency.

## Permissions and data

Audio is processed locally with Web Audio. It is not recorded, saved to files, or sent to a server. The extension uses no remotely hosted scripts or site-specific host permissions. A local snapshot function runs only in controlled tabs authorized through `activeTab`.

| Permission | Purpose |
| --- | --- |
| `activeTab` | Authorize access to the tab where the user opens the extension. |
| `tabCapture` | Capture audio from added tabs. |
| `scripting` | Capture video thumbnails from controlled tabs authorized through `activeTab`. |
| `tabs` | Find audible tabs, read titles and URLs, and switch to a selected tab. |
| `storage` | Save global settings locally; retain processing notices for the current session only. |
| `offscreen` | Keep audio processing independent of the popup. |

Chrome requires user interaction to capture a tab; the extension cannot automatically capture every audible tab. Open the extension in each tab you want to add. Capture failures, such as another extension already capturing the tab, are shown in the popup. Protected content and compatibility with individual streaming services require testing on those services.

## Development and testing

Use Node.js 22 or later.

```sh
npm ci
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

- **Unit tests** cover level convergence, gain retention during silence, sudden peaks, stereo ratios, disabling correction, output limiting, pan placement, and settings validation. They also cover worklet control messages and RMS/peak reporting, irregular NR frame boundaries, and NR initialization, retry, timeout, and resource cleanup. The NR lifecycle tests fake only browser APIs and time; the worklet tests run the real DSP.
- **Browser tests** create six audio tabs in an isolated Chromium profile and use real `tabCapture`, offscreen documents, and AudioWorklets. CDP grants permissions through the equivalent of a toolbar action. Tests interact with the actual popup document rendered in a test tab. Audio processing is not mocked; only the final speaker output uses a test device.
- **Persistence** covers 31 seconds of silence across all streams, closing the popup, and stopping the service worker.
- **Release, permissions, and storage** cover tab closure, individual and full release, resource cleanup, rejection of unapproved capture, and settings restoration after a browser restart.
- **Placement and temporary Solo** cover rebalancing around preferences, marker movement after a drop, cancellation, release of temporary Solo when the popup closes, and audio-reactive markers.
- **Bypass** covers original stereo levels, settings and position retention, reopening the popup, and restoring the mix.
- **Solo** covers actual audio switching, persistence after closing the popup, restoration after dragging and bypass, and adding or closing tabs.
- **NR** covers noise attenuation and preservation of a speech-like signal with the real WASM model, independent stereo channels, Solo and bypass interactions, popup reopening, all three strengths, retention of model-suppressed speech, smooth transitions, 960-sample alignment of the bundled WASM output and original audio, six simultaneous NR streams, repeated toggling, and continued playback after loading or processing failures.
- **Localization** covers translation keys and substitution arguments, English and Japanese display and controls, English audio diagnostics, the 680 px width, and two-column cards. Headless Chrome on macOS ignores `--lang`, so locale tests copy the extension, retain only the target catalog, and use Chrome's native fallback. The OS language is not changed.
- **Video thumbnails** cover periodic updates from real video frames, preference for playing videos, same-origin iframes and Shadow DOM, per-tab images, hiding unavailable or unauthorized previews, stopping capture when the popup closes, and restarting it when reopened.
- **Focus** covers preservation of the selected level, 18 dB attenuation of other streams, independent multiple selections, selecting all or none, interactions with Solo, temporary Solo, mute, per-stream volume adjustment, and bypass, persistence across popup reopening and reordering, and adding or releasing tabs.
- **Mute** covers actual silence and recovery, precedence over Solo, temporary Solo, and bypass, use with NR and Normalize, persistence across reordering and popup reopening, and the default state after re-adding a tab.
- **Card reordering** covers dragging and keyboard controls, cancellation, renumbering, audio settings retention, popup reopening, and adding or releasing tabs.
- **Per-tab Normalize** covers the enabled default, smooth removal of boosts or cuts and behavior during silence, peak limiting, global strength, interactions with NR, Solo, reordering, bypass, and popup reopening, and the default after re-adding a tab.
- Popup screenshots are saved to `test-results/`.

Browser scenarios are grouped in `tests/{lifecycle,controls,focus,volume-trim,panning,noise-reduction,popup,previews}.spec.js`, with shared browser setup in `tests/helpers/browser.js`. Run a focused suite with, for example, `npm run test:browser -- tests/controls.spec.js`. Unit tests live in `tests/*.test.js`; use `node --test tests/noise-reduction.test.js` to check NR failure handling without launching Chromium. Keep browser coverage for permissions, capture, and actual WASM behavior; use unit tests for numerical boundaries and deterministic failure paths.

Browser tests use generated audio to verify functionality. Listening quality on real streams, site-specific restrictions, and long-term resource usage still need separate evaluation.

### Publishing GitHub Releases

Pushing a tag such as `v1.2.3` to `honishi/stream-mixer` triggers the **Release** GitHub Actions workflow. It runs unit tests, static checks, and Chromium browser tests, then publishes a GitHub Release if they pass. The release includes a ZIP and SHA-256 checksum, with automatically generated release notes. It uses the standard `GITHUB_TOKEN`; no additional secret is required.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Tag a commit that includes the workflow. Tags such as `v1.2.3-rc.1` create prereleases and are not marked Latest. Each numeric component must be between 0 and 65535, with no extra leading zeros; the components cannot all be zero. Build metadata such as `+build.1` is not supported.

The attached `stream-mixer-v0.1.0.zip` contains the extension with `manifest.json` at its root. Extract it, then select that folder with Chrome's **Load unpacked** button. RNNoise WASM files, licenses, translations, and icons are included. The workflow does not publish to the Chrome Web Store.

Inside the ZIP, `manifest.version` uses the tag's numeric portion and `version_name` uses the full tag without `v`. The repository's manifest and package.json are not modified. A prerelease and final release with the same numeric portion compare as the same version in Chrome.

To inspect a package locally, run this command with Git and `zip` available:

```sh
npm run release:package -- v0.1.0
```

The ZIP and checksum are written to `dist/`. Only Git-tracked files under `extension/` are packaged, so add new files to Git first. Tests also require `unzip`. An existing release with the same name is not overwritten. If publishing fails and leaves a draft, inspect and delete that draft before rerunning the workflow.

### Adding translations

Copy `extension/_locales/en/messages.json` into a directory for the new locale and translate it. Set the `locale` message to the new locale code. Preserve existing keys and `placeholders`, then run `npm test` and the browser tests to check the result. Translations are plain text, not HTML.

The extension uses Chrome's standard [`chrome.i18n`](https://developer.chrome.com/docs/extensions/reference/api/i18n) API. The offscreen document—the hidden page that keeps audio processing running after the popup closes—does not use localization and returns English diagnostics. There is no translation bundle transfer or custom substitution mechanism, and no external translation service or additional permission.

### Bundled RNNoise assets

The RNNoise runtime and WASM files bundled with [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 are pinned under `extension/vendor/rnnoise/`. Nothing is downloaded when the extension runs. The worklet and frame adapter are implemented for this extension's state management, stereo processing, and error recovery.

After `npm ci`, run `npm run vendor:nr` to regenerate the runtime and WASM files. When updating the dependency, review the generator's version and hash checks, bundled licenses, and browser tests. Sources, modifications, and licenses are documented in `extension/vendor/rnnoise/THIRD_PARTY_NOTICES.md`. The manifest's `wasm-unsafe-eval` setting permits execution of the bundled WASM.

## Project structure

| File | Role |
| --- | --- |
| `extension/background.js` | Permissions, tab operations, offscreen startup, settings storage, and serialized operations. |
| `extension/offscreen.js` | Audio graph, per-tab state, and release after failures. |
| `extension/audio/dsp.js` | Browser-independent volume correction and peak limiting. |
| `extension/audio/noise-*.js` | NR node creation and disposal, the worklet, and 480-sample frame adaptation. |
| `extension/vendor/rnnoise/` | RNNoise runtime, WASM files, and licenses. |
| `extension/audio/processors.js` | AudioWorklet processing and metering at roughly 10 Hz. |
| `extension/popup.*` | Display and controls; state is fetched only while the popup is open. |
| `extension/_locales/*/messages.json` | Localized labels, notices, and error messages. |
| `extension/shared/i18n.js` | Chrome-native message lookup and HTML localization. |
| `extension/shared/settings.js` | Default settings, validation, and even pan placement. |
| `extension/shared/noise.js` | The three NR strengths and their default. |
| `extension/video-snapshot.js` | Video selection and thumbnail capture in authorized tabs. |
| `extension/shared/panning.js` | Rebalancing based on position preferences and spacing. |

Design references: [tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen), and [Chrome audio capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture).
