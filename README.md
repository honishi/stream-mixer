# stream-mixer

<img src="./extension/icons/icon-128.png" alt="icon">

A Chrome extension that balances audio levels across live streams and spreads them across the stereo field.

## Features

- Automatically balances volume and stereo placement across multiple tabs.
- Lets you adjust overall volume, normalization strength, and stereo width.
- Supports per-stream normalization, volume adjustment, mute, and noise reduction.
- Offers Solo for listening to one stream and Focus for lowering the others.
- Lets you drag stereo markers to adjust placement and reorder stream cards.
- Shows audio meters and video thumbnails when available.
- Keeps audio processing running when the popup is closed.
- Supports English and Japanese, with light and dark themes that follow the system.

## Installation

Requires Chrome 116 or later. No build step is needed.

1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the **`extension` folder**.
4. Pin stream-mixer from the extensions menu.

After updating, reload the extension and add your tabs again.

## Usage

1. Play audio in a tab, open stream-mixer, and click **Add this tab**.
2. Repeat for other streams. Volume correction and stereo placement are automatic.
3. Use **Mix settings** for overall adjustments and each card's controls for individual streams.
4. Drag a numbered **STEREO FIELD** marker to adjust its position while temporarily listening to that stream solo.
5. Use **Bypass all** to suspend processing, **Resume mix** to restore it, or **Release all** to return to normal playback.

Global mix settings are saved locally. After restarting Chrome, add your tabs again. Noise reduction is intended for speech and may also reduce music or sound effects.

## Permissions

- `activeTab` (access to tabs where you open the extension)
- `tabCapture` (audio capture from added tabs)
- `tabs` (audible tab discovery, titles, URLs, and tab switching)
- `scripting` (video thumbnails from authorized tabs)
- `storage` (local settings and session notices)
- `offscreen` (audio processing while the popup is closed)

Audio and thumbnails are processed locally, without recording audio or sending media to a server. Each tab must be added manually; protected content and site restrictions may prevent capture.

## Development

Requires Node.js 22 or later. Load the `extension` folder directly in Chrome.

```shell
npm ci

# unit tests
npm test

# static checks
npm run check

# browser tests
npx playwright install chromium
npm run test:browser

# package a release ZIP and checksum in dist/
npm run release:package -- 0.1.0
```

Pushing a version tag such as `0.1.0` or `v0.1.0` runs the release workflow and publishes a GitHub Release after checks pass. Prerelease tags such as `0.1.0-rc.1` are also supported.

Each release includes `stream-mixer-<version>-<commit>.zip` and its `.zip.sha256` checksum, for example `stream-mixer-0.9.0-85f7cf9.zip`. The version omits an optional leading `v` and retains any prerelease suffix; the commit is the first seven characters of the checked-out commit hash. The ZIP contains the extension files with `manifest.json` at its root; extract it and load the extracted folder in Chrome.

Bundled RNNoise assets can be regenerated with `npm run vendor:nr`. See [third-party notices](extension/vendor/rnnoise/THIRD_PARTY_NOTICES.md) for sources and licenses.
