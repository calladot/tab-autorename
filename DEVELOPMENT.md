# Development

## Requirements

- Firefox 140 or newer
- Node.js and npm

## Install dependencies

```bash
npm install
```

## Build and validate

```bash
npm run build
npm run typecheck
npm run webext:lint
```

Run the extension in Firefox with:

```bash
npm run webext:run
```

Create a distributable package with:

```bash
npm run webext:build
```

The build is generated in `dist/`; the packaged extension is written to `artifacts/`.

## Permissions and data

- `storage` keeps settings and rules in the browser.
- `tabs` reads the active tab context for the popup.
- `scripting` supports content-script registration.
- Optional host access is requested at runtime for sites the user chooses.

The extension does not load remote code, collect telemetry, or transmit data to external services. See [the AMO submission checklist](docs/amo-submission.md) for review notes.

## Extension button placement

The action button is placed in the navigation bar (`default_area: "navbar"`). If the icon is hidden or cannot be pinned in Zen or a Firefox fork, an older installation may have retained its previous placement. To move it to the extensions panel:

1. Set `devtools.chrome.enabled` to `true` in `about:config`.
2. Open the Browser Console (`Ctrl+Shift+J`) and run:

   ```js
   CustomizableUI.addWidgetToArea("tab-autorename_calladot_dev-browser-action", CustomizableUI.AREA_ADDONS)
   ```

## Release preparation

See [docs/amo-submission.md](docs/amo-submission.md).