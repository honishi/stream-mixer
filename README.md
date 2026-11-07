# Stream Mixer

<img src="./extension/icons/icon-128.png" alt="Stream Mixer icon">

A Chrome extension that balances live-stream audio levels and stereo placement across tabs.

## Features

- Automatic volume balancing and stereo placement.
- Global volume, normalization strength, and stereo width controls.
- Per-stream normalization, volume, mute, and noise reduction.
- Solo to hear one stream; Focus to keep selected streams at normal levels and lower others by 18 dB.
- Draggable stereo markers and reorderable stream cards, with audio meters and available video thumbnails.
- English and Japanese, with system-matched light and dark themes.

## Installation

Requires Chrome 116+. No build step.

1. Download or clone this repository, or extract a release ZIP.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select **`extension/`**, or the extracted release folder containing `manifest.json`.
4. Pin **Stream Mixer** in the extensions menu.

After updates, reload the extension and re-add your tabs.

## Usage

1. Play audio in an unmuted HTTP(S) tab, open **Stream Mixer**, and click **Add this tab**. Repeat for each stream.
2. Adjust **Mix settings** globally or use each stream's card controls.
3. Drag a numbered **STEREO FIELD** marker to reposition and temporarily focus that stream. Releasing restores previous Solo or Focus selections.
4. **Bypass all** skips processing but keeps capture and per-stream mute active. **Resume mix** restores processing; **Release all** stops capture and restores normal tab playback.

Global settings are saved locally. After restarting Chrome, re-add tabs and reapply per-stream settings. Noise reduction targets speech and may reduce music or sound effects.

Closing the popup stops thumbnail updates; audio processing continues. Release or close a tab to stop its capture.

## Permissions

- `activeTab`: access to tabs where you open the extension.
- `tabCapture`: audio from added tabs.
- `tabs`: titles to identify playing and mixed tabs; URLs to check capture eligibility.
- `scripting`: video thumbnails from authorized tabs.
- `storage`: local settings and session notices.
- `offscreen`: audio processing with the popup closed.

Audio and thumbnails stay on-device; audio is not recorded. Tabs require manual addition, and protected content or site restrictions may prevent capture.

See the [Privacy Policy](PRIVACY.md) for data use, storage, retention, and controls.

## Development

Requires Node.js 22+. Load `extension/` directly in Chrome.

```shell
npm ci

# unit tests
npm test

# static checks
npm run check

# browser tests
npx playwright install chromium
npm run test:browser

# package a release ZIP in dist/
npm run release:package -- 0.1.0
```

Regenerate bundled RNNoise assets with `npm run vendor:nr`. See [third-party notices](extension/vendor/rnnoise/THIRD_PARTY_NOTICES.md) for sources and licenses.

## Releases

Push a tag such as `0.1.0`, `v0.1.0`, or `0.1.0-rc.1` to validate, test, and publish a GitHub Release. Manual workflow runs validate and test without publishing.

Release ZIPs use `stream-mixer-<version>-<commit>.zip`, e.g. `stream-mixer-0.9.0-85f7cf9.zip`. The version drops the leading `v` but keeps prerelease suffixes; the commit is the checked-out hash's first seven characters.

ZIPs contain Git-tracked `extension/` files and the project `LICENSE`, with `manifest.json` at the root. Packaging sets its numeric `version` and full `version_name` from the tag without changing the source manifest. Extract and load as described above.

## Chrome Web Store assets

Promotional images, prompts, and earlier designs are in [stream-mixer-assets](https://github.com/honishi/stream-mixer-assets). Selected tile: `small-promo-tile/selected/small-promo-tile.png` (440×280, 24-bit RGB PNG, no alpha).

Submit to the Chrome Web Store separately from GitHub Releases, with a public URL for the [Privacy Policy](PRIVACY.md).

## License

Original project code is licensed under the [MIT License](LICENSE). Bundled third-party components retain their own licenses; see [third-party notices](extension/vendor/rnnoise/THIRD_PARTY_NOTICES.md).
