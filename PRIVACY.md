# Stream Mixer Privacy Policy

Last updated: November 7, 2026

This policy describes how the Stream Mixer Chrome extension handles data to
balance audio levels, position audio in stereo, and reduce noise across tabs.

## Data we access and use

Stream Mixer processes the following data locally on your device:

- **Tab information:** Open-tab identifiers, titles, URLs, and playback or mute
  status are accessed to identify playing tabs, display the streams in your mix,
  check whether a tab can be added, and manage playback. The extension does not
  read Chrome's stored browsing history or build a persistent browsing history.
- **Tab audio:** Audio is captured only from tabs you explicitly add to the mix.
  It is processed in real time for playback, volume balancing, stereo positioning,
  noise reduction, and audio meters. The extension does not access your microphone
  or save audio recordings.
- **Video thumbnails:** While the popup is open, the extension periodically
  extracts small images from videos in authorized tabs added to the mix. These
  thumbnails help you identify streams. They are held temporarily in memory,
  are not saved as files, and are discarded when the popup closes.
- **Settings and operational state:** The extension saves global volume,
  normalization strength, and stereo width settings locally. Per-stream controls
  and meter readings are held in memory during use. Temporary error notices may
  include a tab identifier, tab title, and error details.

Local processing still involves handling user data. In Chrome Web Store
disclosures, the tab information and media described above correspond to
**Web history** and **Website content**.

## Storage and retention

Global settings remain in Chrome's local extension storage across browser
restarts. They are not synchronized through Chrome Sync. Temporary notices are
kept in memory or Chrome's session storage and are cleared when the browser
session ends; they may also be cleared when tabs are added, released, or closed.
The active mix and per-stream settings are not restored after a browser restart.

Audio buffers and thumbnails exist only temporarily for processing and display.
The extension does not create an archive of audio, images, tab URLs, or browsing
activity.

## Sharing and external services

The extension does not transmit the data described above to the developer or
external servers, and does not sell or share it with third parties. It contains
no advertising, usage analytics, tracking services, or remote crash reporting.
Noise reduction runs locally using code and model assets bundled with the
extension.

Websites you visit and Chrome itself may handle data under their own policies.
This policy covers Stream Mixer's handling of data.

## Your controls

You choose which tabs to add. To stop capturing a tab's audio, release it from
the mixer, select **Release all**, or close that tab. Closing the popup stops
thumbnail updates but allows audio processing to continue. **Bypass all** changes
audio processing without stopping capture.

You can change saved settings in **Mix settings**. Removing the extension from
Chrome stops its operation and removes its local extension storage. Restarting
the browser clears the active mix and temporary session data.

## Limited use

Stream Mixer uses data only to provide its audio mixing features and related
controls and status displays. Its use of information received from Chrome and
Google APIs complies with the Chrome Web Store User Data Policy, including the
[Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Data is not used for advertising, unrelated purposes, creditworthiness
assessments, or lending decisions.

## Changes and contact

Updates to this policy will be reflected in the date above. For privacy questions,
use the developer contact information on Stream Mixer's Chrome Web Store listing.
